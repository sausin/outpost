/**
 * AuthModule interface and shared deps — mirrors app/auth/base.py AuthModule protocol.
 */

import type { AppEnv } from "../core/env.ts";
import type { AuthContext, AuthResult } from "../core/types.ts";
import type { Storage } from "../storage/interface.ts";

export interface AuthModule {
  apply(ctx: AuthContext): Promise<AuthResult>;
  invalidate(): Promise<void>;
  isRejection(statusCode: number, body: unknown): boolean;
}

export interface AuthModuleConstructor {
  fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): AuthModule | Promise<AuthModule>;
  readonly typeName: string;
}

export interface AuthDeps {
  env: AppEnv;
  /** Token cache storage — used by bearer_redis and oauth2; stateless modules ignore it. */
  tokenStorage: Storage;
}

/**
 * Extract the invalidate_on set from a module config dict.
 * Mirrors Python's _invalidate_on_from_config helper.
 */
export function invalidateOnFromConfig(
  config: Record<string, unknown>,
  defaults: number[],
): Set<number> {
  const raw = config["invalidate_on"];
  if (Array.isArray(raw)) {
    return new Set(raw.filter((v): v is number => typeof v === "number"));
  }
  return new Set(defaults);
}
