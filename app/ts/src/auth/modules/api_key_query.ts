import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";
import { invalidateOnFromConfig } from "../types.ts";

export class ApiKeyQueryAuth implements AuthModule {
  static readonly typeName = "api_key_query";

  private readonly token: string;
  private readonly param: string;
  private readonly invalidateOn: Set<number>;

  private constructor(token: string, param: string, invalidateOn: Set<number>) {
    this.token = token;
    this.param = param;
    this.invalidateOn = invalidateOn;
  }

  static fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): ApiKeyQueryAuth {
    if (typeof config["env"] !== "string") {
      throw new Error("ApiKeyQueryAuth: 'env' config field is required.");
    }
    const envName = config["env"];
    const envVal = deps.env[envName];
    if (typeof envVal !== "string" || !envVal) {
      throw new Error(
        `ApiKeyQueryAuth: env var '${envName}' is not set or empty.`,
      );
    }

    if (typeof config["param"] !== "string") {
      throw new Error("ApiKeyQueryAuth: 'param' config field is required.");
    }

    const invalidateOn = invalidateOnFromConfig(config, [401]);

    return new ApiKeyQueryAuth(envVal, config["param"], invalidateOn);
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    return { queryParams: { [this.param]: this.token } };
  }

  async invalidate(): Promise<void> {}

  isRejection(statusCode: number, _body: unknown): boolean {
    return this.invalidateOn.has(statusCode);
  }
}
