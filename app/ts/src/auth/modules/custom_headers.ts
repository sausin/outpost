import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";
import { invalidateOnFromConfig } from "../types.ts";

export class CustomHeadersAuth implements AuthModule {
  static readonly typeName = "custom_headers";

  // Headers resolved once at construction time.
  private readonly headers: Record<string, string>;
  private readonly invalidateOn: Set<number>;

  private constructor(
    headers: Record<string, string>,
    invalidateOn: Set<number>,
  ) {
    this.headers = headers;
    this.invalidateOn = invalidateOn;
  }

  static fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): CustomHeadersAuth {
    const rawHeaders = config["headers"];
    if (typeof rawHeaders !== "object" || rawHeaders === null) {
      throw new Error(
        "CustomHeadersAuth: 'headers' config field is required and must be an object.",
      );
    }

    const resolved: Record<string, string> = {};

    for (const [headerName, spec] of Object.entries(
      rawHeaders as Record<string, unknown>,
    )) {
      if (typeof spec !== "object" || spec === null) {
        throw new Error(
          `CustomHeadersAuth: header '${headerName}' spec must be an object.`,
        );
      }
      const specObj = spec as Record<string, unknown>;

      if (typeof specObj["value"] === "string") {
        resolved[headerName] = specObj["value"];
      } else if (typeof specObj["env"] === "string") {
        const envName = specObj["env"];
        const val = deps.env[envName];
        if (typeof val !== "string" || !val) {
          throw new Error(
            `CustomHeadersAuth: env var '${envName}' for header '${headerName}' is not set or empty.`,
          );
        }
        resolved[headerName] = val;
      } else {
        throw new Error(
          `CustomHeadersAuth: header '${headerName}' must have 'env' or 'value'.`,
        );
      }
    }

    // Default invalidate_on is empty — custom header injection rarely has a clear rejection signal.
    const invalidateOn = invalidateOnFromConfig(config, []);

    return new CustomHeadersAuth(resolved, invalidateOn);
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    return { headers: { ...this.headers } };
  }

  async invalidate(): Promise<void> {}

  isRejection(statusCode: number, _body: unknown): boolean {
    return this.invalidateOn.has(statusCode);
  }
}
