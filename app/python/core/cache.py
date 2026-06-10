"""Response caching and idempotency.

Cache key: `cache:{broker}:{method}:{path}:{sorted_query_hash}`.
Idempotency key: `idem:{broker}:{idempotency_key}`. Stored for 24h.

Cached entry shape: {status_code: int, body_b64: str, content_type: str}.
Bodies are base64-encoded so we stay byte-faithful for non-JSON responses
(binary, CSV, plain text). For JSON-heavy workloads this costs ~33% size
overhead but lets the proxy be truly transparent rather than JSON-only.
"""

from __future__ import annotations

import base64
import hashlib
import json

from redis.asyncio import Redis

IDEM_TTL = 86_400  # 24h


def _query_hash(query_string: str) -> str:
    # Normalize: sort params so ?a=1&b=2 and ?b=2&a=1 share a cache entry.
    if not query_string:
        return "_"
    parts = sorted(query_string.split("&"))
    return hashlib.sha1("&".join(parts).encode()).hexdigest()[:16]


def cache_key(broker: str, method: str, path: str, query_string: str) -> str:
    return f"cache:{broker}:{method}:{path}:{_query_hash(query_string)}"


def idem_key(broker: str, key: str) -> str:
    return f"idem:{broker}:{key}"


def encode_body(raw: bytes) -> str:
    """Base64-encode a response body for storage."""
    return base64.b64encode(raw).decode("ascii")


def decode_body(b64: str) -> bytes:
    """Decode a base64-stored response body back to bytes."""
    return base64.b64decode(b64.encode("ascii"))


async def get_cached(redis: Redis, key: str) -> dict | None:
    raw = await redis.get(key)
    if raw is None:
        return None
    return json.loads(raw)


async def put_cached(redis: Redis, key: str, payload: dict, ttl: int) -> None:
    if ttl <= 0:
        return
    await redis.set(key, json.dumps(payload), ex=ttl)
