import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";
import { invalidateOnFromConfig } from "../types.ts";

export class BasicAuth implements AuthModule {
  static readonly typeName = "basic_auth";

  // Encoded once at construction — avoids re-encoding on every request.
  private readonly encoded: string;
  private readonly invalidateOn: Set<number>;

  private constructor(encoded: string, invalidateOn: Set<number>) {
    this.encoded = encoded;
    this.invalidateOn = invalidateOn;
  }

  static fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): BasicAuth {
    if (typeof config["username_env"] !== "string") {
      throw new Error("BasicAuth: 'username_env' config field is required.");
    }
    if (typeof config["password_env"] !== "string") {
      throw new Error("BasicAuth: 'password_env' config field is required.");
    }

    const userEnv = config["username_env"];
    const passEnv = config["password_env"];

    const user = deps.env[userEnv];
    if (typeof user !== "string" || !user) {
      throw new Error(`BasicAuth: env var '${userEnv}' is not set or empty.`);
    }

    const pass = deps.env[passEnv];
    if (typeof pass !== "string" || !pass) {
      throw new Error(`BasicAuth: env var '${passEnv}' is not set or empty.`);
    }

    // btoa is available in Node 22+ and Cloudflare Workers globally.
    const encoded = btoa(`${user}:${pass}`);
    const invalidateOn = invalidateOnFromConfig(config, [401]);

    return new BasicAuth(encoded, invalidateOn);
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    return { headers: { Authorization: `Basic ${this.encoded}` } };
  }

  async invalidate(): Promise<void> {}

  isRejection(statusCode: number, _body: unknown): boolean {
    return this.invalidateOn.has(statusCode);
  }
}
