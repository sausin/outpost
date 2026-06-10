"""Groww access-token mint via API key + secret checksum — example custom auth plugin.

Groww's approval (checksum) flow:
  POST /v1/token/api/access
  Authorization: Bearer <API_KEY>
  Body: {"key_type": "approval", "checksum": "<sha256(secret+ts)>", "timestamp": "<ts>"}
  → response {"token": "...", "expiry": "...ISO8601..."}

Use this when you have a key+secret pair but no TOTP authenticator. The checksum
proves possession of the secret without sending it on the wire.

The minted token is cached in Redis (Groww access tokens expire daily ~6 AM IST).
A Redis NX-lock prevents thundering-herd minting under concurrent cache misses.

Use this file as a template for "POST signed credentials → get bearer → cache"
auth — a very common pattern beyond Groww (e.g., several exchange APIs do the
same checksum-with-timestamp dance).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
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


class GrowwApprovalMintAuth:
    name = "groww_approval_mint"

    def __init__(
        self,
        *,
        redis: Redis,
        http: httpx.AsyncClient,
        api_key: str,
        api_secret: str,
        mint_path: str,
        invalidate_on: set[int],
    ) -> None:
        self._redis = redis
        self._http = http
        self._api_key = api_key
        self._api_secret = api_secret
        self._mint_path = mint_path
        self._invalidate_on = invalidate_on

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> GrowwApprovalMintAuth:
        api_key = os.environ.get(config.get("api_key_env", "GROWW_API_KEY"), "")
        api_secret = os.environ.get(config.get("api_secret_env", "GROWW_API_SECRET"), "")
        if not api_key:
            raise ValueError("groww_approval_mint: api_key env var not set")
        if not api_secret:
            raise ValueError("groww_approval_mint: api_secret env var not set")
        return cls(
            redis=redis,
            http=http,
            api_key=api_key,
            api_secret=api_secret,
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
            log.info("Minted new Groww token via approval (checksum), ttl=%ds", ttl)
            return token
        finally:
            await self._redis.delete(TOKEN_LOCK_KEY)

    async def _mint(self) -> tuple[str, int]:
        ts = str(int(time.time()))
        checksum = hashlib.sha256((self._api_secret + ts).encode()).hexdigest()
        body: dict[str, Any] = {
            "key_type": "approval",
            "checksum": checksum,
            "timestamp": ts,
        }
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
