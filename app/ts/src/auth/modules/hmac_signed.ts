import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";
import { invalidateOnFromConfig } from "../types.ts";

type SupportedDigest = "SHA-256" | "SHA-512";

const DIGEST_MAP: Record<string, SupportedDigest> = {
  sha256: "SHA-256",
  sha512: "SHA-512",
};

async function hmacHex(
  key: string,
  data: string | Uint8Array,
  algo: SupportedDigest,
): Promise<string> {
  const keyBytes = new TextEncoder().encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: algo },
    false,
    ["sign"],
  );
  const dataBytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, dataBytes);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class HmacSignedAuth implements AuthModule {
  static readonly typeName = "hmac_signed";

  private constructor(
    private readonly apiKey: string,
    private readonly secret: string,
    private readonly keyHeader: string,
    private readonly signatureHeader: string,
    private readonly signatureParam: string,
    private readonly timestampParam: string,
    private readonly timestampHeader: string,
    private readonly digest: SupportedDigest,
    private readonly payload: string,
    private readonly invalidateOn: Set<number>,
  ) {}

  static fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): HmacSignedAuth {
    const keyEnv = config["key_env"];
    if (typeof keyEnv !== "string") {
      throw new Error("HmacSignedAuth: 'key_env' must be a string.");
    }
    const secretEnv = config["secret_env"];
    if (typeof secretEnv !== "string") {
      throw new Error("HmacSignedAuth: 'secret_env' must be a string.");
    }

    const apiKey = deps.env[keyEnv];
    if (typeof apiKey !== "string" || !apiKey) {
      throw new Error(
        `HmacSignedAuth: env var '${keyEnv}' is not set or empty.`,
      );
    }
    const secret = deps.env[secretEnv];
    if (typeof secret !== "string" || !secret) {
      throw new Error(
        `HmacSignedAuth: env var '${secretEnv}' is not set or empty.`,
      );
    }

    const digestName =
      typeof config["digest"] === "string" ? config["digest"] : "sha256";
    const resolvedDigest = DIGEST_MAP[digestName];
    if (!resolvedDigest) {
      throw new Error(
        `HmacSignedAuth: unsupported digest '${digestName}'. Use: ${Object.keys(DIGEST_MAP).join(", ")}.`,
      );
    }

    const payloadMode =
      typeof config["payload"] === "string" ? config["payload"] : "query";
    if (!["query", "body", "query+body"].includes(payloadMode)) {
      throw new Error(
        `HmacSignedAuth: unsupported payload mode '${payloadMode}'. Use: query, body, query+body.`,
      );
    }

    return new HmacSignedAuth(
      apiKey,
      secret,
      typeof config["key_header"] === "string"
        ? config["key_header"]
        : "X-MBX-APIKEY",
      typeof config["signature_header"] === "string"
        ? config["signature_header"]
        : "",
      typeof config["signature_param"] === "string"
        ? config["signature_param"]
        : "signature",
      typeof config["timestamp_param"] === "string"
        ? config["timestamp_param"]
        : "timestamp",
      typeof config["timestamp_header"] === "string"
        ? config["timestamp_header"]
        : "",
      resolvedDigest,
      payloadMode,
      invalidateOnFromConfig(config, [401]),
    );
  }

  async apply(ctx: AuthContext): Promise<AuthResult> {
    const ts = String(Date.now());

    // Build canonical payload string for signing.
    let canonical: string | Uint8Array;

    if (this.payload === "query") {
      let qs = ctx.queryString;
      if (this.timestampParam && !this.timestampHeader) {
        const sep = qs ? "&" : "";
        qs = `${qs}${sep}${this.timestampParam}=${ts}`;
      }
      canonical = qs;
    } else if (this.payload === "body") {
      canonical =
        ctx.body !== null ? new Uint8Array(ctx.body) : new Uint8Array(0);
    } else {
      // query+body
      let qs = ctx.queryString;
      if (this.timestampParam && !this.timestampHeader) {
        const sep = qs ? "&" : "";
        qs = `${qs}${sep}${this.timestampParam}=${ts}`;
      }
      const qsPart = new TextEncoder().encode(`${qs}\n`);
      const bodyPart =
        ctx.body !== null ? new Uint8Array(ctx.body) : new Uint8Array(0);
      const merged = new Uint8Array(qsPart.length + bodyPart.length);
      merged.set(qsPart, 0);
      merged.set(bodyPart, qsPart.length);
      canonical = merged;
    }

    const sig = await hmacHex(this.secret, canonical, this.digest);

    const headers: Record<string, string> = { [this.keyHeader]: this.apiKey };
    const queryParams: Record<string, string> = {};

    if (this.timestampHeader) {
      headers[this.timestampHeader] = ts;
    } else {
      queryParams[this.timestampParam] = ts;
    }

    if (this.signatureHeader) {
      headers[this.signatureHeader] = sig;
    } else {
      queryParams[this.signatureParam] = sig;
    }

    return {
      headers,
      ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
    };
  }

  async invalidate(): Promise<void> {}

  isRejection(statusCode: number, _body: unknown): boolean {
    return this.invalidateOn.has(statusCode);
  }
}
