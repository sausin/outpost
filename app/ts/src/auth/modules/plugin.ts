import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";

/**
 * Dynamic plugin loader — delegates to a user-supplied AuthModule class.
 *
 * Security constraint: only modules under `app/ts/src/plugins/` are
 * importable. Paths starting with `../` or absolute paths are rejected.
 *
 * Config:
 *   module: "plugins/groww_totp_mint.ts:GrowwTotpMintAuth"
 *   config: { ... }   ← forwarded to inner.fromConfig()
 */
export class PluginAuth implements AuthModule {
  static readonly typeName = "plugin";

  private constructor(private readonly inner: AuthModule) {}

  static async fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): Promise<PluginAuth> {
    // Dual-impl YAMLs may carry a `module_ts:` override pointing at the TS path
    // alongside `module:` (which carries the Python dotted path). Prefer the
    // TS-specific one when present; otherwise fall back to `module`.
    const moduleSpec = config["module_ts"] ?? config["module"];
    if (typeof moduleSpec !== "string" || !moduleSpec.includes(":")) {
      throw new Error(
        `PluginAuth: 'module' (or 'module_ts') must be 'path/to/mod.ts:ClassName', got ${JSON.stringify(moduleSpec)}.`,
      );
    }

    const colonIdx = moduleSpec.indexOf(":");
    const modulePath = moduleSpec.slice(0, colonIdx);
    const className = moduleSpec.slice(colonIdx + 1);

    // Security: reject relative traversal and absolute paths.
    if (modulePath.startsWith("../") || modulePath.startsWith("/")) {
      throw new Error(
        `PluginAuth: module path '${modulePath}' is not allowed. Only paths under plugins/ are importable.`,
      );
    }
    if (!modulePath.startsWith("plugins/")) {
      throw new Error(
        `PluginAuth: module path '${modulePath}' must start with 'plugins/'.`,
      );
    }

    let mod: Record<string, unknown>;
    try {
      // Dynamic import relative to this file's location (src/auth/modules/).
      // Plugins live at src/plugins/, so we go up two levels.
      mod = (await import(`../../${modulePath}`)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `PluginAuth: cannot import module '${modulePath}': ${String(err)}`,
      );
    }

    const klass = mod[className];
    if (klass === undefined || klass === null) {
      throw new Error(
        `PluginAuth: class '${className}' not found in module '${modulePath}'.`,
      );
    }
    if (typeof klass !== "function") {
      throw new Error(`PluginAuth: '${moduleSpec}' is not a class/function.`);
    }

    const innerConfig =
      config["config"] !== null &&
      config["config"] !== undefined &&
      typeof config["config"] === "object" &&
      !Array.isArray(config["config"])
        ? (config["config"] as Record<string, unknown>)
        : {};

    const factory = klass as {
      fromConfig?: (
        cfg: Record<string, unknown>,
        deps: AuthDeps,
      ) => AuthModule | Promise<AuthModule>;
    };

    if (typeof factory.fromConfig !== "function") {
      throw new Error(
        `PluginAuth: '${moduleSpec}' does not have a static fromConfig() method.`,
      );
    }

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
