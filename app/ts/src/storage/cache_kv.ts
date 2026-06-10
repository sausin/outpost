import type { CacheBackend, CacheEntry } from "./interface.ts";

/**
 * KV-backed response cache for Cloudflare Workers.
 *
 * Uses Workers KV for both response cache and idempotency keys.
 * (The native Cache API works for proxied responses but not for
 * fabricated keys — KV is simpler and covers both cases.)
 */
export class KvCache implements CacheBackend {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<CacheEntry | null> {
    return await this.kv.get<CacheEntry>(key, "json");
  }

  async put(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    // Workers KV minimum TTL is 60s.
    await this.kv.put(key, JSON.stringify(entry), {
      expirationTtl: Math.max(60, ttlSeconds),
    });
  }
}
