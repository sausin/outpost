/**
 * File-based plugin loader (Node only).
 *
 * The static PLUGIN_REGISTRY covers plugins compiled into the bundle, which is
 * the only option on Cloudflare Workers. On Node the bundle can still
 * `import()` a file by path at runtime, so an operator running the container
 * image can add an auth scheme without rebuilding it: drop a JavaScript module
 * into the plugins directory (OUTPOST_PLUGINS_DIR, `/config/plugins` in the
 * image) and reference it from the provider YAML as
 *
 *   auth:
 *     type: plugin
 *     module_ts: my_auth.mjs:MyAuth
 *     config: { ... }
 *
 * The file part is resolved relative to the plugins directory and must stay
 * inside it. The export must be a class (or object) with a static
 * `fromConfig(config, deps)` returning an AuthModule — the same contract as a
 * bundled plugin; see src/auth/types.ts.
 *
 * Reloads: the import URL carries the file's mtime as a query string, so an
 * edited plugin is re-imported on the next config reload instead of being
 * served from the ESM module cache.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AuthModuleConstructor, PluginLoader } from "../auth/types.ts";

/** Extensions Node can import natively (`.ts` needs Node 22.18+ type stripping). */
export const PLUGIN_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts"];

export interface FilePluginLoaderOptions {
  /** Directory the `module_ts:` file part is resolved against. */
  dir: string;
}

/** Split `<file>:<Export>` on the last colon. */
export function parsePluginSpec(spec: string): {
  file: string;
  exportName: string;
} {
  const i = spec.lastIndexOf(":");
  if (i <= 0 || i === spec.length - 1) {
    throw new Error(
      `plugin reference must be '<file>:<ExportName>', got ${JSON.stringify(spec)}`,
    );
  }
  return { file: spec.slice(0, i), exportName: spec.slice(i + 1) };
}

/**
 * Resolve `file` inside `dir`; throws when the result would escape it.
 * Exported for tests.
 */
export function resolvePluginPath(dir: string, file: string): string {
  const root = path.resolve(dir);
  if (path.isAbsolute(file)) {
    throw new Error(
      `plugin path must be relative to the plugins directory ${root}, got ${file}`,
    );
  }
  const resolved = path.resolve(root, file);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `plugin path ${file} escapes the plugins directory ${root}`,
    );
  }
  if (!PLUGIN_EXTENSIONS.includes(path.extname(resolved))) {
    throw new Error(
      `plugin file ${file} must end in ${PLUGIN_EXTENSIONS.join(", ")}`,
    );
  }
  return resolved;
}

export function makeFilePluginLoader(
  opts: FilePluginLoaderOptions,
): PluginLoader {
  const root = path.resolve(opts.dir);

  return async (spec: string): Promise<AuthModuleConstructor> => {
    const { file, exportName } = parsePluginSpec(spec);
    const resolved = resolvePluginPath(root, file);

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(resolved)).mtimeMs;
    } catch {
      throw new Error(
        `plugin file ${file} not found in the plugins directory ${root}`,
      );
    }

    const url = pathToFileURL(resolved);
    url.searchParams.set("v", String(mtimeMs));

    let mod: Record<string, unknown>;
    try {
      mod = (await import(/* @vite-ignore */ url.href)) as Record<
        string,
        unknown
      >;
    } catch (err) {
      throw new Error(
        `plugin file ${file} failed to import: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const candidate = mod[exportName];
    if (
      candidate === null ||
      (typeof candidate !== "function" && typeof candidate !== "object") ||
      typeof (candidate as { fromConfig?: unknown }).fromConfig !== "function"
    ) {
      const exported = Object.keys(mod).sort().join(", ") || "(nothing)";
      throw new Error(
        `export '${exportName}' of plugin file ${file} is not an auth module — expected a class with a static fromConfig(config, deps); the file exports: ${exported}`,
      );
    }
    return candidate as AuthModuleConstructor;
  };
}
