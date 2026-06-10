"""Groww access-token mint via TOTP — example custom auth plugin.

Groww's TOTP flow:
  POST /v1/token/api/access
  Authorization: Bearer <API_KEY>
  Body: {"key_type": "totp", "totp": "<6-digit code>"}
  → response {"token": "...", "expiry": "...ISO8601..."}

The minted token is cached in Redis (Groww access tokens expire daily ~6 AM IST).
A Redis NX-lock prevents thundering-herd minting when multiple workers see a
cache miss simultaneously.

Use this file as a template for any "POST credentials, get bearer, cache, reuse"
auth scheme — most exotic broker/exchange auth flows follow this exact shape.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
import struct
import time
from datetime import UTC, datetime
from typing import Any

import httpx
from redis.asyncio import Redis

from app.python.auth.base import AuthContext, AuthResult

log = logging.getLogger(__name__)

TOKEN_KEY = "groww:token"
TOKEN_LOCK_KEY = "groww:token:lock"
TOKEN_LOCK_TTL = 30
TOKEN_TTL_FALLBACK = 60 * 60 * 18


def _totp(seed_b32: str, t: float | None = None, step: int = 30, digits: int = 6) -> str:
    """RFC 6238 TOTP. Groww uses standard 6-digit / 30s / SHA1."""
    key = base64.b32decode(seed_b32.upper() + "=" * ((-len(seed_b32)) % 8))
    counter = int((t if t is not None else time.time()) // step)
    msg = struct.pack(">Q", counter)
    h = hmac.new(key, msg, hashlib.sha1).digest()
    offset = h[-1] & 0x0F
    code = (struct.unpack(">I", h[offset : offset + 4])[0] & 0x7FFFFFFF) % (10**digits)
    return f"{code:0{digits}d}"


class GrowwTotpMintAuth:
    name = "groww_totp_mint"

    def __init__(
        self,
        *,
        redis: Redis,
        http: httpx.AsyncClient,
        api_key: str,
        totp_seed: str,
        mint_path: str,
        invalidate_on: set[int],
    ) -> None:
        self._redis = redis
        self._http = http
        self._api_key = api_key
        self._totp_seed = totp_seed
        self._mint_path = mint_path
        self._invalidate_on = invalidate_on

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> GrowwTotpMintAuth:
        api_key = os.environ.get(config.get("api_key_env", "GROWW_API_KEY"), "")
        totp_seed = os.environ.get(config.get("totp_seed_env", "GROWW_TOTP_SEED"), "")
        if not api_key:
            raise ValueError("groww_totp_mint: api_key env var not set")
        if not totp_seed:
            raise ValueError("groww_totp_mint: totp_seed env var not set")
        return cls(
            redis=redis,
            http=http,
            api_key=api_key,
            totp_seed=totp_seed,
            mint_path=config.get("mint_path", "/v1/token/api/access"),
            invalidate_on=set(config.get("invalidate_on", [401])),
        )

    async def _get_or_mint(self) -> str:
        cached = await self._redis.get(TOKEN_KEY)
        if cached:
            return cached if isinstance(cached, str) else cached.decode()

        got_lock = await self._redis.set(TOKEN_LOCK_KEY, "1", nx=True, ex=TOKEN_LOCK_TTL)
        if not got_lock:
            for _ in range(20):
                await asyncio.sleep(0.25)
                cached = await self._redis.get(TOKEN_KEY)
                if cached:
                    return cached if isinstance(cached, str) else cached.decode()
            raise RuntimeError("Timed out waiting for peer to mint Groww token")
        try:
            token, ttl = await self._mint()
            await self._redis.set(TOKEN_KEY, token, ex=ttl)
            log.info("Minted new Groww token via TOTP, ttl=%ds", ttl)
            return token
        finally:
            await self._redis.delete(TOKEN_LOCK_KEY)

    async def _mint(self) -> tuple[str, int]:
        body: dict[str, Any] = {"key_type": "totp", "totp": _totp(self._totp_seed)}
        resp = await self._http.post(
            self._mint_path,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=15.0,
        )
        resp.raise_for_status()
        data = resp.json()
        token: str = data["token"]
        ttl = TOKEN_TTL_FALLBACK
        expiry_str = data.get("expiry")
        if expiry_str:
            try:
                exp = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=UTC)
                # 2-minute safety margin so the proxy refreshes before the upstream
                # actually expires the token.
                ttl = max(60, int(exp.timestamp() - time.time()) - 120)
            except Exception:
                log.warning("Could not parse expiry %r; using fallback TTL", expiry_str)
        return token, ttl

    async def apply(self, ctx: AuthContext) -> AuthResult:
        token = await self._get_or_mint()
        return AuthResult(headers={"Authorization": f"Bearer {token}"})

    async def invalidate(self) -> None:
        await self._redis.delete(TOKEN_KEY)

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return status_code in self._invalidate_on
