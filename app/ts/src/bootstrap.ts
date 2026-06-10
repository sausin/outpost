/**
 * Bootstrap helper — turns parsed provider defs + a hosts YAML + storage backends
 * into the AppDeps that buildApp() requires.  Used by both runtime adapters
 * (Node and Workers) so they only differ in how they construct storage and load
 * provider sources.
 */

import { resolve as resolveAuth } from "./auth/registry.ts";
import type { AppEnv } from "./core/env.ts";
import { loadHostsFromYaml } from "./core/hosts.ts";
import type { AppDeps } from "./index.ts";
import { GenericProvider } from "./providers/provider.ts";
import type { ProviderDef } from "./providers/schema.ts";
import type {
  CacheBackend,
  RateLimitBackend,
  Storage,
} from "./storage/interface.ts";

export interface BootstrapInput {
  env: AppEnv;
  defs: Map<string, ProviderDef>;
  hostsYaml: string;
  tokenStorage: Storage;
  cache: CacheBackend;
  rateLimits: RateLimitBackend;
}

/**
 * Build runtime providers from already-parsed defs.  Auth modules that fail to
 * construct (missing env var, invalid plugin path, etc.) are logged and skipped
 * — the proxy boots with the providers that DID succeed, so one broken provider
 * never takes down the whole sidecar.
 */
export async function buildAppDeps(input: BootstrapInput): Promise<AppDeps> {
  const built = new Map<string, GenericProvider>();

  for (const [name, def] of input.defs) {
    try {
      const AuthClass = await resolveAuth(def.auth.type);
      // Strip `type` from the auth block; the rest is passed verbatim to the module.
      const { type: _type, ...authConfig } = def.auth as Record<
        string,
        unknown
      > & { type: string };
      const auth = await AuthClass.fromConfig(authConfig, {
        env: input.env,
        tokenStorage: input.tokenStorage,
      });
      built.set(name, new GenericProvider(def, auth));
      console.info(`[bootstrap] Built provider '${name}'`);
    } catch (err) {
      console.error(`[bootstrap] Failed to build provider '${name}': ${err}`);
    }
  }

  const hosts = loadHostsFromYaml(input.hostsYaml);

  return {
    providers: built,
    hosts,
    rateLimits: input.rateLimits,
    cache: input.cache,
    defaultProvider: input.env.DEFAULT_PROVIDER,
  };
}
