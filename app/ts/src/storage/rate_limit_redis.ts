import type Redis from "ioredis";
import { RateLimitedError, type RateLimitBackend } from "./interface.ts";
import type { WindowLimit } from "../core/types.ts";

/**
 * Atomic token-bucket take: refills proportionally to elapsed time,
 * takes 1 token if available. Returns [allowed, retry_after_ms].
 *
 * KEYS[1] = bucket key
 * ARGV[1] = capacity
 * ARGV[2] = window in ms
 * ARGV[3] = now in ms
 */
const LUA = `
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
  retry_after = math.ceil((1 - tokens) * window_ms / capacity)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
redis.call('PEXPIRE', key, window_ms * 2)
return {allowed, retry_after}
`;

/** Acceptable clamp range for upstream-supplied retry-after values (seconds). */
const COOLDOWN_MIN_S = 0.1;
const COOLDOWN_MAX_S = 600;

export class RedisRateLimit implements RateLimitBackend {
  constructor(private readonly redis: Redis) {}

  async acquire(
    provider: string,
    category: string,
    windows: WindowLimit[],
    queueTimeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + queueTimeoutMs;

    const cooldownMs = await this.cooldownRemainingMs(provider, category);
    if (cooldownMs > 0) {
      const remaining = deadline - Date.now();
      if (cooldownMs > remaining) {
        throw new RateLimitedError(cooldownMs / 1000);
      }
      await sleep(cooldownMs);
    }

    while (true) {
      let nextWaitMs = 0;
      let blocked = false;

      for (const window of windows) {
        const bucketKey = `rl:${provider}:${category}:${window.windowMs}`;
        const result = (await this.redis.eval(
          LUA,
          1,
          bucketKey,
          String(window.capacity),
          String(window.windowMs),
          String(Date.now()),
        )) as [number, number];

        const [allowed, waitMs] = result;
        if (!allowed) {
          nextWaitMs = waitMs;
          blocked = true;
          break; // restart from first window per Python semantics
        }
      }

      if (!blocked) return;

      const remaining = deadline - Date.now();
      if (remaining <= 0 || nextWaitMs > remaining) {
        throw new RateLimitedError(Math.max(nextWaitMs, 100) / 1000);
      }
      await sleep(Math.min(nextWaitMs, remaining));
    }
  }

  async noteUpstream429(
    provider: string,
    category: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    const clamped = Math.max(
      COOLDOWN_MIN_S,
      Math.min(COOLDOWN_MAX_S, retryAfterSeconds),
    );
    const key = `rl:cooldown:${provider}:${category}`;
    await this.redis.set(key, "1", "PX", Math.round(clamped * 1000));
  }

  async cooldownRemainingMs(
    provider: string,
    category: string,
  ): Promise<number> {
    const pttl = await this.redis.pttl(`rl:cooldown:${provider}:${category}`);
    return pttl > 0 ? pttl : 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
