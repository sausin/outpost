import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";
import { invalidateOnFromConfig } from "../types.ts";

export class BearerStaticAuth implements AuthModule {
  static readonly typeName = "bearer_static";

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
  ): BearerStaticAuth {
    let token: string;

    if (typeof config["value"] === "string" && config["value"]) {
      token = config["value"];
    } else if (typeof config["env"] === "string") {
      const envName = config["env"];
      const envVal = deps.env[envName];
      if (typeof envVal !== "string" || !envVal) {
        throw new Error(
          `BearerStaticAuth: env var '${envName}' is not set or empty.`,
        );
      }
      token = envVal;
    } else {
      throw new Error("BearerStaticAuth: config must have 'env' or 'value'.");
    }

    const header =
      typeof config["header"] === "string" ? config["header"] : "Authorization";
    const prefix =
      typeof config["prefix"] === "string" ? config["prefix"] : "Bearer ";
    const invalidateOn = invalidateOnFromConfig(config, [401]);

    return new BearerStaticAuth(token, header, prefix, invalidateOn);
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    return { headers: { [this.header]: `${this.prefix}${this.token}` } };
  }

  async invalidate(): Promise<void> {}

  isRejection(statusCode: number, _body: unknown): boolean {
    return this.invalidateOn.has(statusCode);
  }
}
