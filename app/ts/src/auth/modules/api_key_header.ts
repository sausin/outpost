import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";
import { invalidateOnFromConfig } from "../types.ts";

export class ApiKeyHeaderAuth implements AuthModule {
  static readonly typeName = "api_key_header";

  private readonly token: string;
  private readonly header: string;
  private readonly prefix: string;
  private readonly invalidateOn: Set<number>;

  private constructor(
    token: string,
    header: string,
    prefix: string,
    invalidateOn: Set<number>,
  ) {
    this.token = token;
    this.header = header;
    this.prefix = prefix;
    this.invalidateOn = invalidateOn;
  }

  static fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): ApiKeyHeaderAuth {
    if (typeof config["env"] !== "string") {
      throw new Error("ApiKeyHeaderAuth: 'env' config field is required.");
    }
    const envName = config["env"];
    const envVal = deps.env[envName];
    if (typeof envVal !== "string" || !envVal) {
      throw new Error(
        `ApiKeyHeaderAuth: env var '${envName}' is not set or empty.`,
      );
    }

    if (typeof config["header"] !== "string") {
      throw new Error("ApiKeyHeaderAuth: 'header' config field is required.");
    }

    const prefix = typeof config["prefix"] === "string" ? config["prefix"] : "";
    const invalidateOn = invalidateOnFromConfig(config, [401, 403]);

    return new ApiKeyHeaderAuth(envVal, config["header"], prefix, invalidateOn);
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    return { headers: { [this.header]: `${this.prefix}${this.token}` } };
  }

  async invalidate(): Promise<void> {}

  isRejection(statusCode: number, _body: unknown): boolean {
    return this.invalidateOn.has(statusCode);
  }
}
