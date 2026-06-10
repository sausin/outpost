from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

import httpx
from redis.asyncio import Redis


@dataclass(frozen=True)
class AuthContext:
    """Per-request context an auth module may inspect when shaping its output."""

    method: str
    full_path: str
    query_string: str
    body: bytes
    headers: dict[str, str]


@dataclass
class AuthResult:
    """What the auth module wants injected for this request."""

    headers: dict[str, str] | None = None
    query_params: dict[str, str] | None = None
    body_override: bytes | None = None


@runtime_checkable
class AuthModule(Protocol):
    """Protocol every auth module must satisfy."""

    name: str

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> AuthModule: ...

    async def apply(self, ctx: AuthContext) -> AuthResult:
        """Compute auth additions for this specific request."""
        ...

    async def invalidate(self) -> None:
        """Drop cached credentials so next apply() refreshes."""
        ...

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        """Return True if the upstream response indicates auth was rejected."""
        ...


def _invalidate_on_from_config(config: dict[str, Any]) -> set[int]:
    """Extract the invalidate_on set from a module config dict."""
    return set(config.get("invalidate_on", [401]))
