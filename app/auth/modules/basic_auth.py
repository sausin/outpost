from __future__ import annotations

import base64
import os
from typing import Any

import httpx
from redis.asyncio import Redis

from app.auth.base import AuthContext, AuthResult, _invalidate_on_from_config


class BasicAuth:
    """HTTP Basic authentication from two environment variables."""

    name = "basic_auth"

    def __init__(self, encoded: str, invalidate_on: set[int]) -> None:
        self._encoded = encoded
        self._invalidate_on = invalidate_on

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> BasicAuth:
        username_env = config["username_env"]
        password_env = config["password_env"]
        username = os.environ.get(username_env)
        if not username:
            raise ValueError(f"BasicAuth: env var {username_env!r} is not set or empty.")
        password = os.environ.get(password_env)
        if not password:
            raise ValueError(f"BasicAuth: env var {password_env!r} is not set or empty.")
        encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
        return cls(encoded=encoded, invalidate_on=_invalidate_on_from_config(config))

    async def apply(self, ctx: AuthContext) -> AuthResult:
        return AuthResult(headers={"Authorization": f"Basic {self._encoded}"})

    async def invalidate(self) -> None:
        pass

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return status_code in self._invalidate_on
