from __future__ import annotations

import os
from typing import Any

import httpx
from redis.asyncio import Redis

from app.auth.base import AuthContext, AuthResult, _invalidate_on_from_config


class ApiKeyHeaderAuth:
    """API key injected as a request header."""

    name = "api_key_header"

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
    ) -> ApiKeyHeaderAuth:
        env_name = config["env"]
        token = os.environ.get(env_name)
        if not token:
            raise ValueError(f"ApiKeyHeaderAuth: env var {env_name!r} is not set or empty.")
        return cls(
            token=token,
            header=config["header"],
            prefix=config.get("prefix", ""),
            invalidate_on=_invalidate_on_from_config(config),
        )

    async def apply(self, ctx: AuthContext) -> AuthResult:
        return AuthResult(headers={self._header: f"{self._prefix}{self._token}"})

    async def invalidate(self) -> None:
        pass

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return status_code in self._invalidate_on
