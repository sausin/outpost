import type { Storage } from "./interface.ts";

export class KvStorage implements Storage {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return await this.kv.get(key, "text");
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      // Workers KV minimum TTL is 60s; clamp.
      await this.kv.put(key, value, {
        expirationTtl: Math.max(60, ttlSeconds),
      });
    } else {
      await this.kv.put(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  /**
   * KV doesn't expose remaining TTL. Returns -2 if the key is missing,
   * -1 otherwise (treat as "still valid, TTL unknown").
   */
  async pttl(key: string): Promise<number> {
    const value = await this.kv.get(key);
    return value === null ? -2 : -1;
  }
}
