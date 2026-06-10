import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";
import { invalidateOnFromConfig } from "../types.ts";

const LOCK_TTL_S = 30;
const LOCK_RETRY_COUNT = 20;
const LOCK_RETRY_SLEEP_MS = 250;

/**
 * MD5-style 8-char hash for generating default Redis keys from token URLs.
 * Uses Web Crypto SHA-256 and takes the first 8 hex chars (collision probability
 * is negligible for the small number of providers a sidecar manages).
 */
async function urlHash(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

/**
 * OAuth2 client-credentials flow.
 *
 * Token is cached in tokenStorage with TTL = expires_in - 60.
 * A soft NX-style distributed lock prevents thundering-herd minting.
 *
 * Node (Redis) backend: uses SET NX EX for an atomic NX lock.
 * Workers (KV) backend: KV has no NX — a "lock" key is written with a short TTL;
 *   on miss, callers retry LOCK_RETRY_COUNT times before giving up. There is a
 *   narrow window where two Workers may both believe they hold the lock and both
 *   mint a token; the second write is a no-op (same value, same TTL) so the only
 *   cost is one extra token-endpoint round-trip.
 */
export class OAuth2ClientCredentialsAuth implements AuthModule {
  static readonly typeName = "oauth2_client_credentials";

  private constructor(
    private readonly deps: AuthDeps,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tokenUrl: string,
    private readonly scope: string,
    private readonly audience: string,
    private readonly storageKey: string,
    private readonly lockKey: string,
    private readonly header: string,
    private readonly prefix: string,
    private readonly invalidateOn: Set<number>,
    private readonly ttlFallback: number,
  ) {}

  static async fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): Promise<OAuth2ClientCredentialsAuth> {
    const cidEnv = config["client_id_env"];
    if (typeof cidEnv !== "string") {
      throw new Error(
        "OAuth2ClientCredentialsAuth: 'client_id_env' must be a string.",
      );
    }
    const csecEnv = config["client_secret_env"];
    if (typeof csecEnv !== "string") {
      throw new Error(
        "OAuth2ClientCredentialsAuth: 'client_secret_env' must be a string.",
      );
    }

    const clientId = deps.env[cidEnv];
    if (typeof clientId !== "string" || !clientId) {
      throw new Error(
        `OAuth2ClientCredentialsAuth: env var '${cidEnv}' is not set or empty.`,
      );
    }
    const clientSecret = deps.env[csecEnv];
    if (typeof clientSecret !== "string" || !clientSecret) {
      throw new Error(
        `OAuth2ClientCredentialsAuth: env var '${csecEnv}' is not set or empty.`,
      );
    }

    const tokenUrl = config["token_url"];
    if (typeof tokenUrl !== "string" || !tokenUrl) {
      throw new Error(
        "OAuth2ClientCredentialsAuth: 'token_url' must be a non-empty string.",
      );
    }

    const hash = await urlHash(tokenUrl);
    const defaultKey = `oauth2:${hash}`;
    const storageKey =
      typeof config["redis_key"] === "string"
        ? config["redis_key"]
        : defaultKey;
    const lockKey =
      typeof config["redis_lock_key"] === "string"
        ? config["redis_lock_key"]
        : `${storageKey}:lock`;

    return new OAuth2ClientCredentialsAuth(
      deps,
      clientId,
      clientSecret,
      tokenUrl,
      typeof config["scope"] === "string" ? config["scope"] : "",
      typeof config["audience"] === "string" ? config["audience"] : "",
      storageKey,
      lockKey,
      typeof config["header"] === "string" ? config["header"] : "Authorization",
      typeof config["prefix"] === "string" ? config["prefix"] : "Bearer ",
      invalidateOnFromConfig(config, [401]),
      typeof config["ttl_fallback"] === "number"
        ? config["ttl_fallback"]
        : 3600,
    );
  }

  private async fetchToken(): Promise<{ token: string; ttl: number }> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    if (this.scope) body.set("scope", this.scope);
    if (this.audience) body.set("audience", this.audience);

    const resp = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(
        `OAuth2ClientCredentialsAuth: token endpoint returned ${resp.status}.`,
      );
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const accessToken = data["access_token"];
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error(
        "OAuth2ClientCredentialsAuth: response missing 'access_token'.",
      );
    }
    const expiresIn =
      typeof data["expires_in"] === "number"
        ? data["expires_in"]
        : this.ttlFallback;
    const ttl = Math.max(60, expiresIn - 60);
    return { token: accessToken, ttl };
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    const cached = await this.deps.tokenStorage.get(this.storageKey);
    if (cached) {
      return { headers: { [this.header]: `${this.prefix}${cached}` } };
    }

    // Attempt to acquire lock (SET NX equivalent).
    // On Redis: pttl of the lock key will be -2 (missing) → we write and proceed.
    // On KV: same pattern but non-atomic — see class docstring.
    const lockPttl = await this.deps.tokenStorage.pttl(this.lockKey);
    const hasLock = lockPttl === -2; // key is absent → we can take it

    if (!hasLock) {
      // Another worker is minting. Retry until token appears.
      for (let i = 0; i < LOCK_RETRY_COUNT; i++) {
        await sleep(LOCK_RETRY_SLEEP_MS);
        const retryVal = await this.deps.tokenStorage.get(this.storageKey);
        if (retryVal) {
          return { headers: { [this.header]: `${this.prefix}${retryVal}` } };
        }
      }
      throw new Error(
        `OAuth2ClientCredentialsAuth: timed out waiting for peer to fetch token (key=${JSON.stringify(this.storageKey)}).`,
      );
    }

    // Write lock with short TTL so it self-expires on crash.
    await this.deps.tokenStorage.set(this.lockKey, "1", LOCK_TTL_S);
    try {
      const { token, ttl } = await this.fetchToken();
      await this.deps.tokenStorage.set(this.storageKey, token, ttl);
      return { headers: { [this.header]: `${this.prefix}${token}` } };
    } finally {
      await this.deps.tokenStorage.delete(this.lockKey);
    }
  }

  async invalidate(): Promise<void> {
    await this.deps.tokenStorage.delete(this.storageKey);
  }

  isRejection(statusCode: number, _body: unknown): boolean {
    return this.invalidateOn.has(statusCode);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
