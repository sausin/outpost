/**
 * Groww access-token mint via TOTP — example custom auth plugin.
 *
 * Flow:
 *   POST <mint_path>
 *   Authorization: Bearer <API_KEY>
 *   Body: { key_type: "totp", totp: "<6-digit code>" }
 *   → { token: "...", expiry?: "...ISO 8601..." }
 *
 * The minted token is cached in tokenStorage (Redis or KV).
 * A soft NX lock prevents thundering-herd minting under concurrent misses.
 *
 * Node (Redis): pttl-based NX check; atomic on Redis.
 * Workers (KV): non-atomic — two Workers may mint concurrently in the narrow
 *   race window, but the second write is idempotent (same token, same TTL).
 */

import type { AuthContext, AuthResult } from "../core/types.ts";
import type { AuthModule, AuthDeps } from "../auth/types.ts";

// Hardcoded because this plugin is Groww-specific. If `mint_path` in the YAML
// is already absolute (starts with http(s)://), it's used as-is.
const GROWW_BASE_URL = "https://api.groww.in";

const TOKEN_KEY = "groww:token";
const TOKEN_LOCK_KEY = "groww:token:lock";
const TOKEN_LOCK_TTL_S = 30;
const TOKEN_TTL_FALLBACK_S = 60 * 60 * 18; // 18 hours
const LOCK_RETRY_COUNT = 20;
const LOCK_RETRY_SLEEP_MS = 250;

// RFC 4648 base32 alphabet.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const s = input.replace(/=+$/, "").toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of s) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue; // skip padding / unknown chars
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * RFC 6238 TOTP via Web Crypto HMAC-SHA1.
 * Groww uses standard 6-digit / 30-second / SHA-1 TOTP.
 */
async function totp(
  seedBase32: string,
  tSeconds: number = Date.now() / 1000,
  step = 30,
  digits = 6,
): Promise<string> {
  const counter = Math.floor(tSeconds / step);

  const counterBytes = new ArrayBuffer(8);
  new DataView(counterBytes).setBigUint64(0, BigInt(counter), false);

  // Pad to multiple of 8 chars.
  const padded =
    seedBase32.toUpperCase() +
    "=".repeat(-seedBase32.length & 7 ? -seedBase32.length & 7 : 0);
  const keyBytes = base32Decode(padded);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, counterBytes),
  );

  const offset = sig[sig.length - 1] & 0x0f;
  const code =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];
  const mod = code % Math.pow(10, digits);
  return mod.toString().padStart(digits, "0");
}

function parseTtlFromExpiry(expiry: string): number | null {
  try {
    const normalized = expiry.replace("Z", "+00:00");
    const exp = new Date(normalized);
    if (isNaN(exp.getTime())) return null;
    const remaining =
      Math.floor(exp.getTime() / 1000 - Date.now() / 1000) - 120;
    return remaining > 60 ? remaining : 60;
  } catch {
    return null;
  }
}

export class GrowwTotpMintAuth implements AuthModule {
  static readonly typeName = "groww_totp_mint";

  private constructor(
    private readonly deps: AuthDeps,
    private readonly apiKey: string,
    private readonly totpSeed: string,
    private readonly mintPath: string,
    private readonly invalidateOn: Set<number>,
  ) {}

  static fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): GrowwTotpMintAuth {
    const apiKeyEnv =
      typeof config["api_key_env"] === "string"
        ? config["api_key_env"]
        : "GROWW_API_KEY";
    const totpSeedEnv =
      typeof config["totp_seed_env"] === "string"
        ? config["totp_seed_env"]
        : "GROWW_TOTP_SEED";

    const apiKey = deps.env[apiKeyEnv];
    if (typeof apiKey !== "string" || !apiKey) {
      throw new Error("groww_totp_mint: api_key env var not set.");
    }
    const totpSeed = deps.env[totpSeedEnv];
    if (typeof totpSeed !== "string" || !totpSeed) {
      throw new Error("groww_totp_mint: totp_seed env var not set.");
    }

    const mintPath =
      typeof config["mint_path"] === "string"
        ? config["mint_path"]
        : "/v1/token/api/access";

    const invalidateOn = new Set(
      Array.isArray(config["invalidate_on"])
        ? (config["invalidate_on"] as unknown[]).filter(
            (v): v is number => typeof v === "number",
          )
        : [401],
    );

    return new GrowwTotpMintAuth(
      deps,
      apiKey,
      totpSeed,
      mintPath,
      invalidateOn,
    );
  }

  private async mint(): Promise<{ token: string; ttl: number }> {
    const code = await totp(this.totpSeed);
    const url = /^https?:\/\//.test(this.mintPath)
      ? this.mintPath
      : `${GROWW_BASE_URL}${this.mintPath.startsWith("/") ? "" : "/"}${this.mintPath}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key_type: "totp", totp: code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      throw new Error(
        `groww_totp_mint: mint endpoint returned ${resp.status}.`,
      );
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const token = data["token"];
    if (typeof token !== "string" || !token) {
      throw new Error("groww_totp_mint: response missing 'token'.");
    }

    let ttl = TOKEN_TTL_FALLBACK_S;
    const expiryStr = data["expiry"];
    if (typeof expiryStr === "string") {
      const parsed = parseTtlFromExpiry(expiryStr);
      if (parsed !== null) {
        ttl = parsed;
      }
    }

    return { token, ttl };
  }

  private async getOrMint(): Promise<string> {
    const cached = await this.deps.tokenStorage.get(TOKEN_KEY);
    if (cached) return cached;

    // Soft NX lock.
    const lockPttl = await this.deps.tokenStorage.pttl(TOKEN_LOCK_KEY);
    const hasLock = lockPttl === -2; // key absent → we can take it

    if (!hasLock) {
      for (let i = 0; i < LOCK_RETRY_COUNT; i++) {
        await sleep(LOCK_RETRY_SLEEP_MS);
        const retried = await this.deps.tokenStorage.get(TOKEN_KEY);
        if (retried) return retried;
      }
      throw new Error(
        "groww_totp_mint: timed out waiting for peer to mint token.",
      );
    }

    await this.deps.tokenStorage.set(TOKEN_LOCK_KEY, "1", TOKEN_LOCK_TTL_S);
    try {
      const { token, ttl } = await this.mint();
      await this.deps.tokenStorage.set(TOKEN_KEY, token, ttl);
      return token;
    } finally {
      await this.deps.tokenStorage.delete(TOKEN_LOCK_KEY);
    }
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    const token = await this.getOrMint();
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  async invalidate(): Promise<void> {
    await this.deps.tokenStorage.delete(TOKEN_KEY);
  }

  isRejection(statusCode: number, _body: unknown): boolean {
    return this.invalidateOn.has(statusCode);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
