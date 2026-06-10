from __future__ import annotations

from typing import Any

import httpx
from redis.asyncio import Redis

from app.python.auth.base import AuthContext, AuthResult


class NoneAuth:
    """Auth module that injects nothing; for open/public upstreams."""

    name = "none"

    def __init__(self) -> None:
        pass

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> NoneAuth:
        return cls()

    async def apply(self, ctx: AuthContext) -> AuthResult:
        return AuthResult()

    async def invalidate(self) -> None:
        pass

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return False
