/**
 * Cache and idempotency key helpers — mirrors app/core/cache.py key builders.
 * Uses Web Crypto (crypto.subtle) so the module works on both Node 22 and Workers
 * without a node:crypto import.
 */

async function sha1Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function queryHash(query: string): Promise<string> {
  if (!query) return "_";
  // Sort query params so key is stable regardless of param ordering.
  const sorted = query.split("&").sort().join("&");
  const hex = await sha1Hex(sorted);
  return hex.slice(0, 16);
}

export async function cacheKey(
  provider: string,
  method: string,
  path: string,
  query: string,
): Promise<string> {
  const qh = await queryHash(query);
  return `cache:${provider}:${method}:${path}:${qh}`;
}

export function idemKey(provider: string, key: string): string {
  return `idem:${provider}:${key}`;
}

export const IDEM_TTL_SECONDS = 86_400;
