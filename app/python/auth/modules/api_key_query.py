from __future__ import annotations

import os
from typing import Any

import httpx
from redis.asyncio import Redis

from app.python.auth.base import AuthContext, AuthResult, _invalidate_on_from_config


class ApiKeyQueryAuth:
    """API key injected as a query parameter."""

    name = "api_key_query"

    def __init__(
        self,
        token: str,
        param: str,
        invalidate_on: set[int],
    ) -> None:
        self._token = token
        self._param = param
        self._invalidate_on = invalidate_on

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> ApiKeyQueryAuth:
        env_name = config["env"]
        token = os.environ.get(env_name)
        if not token:
            raise ValueError(f"ApiKeyQueryAuth: env var {env_name!r} is not set or empty.")
        return cls(
            token=token,
            param=config["param"],
            invalidate_on=_invalidate_on_from_config(config),
        )

    async def apply(self, ctx: AuthContext) -> AuthResult:
        return AuthResult(query_params={self._param: self._token})

    async def invalidate(self) -> None:
        pass

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return status_code in self._invalidate_on
