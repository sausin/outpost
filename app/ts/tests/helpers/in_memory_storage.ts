import type { Storage } from "../../src/storage/interface.ts";

export class InMemoryStorage implements Storage {
  private data = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : undefined;
    this.data.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async pttl(key: string): Promise<number> {
    const entry = this.data.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === undefined) return -1;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  /** Test helper — insert an already-expired entry to test TTL expiry. */
  setExpired(key: string, value: string): void {
    this.data.set(key, { value, expiresAt: Date.now() - 1 });
  }
}
