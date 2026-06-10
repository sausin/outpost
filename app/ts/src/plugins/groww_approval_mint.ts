/**
 * Groww access-token mint via API key + secret checksum — example custom auth plugin.
 *
 * Flow:
 *   POST <mint_path>
 *   Authorization: Bearer <API_KEY>
 *   Body: { key_type: "approval", checksum: sha256(secret + ts), timestamp: ts }
 *   → { token: "...", expiry?: "...ISO 8601..." }
 *
 * Reuses the same token cache keys as groww_totp_mint so both plugins share a
 * single Groww token slot (the tokens are interchangeable; only the mint method differs).
 *
 * Node (Redis): pttl-based NX check.
 * Workers (KV): non-atomic soft lock — see groww_totp_mint.ts class docstring.
 */

import type { AuthContext, AuthResult } from "../core/types.ts";
import type { AuthModule, AuthDeps } from "../auth/types.ts";

const TOKEN_KEY = "groww:token";
const TOKEN_LOCK_KEY = "groww:token:lock";
const TOKEN_LOCK_TTL_S = 30;
const TOKEN_TTL_FALLBACK_S = 60 * 60 * 18; // 18 hours
const LOCK_RETRY_COUNT = 20;
const LOCK_RETRY_SLEEP_MS = 250;

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

export class GrowwApprovalMintAuth implements AuthModule {
  static readonly typeName = "groww_approval_mint";

  private constructor(
    private readonly deps: AuthDeps,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly mintPath: string,
    private readonly invalidateOn: Set<number>,
  ) {}

  static fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): GrowwApprovalMintAuth {
    const apiKeyEnv =
      typeof config["api_key_env"] === "string"
        ? config["api_key_env"]
        : "GROWW_API_KEY";
    const apiSecretEnv =
      typeof config["api_secret_env"] === "string"
        ? config["api_secret_env"]
        : "GROWW_API_SECRET";

    const apiKey = deps.env[apiKeyEnv];
    if (typeof apiKey !== "string" || !apiKey) {
      throw new Error("groww_approval_mint: api_key env var not set.");
    }
    const apiSecret = deps.env[apiSecretEnv];
    if (typeof apiSecret !== "string" || !apiSecret) {
      throw new Error("groww_approval_mint: api_secret env var not set.");
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

    return new GrowwApprovalMintAuth(
      deps,
      apiKey,
      apiSecret,
      mintPath,
      invalidateOn,
    );
  }

  private async mint(): Promise<{ token: string; ttl: number }> {
    const ts = String(Math.floor(Date.now() / 1000));
    const checksum = await sha256Hex(this.apiSecret + ts);

    const resp = await fetch(this.mintPath, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key_type: "approval", checksum, timestamp: ts }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      throw new Error(
        `groww_approval_mint: mint endpoint returned ${resp.status}.`,
      );
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const token = data["token"];
    if (typeof token !== "string" || !token) {
      throw new Error("groww_approval_mint: response missing 'token'.");
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
        "groww_approval_mint: timed out waiting for peer to mint token.",
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
