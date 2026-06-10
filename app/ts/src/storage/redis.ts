import Redis from "ioredis";
import type { Storage } from "./interface.ts";

export class RedisStorage implements Storage {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return await this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.redis.set(key, value, "EX", ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async pttl(key: string): Promise<number> {
    return await this.redis.pttl(key);
  }
}

export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
}
