from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Any

import httpx
from redis.asyncio import Redis

from app.auth.base import AuthContext, AuthResult, _invalidate_on_from_config

_DIGEST_MAP = {
    "sha256": hashlib.sha256,
    "sha512": hashlib.sha512,
}


class HmacSignedAuth:
    """HMAC-signed requests (Binance-style): API key header + HMAC signature."""

    name = "hmac_signed"

    def __init__(
        self,
        api_key: str,
        secret: bytes,
        key_header: str,
        signature_header: str,
        signature_param: str,
        timestamp_param: str,
        timestamp_header: str,
        digest: str,
        payload: str,
        invalidate_on: set[int],
    ) -> None:
        self._api_key = api_key
        self._secret = secret
        self._key_header = key_header
        self._signature_header = signature_header
        self._signature_param = signature_param
        self._timestamp_param = timestamp_param
        self._timestamp_header = timestamp_header
        self._digest = digest
        self._payload = payload
        self._invalidate_on = invalidate_on

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> HmacSignedAuth:
        key_env = config["key_env"]
        secret_env = config["secret_env"]
        api_key = os.environ.get(key_env)
        if not api_key:
            raise ValueError(f"HmacSignedAuth: env var {key_env!r} is not set or empty.")
        secret_str = os.environ.get(secret_env)
        if not secret_str:
            raise ValueError(f"HmacSignedAuth: env var {secret_env!r} is not set or empty.")
        digest = config.get("digest", "sha256")
        if digest not in _DIGEST_MAP:
            raise ValueError(
                f"HmacSignedAuth: unsupported digest {digest!r}. Use: {list(_DIGEST_MAP)}."
            )
        return cls(
            api_key=api_key,
            secret=secret_str.encode(),
            key_header=config.get("key_header", "X-MBX-APIKEY"),
            signature_header=config.get("signature_header", ""),
            signature_param=config.get("signature_param", "signature"),
            timestamp_param=config.get("timestamp_param", "timestamp"),
            timestamp_header=config.get("timestamp_header", ""),
            digest=digest,
            payload=config.get("payload", "query"),
            invalidate_on=_invalidate_on_from_config(config),
        )

    async def apply(self, ctx: AuthContext) -> AuthResult:
        ts = str(int(time.time() * 1000))

        # Build canonical payload string for signing.
        if self._payload == "query":
            qs = ctx.query_string
            if self._timestamp_param and not self._timestamp_header:
                sep = "&" if qs else ""
                qs = f"{qs}{sep}{self._timestamp_param}={ts}"
            canonical = qs.encode()
        elif self._payload == "body":
            canonical = ctx.body
        else:  # query+body
            qs = ctx.query_string
            if self._timestamp_param and not self._timestamp_header:
                sep = "&" if qs else ""
                qs = f"{qs}{sep}{self._timestamp_param}={ts}"
            canonical = f"{qs}\n".encode() + ctx.body

        hash_fn = _DIGEST_MAP[self._digest]
        sig = hmac.new(self._secret, canonical, hash_fn).hexdigest()

        headers: dict[str, str] = {self._key_header: self._api_key}
        query_params: dict[str, str] = {}

        if self._timestamp_header:
            headers[self._timestamp_header] = ts
        else:
            query_params[self._timestamp_param] = ts

        if self._signature_header:
            headers[self._signature_header] = sig
        else:
            query_params[self._signature_param] = sig

        return AuthResult(
            headers=headers,
            query_params=query_params if query_params else None,
        )

    async def invalidate(self) -> None:
        pass

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return status_code in self._invalidate_on
