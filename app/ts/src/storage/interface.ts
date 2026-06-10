import type { WindowLimit } from "../core/types.ts";

export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Milliseconds remaining; -1 if no TTL; -2 if missing. */
  pttl(key: string): Promise<number>;
}

export interface CacheEntry {
  statusCode: number;
  bodyBase64: string;
  contentType: string;
}

export interface CacheBackend {
  get(key: string): Promise<CacheEntry | null>;
  put(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
}

export interface RateLimitBackend {
  acquire(
    provider: string,
    category: string,
    windows: WindowLimit[],
    queueTimeoutMs: number,
  ): Promise<void>;
  noteUpstream429(
    provider: string,
    category: string,
    retryAfterSeconds: number,
  ): Promise<void>;
  cooldownRemainingMs(provider: string, category: string): Promise<number>;
}

export class RateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Rate limited");
    this.name = "RateLimitedError";
  }
}
