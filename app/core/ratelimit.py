"""Multi-provider, multi-window token-bucket rate limiter backed by Redis.

Each provider+category pair can have an arbitrary list of WindowLimit windows
(e.g. 10/s + 250/min). ALL windows must grant a token before the request
proceeds. Bucket state is stored atomically in Redis via a Lua script.

Upstream 429 handling: when the upstream broker returns 429, callers invoke
`note_upstream_429` to set a cooldown key. Subsequent `acquire` calls check
the cooldown before touching any bucket; if the remaining cooldown exceeds
queue_timeout the request is rejected immediately with RateLimited.

Key schema:
  Bucket  : rl:{provider}:{category}:{window_ms}
  Cooldown: rl:cooldown:{provider}:{category}
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from redis.asyncio import Redis

# Acceptable clamp range for upstream-supplied retry-after values (seconds).
_COOLDOWN_MIN_S = 0.1
_COOLDOWN_MAX_S = 600.0

# Atomic token-bucket take: refills based on elapsed time, takes 1 if available,
# returns (allowed, retry_after_ms). Works for any (capacity, window_ms) pair.
#
# KEYS[1] = bucket key
# ARGV[1] = capacity (tokens)
# ARGV[2] = refill window in ms
# ARGV[3] = now in ms
_LUA = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

-- Refill proportional to elapsed time.
local elapsed = now - ts
if elapsed > 0 then
  local refill = (elapsed / window_ms) * capacity
  tokens = math.min(capacity, tokens + refill)
  ts = now
end

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  -- Time until 1 token is available.
  retry_after = math.ceil((1 - tokens) * window_ms / capacity)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
redis.call('PEXPIRE', key, window_ms * 2)
return {allowed, retry_after}
"""


@dataclass(frozen=True)
class WindowLimit:
    capacity: int
    window_ms: int


class RateLimited(Exception):
    def __init__(self, retry_after: float):
        self.retry_after = retry_after


class RateLimiter:
    def __init__(self, redis: Redis, queue_timeout: float):
        self._redis = redis
        self._queue_timeout = queue_timeout
        self._sha: str | None = None

    async def _ensure_loaded(self) -> str:
        if self._sha is None:
            self._sha = await self._redis.script_load(_LUA)
        # Local assignment so type checker narrows away the Optional.
        sha = self._sha
        assert sha is not None
        return sha

    async def _take(self, key: str, capacity: int, window_ms: int) -> tuple[bool, int]:
        sha = await self._ensure_loaded()
        now_ms = int(time.time() * 1000)
        # Redis wire protocol passes everything as strings; Lua's tonumber() converts.
        # redis-py's evalsha return type confuses pyright in some overload paths.
        result = await self._redis.evalsha(  # pyright: ignore[reportGeneralTypeIssues]
            sha, 1, key, str(capacity), str(window_ms), str(now_ms)
        )
        return bool(result[0]), int(result[1])

    async def cooldown_remaining(self, provider: str, category: str) -> float:
        """Return seconds remaining on the upstream-429 cooldown, or 0 if none."""
        key = f"rl:cooldown:{provider}:{category}"
        pttl = await self._redis.pttl(key)
        return max(pttl / 1000, 0.0) if pttl > 0 else 0.0

    async def note_upstream_429(self, provider: str, category: str, retry_after_s: float) -> None:
        """Record an upstream 429; blocks further requests for retry_after_s seconds."""
        clamped = max(_COOLDOWN_MIN_S, min(_COOLDOWN_MAX_S, retry_after_s))
        key = f"rl:cooldown:{provider}:{category}"
        await self._redis.psetex(key, int(clamped * 1000), "1")

    async def acquire(self, provider: str, category: str, windows: list[WindowLimit]) -> None:
        """Block until all windows grant a token, or raise RateLimited.

        Checks any active upstream-429 cooldown first. If cooldown > queue_timeout,
        raises immediately. If cooldown <= queue_timeout, sleeps through it then
        proceeds to bucket checks.

        For each WindowLimit, atomically takes 1 token. If a window is exhausted and
        the remaining wait exceeds the deadline, raises RateLimited. Note: on retry,
        tokens from earlier windows in the list may be consumed again (acceptable drift).
        """
        deadline = time.monotonic() + self._queue_timeout

        # Cooldown check.
        cd = await self.cooldown_remaining(provider, category)
        if cd > 0:
            remaining = deadline - time.monotonic()
            if cd > remaining:
                raise RateLimited(retry_after=cd)
            await asyncio.sleep(cd)

        while True:
            for window in windows:
                bucket_key = f"rl:{provider}:{category}:{window.window_ms}"
                ok, wait_ms = await self._take(bucket_key, window.capacity, window.window_ms)
                if not ok:
                    wait = wait_ms / 1000
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or wait > remaining:
                        raise RateLimited(retry_after=max(wait, 0.1))
                    await asyncio.sleep(min(wait, remaining))
                    break  # restart all windows from the top
            else:
                # All windows granted — done.
                return
