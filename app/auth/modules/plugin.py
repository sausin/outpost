from __future__ import annotations

import importlib
from typing import Any

import httpx
from redis.asyncio import Redis

from app.auth.base import AuthContext, AuthModule, AuthResult


class PluginAuth:
    """Escape hatch: delegates to a user-supplied AuthModule loaded by dotted path."""

    name = "plugin"

    def __init__(self, inner: AuthModule) -> None:
        self._inner = inner

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> PluginAuth:
        module_spec: str = config.get("module", "")
        if ":" not in module_spec:
            raise ValueError(
                f"PluginAuth: 'module' must be 'module.path:ClassName', got {module_spec!r}."
            )
        module_path, _, class_name = module_spec.partition(":")
        try:
            mod = importlib.import_module(module_path)
        except ImportError as exc:
            raise ValueError(f"PluginAuth: cannot import module {module_path!r}: {exc}") from exc
        klass = getattr(mod, class_name, None)
        if klass is None:
            raise ValueError(
                f"PluginAuth: class {class_name!r} not found in module {module_path!r}."
            )
        if not isinstance(klass, type):
            raise ValueError(f"PluginAuth: {module_spec!r} is not a class.")
        inner_config: dict[str, Any] = config.get("config", {})
        try:
            inner = klass.from_config(inner_config, redis=redis, http=http)
        except Exception as exc:
            raise ValueError(f"PluginAuth: {module_spec!r}.from_config() failed: {exc}") from exc
        if not isinstance(inner, AuthModule):
            raise ValueError(
                f"PluginAuth: {module_spec!r} does not conform to the AuthModule protocol."
            )
        return cls(inner=inner)

    async def apply(self, ctx: AuthContext) -> AuthResult:
        return await self._inner.apply(ctx)

    async def invalidate(self) -> None:
        await self._inner.invalidate()

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        return self._inner.is_rejection(status_code, body)
