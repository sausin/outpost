import type Redis from "ioredis";
import type { CacheBackend, CacheEntry } from "./interface.ts";

export class RedisCache implements CacheBackend {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<CacheEntry | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  async put(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.redis.set(key, JSON.stringify(entry), "EX", ttlSeconds);
  }
}
