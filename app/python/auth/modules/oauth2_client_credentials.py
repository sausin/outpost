from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from typing import Any

import httpx
from redis.asyncio import Redis

from app.python.auth.base import AuthContext, AuthResult, _invalidate_on_from_config

log = logging.getLogger(__name__)

_LOCK_TTL = 30
_LOCK_RETRY_COUNT = 20
_LOCK_RETRY_SLEEP = 0.25


class OAuth2ClientCredentialsAuth:
    """OAuth2 client-credentials flow with Redis token cache and distributed lock."""

    name = "oauth2_client_credentials"

    def __init__(
        self,
        redis: Redis,
        http: httpx.AsyncClient,
        client_id: str,
        client_secret: str,
        token_url: str,
        scope: str,
        audience: str,
        redis_key: str,
        redis_lock_key: str,
        header: str,
        prefix: str,
        invalidate_on: set[int],
        ttl_fallback: int,
    ) -> None:
        self._redis = redis
        self._http = http
        self._client_id = client_id
        self._client_secret = client_secret
        self._token_url = token_url
        self._scope = scope
        self._audience = audience
        self._redis_key = redis_key
        self._redis_lock_key = redis_lock_key
        self._header = header
        self._prefix = prefix
        self._invalidate_on = invalidate_on
        self._ttl_fallback = ttl_fallback

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> OAuth2ClientCredentialsAuth:
        cid_env = config["client_id_env"]
        csec_env = config["client_secret_env"]
        client_id = os.environ.get(cid_env)
        if not client_id:
            raise ValueError(
                f"OAuth2ClientCredentialsAuth: env var {cid_env!r} is not set or empty."
            )
        client_secret = os.environ.get(csec_env)
        if not client_secret:
            raise ValueError(
                f"OAuth2ClientCredentialsAuth: env var {csec_env!r} is not set or empty."
            )
        token_url = config["token_url"]
        url_hash = hashlib.md5(token_url.encode()).hexdigest()[:8]
        default_redis_key = f"oauth2:{url_hash}"
        redis_key = config.get("redis_key", default_redis_key)
        redis_lock_key = config.get("redis_lock_key", f"{redis_key}:lock")
        return cls(
            redis=redis,
            http=http,
            client_id=client_id,
            client_secret=client_secret,
            token_url=token_url,
            scope=config.get("scope", ""),
            audience=config.get("audience", ""),
            redis_key=redis_key,
            redis_lock_key=redis_lock_key,
            header=config.get("header", "Authorization"),
            prefix=config.get("prefix", "Bearer "),
            invalidate_on=_invalidate_on_from_config(config),
            ttl_fallback=config.get("ttl_fallback", 3600),
        )

    async def _fetch_token(self) -> tuple[str, int]:
        data: dict[str, str] = {
            "grant_type": "client_credentials",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }
        if self._scope:
            data["scope"] = self._scope
        if self._audience:
            data["audience"] = self._audience
        resp = await self._http.post(self._token_url, data=data, timeout=15.0)
        resp.raise_for_status()
        payload = resp.json()
        token: str = payload["access_token"]
        expires_in: int = int(payload.get("expires_in", self._ttl_fallback))
        ttl = max(60, expires_in - 60)
        return token, ttl

    async def apply(self, ctx: AuthContext) -> AuthResult:
        raw = await self._redis.get(self._redis_key)
        if raw:
            token = raw if isinstance(raw, str) else raw.decode()
            return AuthResult(headers={self._header: f"{self._prefix}{token}"})

        got_lock = await self._redis.set(self._redis_lock_key, "1", nx=True, ex=_LOCK_TTL)
        if not got_lock:
            for _ in range(_LOCK_RETRY_COUNT):
                await asyncio.sleep(_LOCK_RETRY_SLEEP)
                raw = await self._redis.get(self._redis_key)
                if raw:
                    token = raw if isinstance(raw, str) else raw.decode()
                    return AuthResult(headers={self._header: f"{self._prefix}{token}"})
            raise RuntimeError(
                f"Timed out waiting for peer to fetch OAuth2 token (key={self._redis_key!r})."
            )

        try:
            token, ttl = await self._fetch_token()
            await self._redis.set(self._redis_key, token, ex=ttl)
            log.info("Fetched OAuth2 token for %s, ttl=%ds", self._token_url, ttl)
            return AuthResult(headers={self._header: f"{self._prefix}{token}"})
        finally:
            await self._redis.delete(self._redis_lock_key)

    async def invalidate(self) -> None:
        await self._redis.delete(self._redis_key)

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return status_code in self._invalidate_on
