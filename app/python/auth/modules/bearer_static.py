from __future__ import annotations

import os
from typing import Any

import httpx
from redis.asyncio import Redis

from app.python.auth.base import AuthContext, AuthResult, _invalidate_on_from_config


class BearerStaticAuth:
    """Static bearer token read once from an environment variable."""

    name = "bearer_static"

    def __init__(
        self,
        token: str,
        header: str,
        prefix: str,
        invalidate_on: set[int],
    ) -> None:
        self._token = token
        self._header = header
        self._prefix = prefix
        self._invalidate_on = invalidate_on

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> BearerStaticAuth:
        if "value" in config:
            token = config["value"]
        elif "env" in config:
            env_name = config["env"]
            token = os.environ.get(env_name)
            if not token:
                raise ValueError(f"BearerStaticAuth: env var {env_name!r} is not set or empty.")
        else:
            raise ValueError("BearerStaticAuth: config must have 'env' or 'value'.")
        return cls(
            token=token,
            header=config.get("header", "Authorization"),
            prefix=config.get("prefix", "Bearer "),
            invalidate_on=_invalidate_on_from_config(config),
        )

    async def apply(self, ctx: AuthContext) -> AuthResult:
        return AuthResult(headers={self._header: f"{self._prefix}{self._token}"})

    async def invalidate(self) -> None:
        pass

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return status_code in self._invalidate_on
