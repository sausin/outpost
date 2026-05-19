from __future__ import annotations

import os
from typing import Any

import httpx
from redis.asyncio import Redis

from app.auth.base import AuthContext, AuthResult, _invalidate_on_from_config


def _walk_path(body: dict | None, path: str) -> list:
    """Subset of JSONPath: dotted segments, optional [] for arrays. Returns flat list of leaf values."""
    if body is None:
        return []
    nodes = [body]
    for segment in path.split("."):
        next_nodes = []
        if segment.endswith("[]"):
            key = segment[:-2]
            for n in nodes:
                if isinstance(n, dict) and key in n:
                    v = n[key]
                    if isinstance(v, list):
                        next_nodes.extend(v)
        else:
            for n in nodes:
                if isinstance(n, dict) and segment in n:
                    next_nodes.append(n[segment])
        nodes = next_nodes
    return nodes


class BearerRedisAuth:
    """Bearer token stored in Redis; optional env seed and body-error invalidation."""

    name = "bearer_redis"

    def __init__(
        self,
        redis: Redis,
        redis_key: str,
        env_seed: str | None,
        header: str,
        prefix: str,
        invalidate_on: set[int],
        body_json_path: str | None,
        body_codes: set[str],
    ) -> None:
        self._redis = redis
        self._redis_key = redis_key
        self._env_seed = env_seed
        self._header = header
        self._prefix = prefix
        self._invalidate_on = invalidate_on
        self._body_json_path = body_json_path
        self._body_codes = body_codes

    @classmethod
    def from_config(
        cls, config: dict[str, Any], *, redis: Redis, http: httpx.AsyncClient
    ) -> BearerRedisAuth:
        body_codes_cfg = config.get("invalidate_on_body_codes")
        body_json_path: str | None = None
        body_codes: set[str] = set()
        if body_codes_cfg:
            body_json_path = body_codes_cfg.get("json_path")
            body_codes = set(body_codes_cfg.get("codes", []))
        return cls(
            redis=redis,
            redis_key=config["redis_key"],
            env_seed=config.get("env_seed"),
            header=config.get("header", "Authorization"),
            prefix=config.get("prefix", "Bearer "),
            invalidate_on=_invalidate_on_from_config(config),
            body_json_path=body_json_path,
            body_codes=body_codes,
        )

    async def apply(self, ctx: AuthContext) -> AuthResult:
        raw = await self._redis.get(self._redis_key)
        if not raw and self._env_seed:
            seed = os.environ.get(self._env_seed)
            if seed:
                await self._redis.set(self._redis_key, seed)
                raw = seed
        if not raw:
            raise RuntimeError(f"Token not configured at redis_key={self._redis_key!r}.")
        token = raw if isinstance(raw, str) else raw.decode()
        return AuthResult(headers={self._header: f"{self._prefix}{token}"})

    async def invalidate(self) -> None:
        await self._redis.delete(self._redis_key)

    def is_rejection(self, status_code: int, body: dict | None) -> bool:
        if status_code in self._invalidate_on:
            return True
        if self._body_json_path and body is not None:
            leaves = _walk_path(body, self._body_json_path)
            if self._body_codes.intersection(str(v) for v in leaves):
                return True
        return False
