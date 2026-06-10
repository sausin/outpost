import { PLUGIN_REGISTRY } from "../../plugins/registry.ts";
import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthDeps, AuthModule } from "../types.ts";

/**
 * Static-registry plugin loader.
 *
 * Bundled targets (Cloudflare Workers, the Node tsup bundle) cannot resolve
 * dynamic `import(variablePath)` — esbuild needs all imports statically.
 * So we keep an explicit `PLUGIN_REGISTRY` of known plugin classes in
 * `src/plugins/registry.ts`, and look up by the YAML's `module_ts:` (or
 * `module:` for Python-only YAMLs) string key.
 *
 * Adding a new plugin: drop the file in `src/plugins/`, import + register it
 * in `src/plugins/registry.ts`, then reference the registry key from YAML.
 *
 * Config:
 *   module:    "<python-dotted-path>:Class"    (Python runtime reads this)
 *   module_ts: "<ts-registry-key>:Class"       (TS runtime reads this — prefer)
 *   config:    { ... }   forwarded to inner.fromConfig()
 */
export class PluginAuth implements AuthModule {
  static readonly typeName = "plugin";

  private constructor(private readonly inner: AuthModule) {}

  static async fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): Promise<PluginAuth> {
    // Prefer the TS-specific override; fall back to the shared `module:` key.
    const moduleSpec = config["module_ts"] ?? config["module"];
    if (typeof moduleSpec !== "string" || !moduleSpec.includes(":")) {
      throw new Error(
        `PluginAuth: 'module' (or 'module_ts') must be 'registry-key:ClassName', got ${JSON.stringify(moduleSpec)}.`,
      );
    }

    const factory = PLUGIN_REGISTRY[moduleSpec];
    if (!factory) {
      throw new Error(
        `PluginAuth: unknown plugin '${moduleSpec}'. ` +
          `Registered plugins: ${Object.keys(PLUGIN_REGISTRY).sort().join(", ") || "(none)"}. ` +
          `Add new plugins to app/ts/src/plugins/registry.ts.`,
      );
    }

    const innerConfig =
      config["config"] !== null &&
      config["config"] !== undefined &&
      typeof config["config"] === "object" &&
      !Array.isArray(config["config"])
        ? (config["config"] as Record<string, unknown>)
        : {};

    let inner: AuthModule;
    try {
      inner = await factory.fromConfig(innerConfig, deps);
    } catch (err) {
      throw new Error(
        `PluginAuth: '${moduleSpec}'.fromConfig() failed: ${String(err)}`,
      );
    }

    return new PluginAuth(inner);
  }

  async apply(ctx: AuthContext): Promise<AuthResult> {
    return await this.inner.apply(ctx);
  }

  async invalidate(): Promise<void> {
    await this.inner.invalidate();
  }

  isRejection(statusCode: number, body: unknown): boolean {
    return this.inner.isRejection(statusCode, body);
  }
}
