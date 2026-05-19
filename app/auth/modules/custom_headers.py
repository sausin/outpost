from __future__ import annotations

import os
from typing import Any

import httpx
from redis.asyncio import Redis

from app.auth.base import AuthContext, AuthResult, _invalidate_on_from_config


class CustomHeadersAuth:
    """Inject arbitrary static headers sourced from env vars or literal values."""

    name = "custom_headers"

    def __init__(self, headers: dict[str, str], invalidate_on: set[int]) -> None:
        self._headers = headers
        self._invalidate_on = invalidate_on

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> CustomHeadersAuth:
        raw_headers: dict[str, Any] = config.get("headers", {})
        resolved: dict[str, str] = {}
        for header_name, spec in raw_headers.items():
            if "value" in spec:
                resolved[header_name] = spec["value"]
            elif "env" in spec:
                env_name = spec["env"]
                val = os.environ.get(env_name)
                if not val:
                    raise ValueError(
                        f"CustomHeadersAuth: env var {env_name!r} for header {header_name!r} "
                        "is not set or empty."
                    )
                resolved[header_name] = val
            else:
                raise ValueError(
                    f"CustomHeadersAuth: header {header_name!r} must have 'env' or 'value'."
                )
        return cls(
            headers=resolved,
            invalidate_on=_invalidate_on_from_config(config),
        )

    async def apply(self, ctx: AuthContext) -> AuthResult:
        return AuthResult(headers=dict(self._headers))

    async def invalidate(self) -> None:
        pass

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return status_code in self._invalidate_on
