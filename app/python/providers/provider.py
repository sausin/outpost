"""GenericProvider — runtime instance built from a ProviderSchema.

The proxy doesn't know what broker this is. It calls:
  - provider.classify(method, path) -> ClassifiedRoute | None
  - provider.auth.apply(ctx) -> AuthResult
  - provider.auth.invalidate() on rejection
  - provider.http for forwarding
  - provider.is_denied(path) to distinguish denied vs no-route
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx
from redis.asyncio import Redis

from app.python.auth.base import AuthModule
from app.python.auth.registry import resolve as resolve_auth
from app.python.core.pathmatch import CompiledRule, compile_rule
from app.python.core.pathmatch import matches as path_matches
from app.python.core.ratelimit import WindowLimit
from app.python.providers.schema import ProviderSchema

log = logging.getLogger(__name__)

_WRITE_METHODS = {"POST", "PUT", "DELETE", "PATCH"}


@dataclass(frozen=True)
class ClassifiedRoute:
    category: str
    cache_ttl: int
    sensitive: bool
    raw_pattern: str | None  # for logging; None in transparent mode


@dataclass(frozen=True)
class _AllowMeta:
    category: str
    cache_ttl: int
    sensitive: bool
    raw_pattern: str


class GenericProvider:
    name: str
    base_url: str
    default_headers: dict[str, str]
    strip_response_headers: set[str]
    auth: AuthModule

    def __init__(
        self,
        *,
        schema: ProviderSchema,
        auth: AuthModule,
        http: httpx.AsyncClient,
    ) -> None:
        self.name = schema.name
        self.base_url = schema.base_url
        self.default_headers = dict(schema.default_headers)
        self.strip_response_headers = {h.lower() for h in schema.strip_response_headers}
        self.auth = auth
        self.http = http
        self._schema = schema

        self._allow: list[tuple[CompiledRule, _AllowMeta]] = []
        for r in schema.forwarding.allow:
            self._allow.append(
                (
                    compile_rule(r.method, r.pattern),
                    _AllowMeta(
                        category=r.category,
                        cache_ttl=r.cache_ttl,
                        sensitive=r.sensitive,
                        raw_pattern=r.pattern,
                    ),
                )
            )

        self._deny: list[CompiledRule] = [compile_rule("*", p) for p in schema.forwarding.deny]

        self._rate_limits: dict[str, list[WindowLimit]] = {}
        for cat, windows in schema.forwarding.rate_limits.items():
            self._rate_limits[cat] = [
                WindowLimit(capacity=w.capacity, window_ms=w.window_ms) for w in windows
            ]

    @classmethod
    def from_schema(cls, schema: ProviderSchema, *, redis: Redis) -> GenericProvider:
        http = httpx.AsyncClient(
            base_url=schema.base_url,
            timeout=httpx.Timeout(30.0, connect=5.0),
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
        )
        auth_cls = resolve_auth(schema.auth.type)
        auth_config = schema.auth.model_dump(exclude={"type"})
        auth = auth_cls.from_config(auth_config, redis=redis, http=http)
        return cls(schema=schema, auth=auth, http=http)

    async def aclose(self) -> None:
        await self.http.aclose()

    def is_denied(self, path: str) -> bool:
        return any(path_matches(rule, "*", path) for rule in self._deny)

    def classify(self, method: str, path: str) -> ClassifiedRoute | None:
        """Return ClassifiedRoute or None if denied/unmatched.

        Deny rules win first. Then:
          - allowlist mode: first matching allow rule wins; no match -> None
          - transparent mode: synthesize a default route based on method
        """
        method = method.upper()
        if self.is_denied(path):
            return None

        fwd = self._schema.forwarding
        if fwd.mode == "allowlist":
            for compiled, meta in self._allow:
                if path_matches(compiled, method, path):
                    return ClassifiedRoute(
                        category=meta.category,
                        cache_ttl=meta.cache_ttl,
                        sensitive=meta.sensitive,
                        raw_pattern=meta.raw_pattern,
                    )
            return None

        # transparent mode
        is_write = method in _WRITE_METHODS
        return ClassifiedRoute(
            category=fwd.default_category,
            cache_ttl=0 if is_write else fwd.default_cache_ttl,
            sensitive=is_write and fwd.treat_writes_as_sensitive,
            raw_pattern=None,
        )

    def windows_for(self, category: str) -> list[WindowLimit]:
        return self._rate_limits.get(category) or self._rate_limits.get("default") or []
