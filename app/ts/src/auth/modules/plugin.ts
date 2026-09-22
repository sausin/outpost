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
 * Adding a bundled plugin: drop the file in `src/plugins/`, import + register
 * it in `src/plugins/registry.ts`, then reference the registry key from YAML.
 *
 * On Node there is a second path: a reference the registry does not know is
 * handed to `deps.loadPlugin` (src/plugins/file_loader.ts), which imports it
 * from the plugins directory at runtime — no rebuild. Workers has no loader,
 * so there the registry is the whole story.
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

    let factory = PLUGIN_REGISTRY[moduleSpec];
    if (!factory && deps.loadPlugin) {
      try {
        factory = await deps.loadPlugin(moduleSpec);
      } catch (err) {
        throw new Error(
          `PluginAuth: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

    // Mirrors Python's `isinstance(inner, AuthModule)` protocol check: a file
    // plugin is untyped, so make sure it actually is an auth module before the
    // first request finds out.
    for (const method of ["apply", "invalidate", "isRejection"] as const) {
      if (typeof (inner as Partial<AuthModule>)?.[method] !== "function") {
        throw new Error(
          `PluginAuth: '${moduleSpec}'.fromConfig() returned an object without ${method}(); an auth module needs apply(), invalidate() and isRejection().`,
        );
      }
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
