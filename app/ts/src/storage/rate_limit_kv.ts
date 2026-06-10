import { RateLimitedError, type RateLimitBackend } from "./interface.ts";
import type { WindowLimit } from "../core/types.ts";

interface BucketState {
  tokens: number;
  ts: number;
}

/**
 * KV-backed rate limiter using optimistic (non-atomic) read-modify-write.
 *
 * Trade-off: under concurrent request bursts, multiple Workers may over-permit
 * by up to N-1 requests (where N is the number of simultaneous writers). For
 * the typical agent-sidecar deployment (single Worker, low QPS), drift is
 * effectively zero. Acknowledged per project decision.
 */
export class KvRateLimit implements RateLimitBackend {
  constructor(private readonly kv: KVNamespace) {}

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
        const result = await this.takeOptimistic(provider, category, window);
        if (!result.allowed) {
          nextWaitMs = result.waitMs;
          blocked = true;
          break;
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

  private async takeOptimistic(
    provider: string,
    category: string,
    window: WindowLimit,
  ): Promise<{ allowed: boolean; waitMs: number }> {
    const key = `rl:${provider}:${category}:${window.windowMs}`;
    const now = Date.now();
    const raw = (await this.kv.get(key, "json")) as BucketState | null;
    let state: BucketState = raw ?? { tokens: window.capacity, ts: now };

    const elapsed = now - state.ts;
    if (elapsed > 0) {
      const refill = (elapsed / window.windowMs) * window.capacity;
      state = {
        tokens: Math.min(window.capacity, state.tokens + refill),
        ts: now,
      };
    }

    let allowed = false;
    let waitMs = 0;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      allowed = true;
    } else {
      waitMs = Math.ceil(
        ((1 - state.tokens) * window.windowMs) / window.capacity,
      );
    }

    await this.kv.put(key, JSON.stringify(state), {
      expirationTtl: Math.max(60, Math.ceil((window.windowMs * 2) / 1000)),
    });

    return { allowed, waitMs };
  }

  async noteUpstream429(
    provider: string,
    category: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    const clamped = Math.max(0.1, Math.min(600, retryAfterSeconds));
    const expiry = Date.now() + clamped * 1000;
    await this.kv.put(`rl:cooldown:${provider}:${category}`, String(expiry), {
      expirationTtl: Math.max(60, Math.ceil(clamped)),
    });
  }

  async cooldownRemainingMs(
    provider: string,
    category: string,
  ): Promise<number> {
    const value = await this.kv.get(
      `rl:cooldown:${provider}:${category}`,
      "text",
    );
    if (!value) return 0;
    const expiry = parseInt(value, 10);
    const remaining = expiry - Date.now();
    return remaining > 0 ? remaining : 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
