/**
 * Config file watcher (Node only) — the equivalent of Traefik's
 * `--providers.file.watch=true`.
 *
 * Watches the providers directory, the directory holding hosts.yaml and, when
 * one is given, the plugins directory, and fires `onChange` once per burst of
 * edits. Two detection mechanisms feed the
 * same debounce, because neither is enough alone:
 *
 *   - `fs.watch` (inotify): instant, and works for a bind-mounted dataset
 *     edited on the host or over SMB/NFS via the host — the kernel is shared.
 *     It cannot see writes that happen on another machine's kernel (a volume
 *     served over NFS *into* the container), and it can be unavailable.
 *   - A slow poll of mtimes/sizes: catches everything inotify misses, at the
 *     cost of latency. Cheap — one readdir and a handful of stats.
 *
 * Reloads are serialised: a change that arrives while `onChange` is running
 * queues exactly one more run, so a burst of saves never overlaps reloads.
 */

import { existsSync, watch as fsWatch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface WatchOptions {
  /** Directory scanned for provider YAMLs. */
  providersDir: string;
  /** The hosts.yaml path. Its parent directory is what gets watched. */
  hostsFile: string;
  /** Runtime plugins directory; watched only while it exists. */
  pluginsDir?: string;
  onChange: () => Promise<void> | void;
  /** Quiet period after the last event before `onChange` runs. */
  debounceMs?: number;
  /** Interval of the mtime poll fallback; 0 disables it. */
  pollMs?: number;
  log?: (msg: string) => void;
}

export interface ConfigWatcher {
  close(): void;
  /** Force a change notification (same path as a real event; debounced). */
  trigger(): void;
}

const PROVIDER_EXTENSIONS = [".yaml", ".yml"];
const PLUGIN_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts"];

function hasExtension(file: string, extensions: string[]): boolean {
  return extensions.some((ext) => file.endsWith(ext));
}

/**
 * Fingerprint of everything a reload would read: hosts.yaml, every YAML in
 * the providers dir and every plugin file in the plugins dir, by mtime and
 * size. Missing files are part of the fingerprint too (deleting example.yaml
 * is a change).
 */
export async function configFingerprint(
  providersDir: string,
  hostsFile: string,
  pluginsDir?: string,
): Promise<string> {
  const parts: string[] = [];
  const describe = async (file: string): Promise<string> => {
    try {
      const s = await stat(file);
      return `${file}:${s.mtimeMs}:${s.size}`;
    } catch {
      return `${file}:missing`;
    }
  };
  const describeDir = async (
    dir: string,
    extensions: string[],
  ): Promise<void> => {
    try {
      const entries = (await readdir(dir))
        .filter((f) => hasExtension(f, extensions))
        .sort();
      for (const f of entries) {
        parts.push(await describe(path.join(dir, f)));
      }
    } catch {
      parts.push(`${dir}:missing`);
    }
  };
  parts.push(await describe(hostsFile));
  await describeDir(providersDir, PROVIDER_EXTENSIONS);
  if (pluginsDir) await describeDir(pluginsDir, PLUGIN_EXTENSIONS);
  return parts.join("\n");
}

export function watchConfig(opts: WatchOptions): ConfigWatcher {
  const debounceMs = opts.debounceMs ?? 500;
  const pollMs = opts.pollMs ?? 15_000;
  const log = opts.log ?? ((msg: string) => console.info(`[watch] ${msg}`));

  let closed = false;
  let debounce: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;

  const run = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await opts.onChange();
    } catch (err) {
      log(`reload handler threw: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
      if (pending && !closed) {
        pending = false;
        void run();
      }
    }
  };

  const trigger = (): void => {
    if (closed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void run();
    }, debounceMs);
    debounce.unref();
  };

  // ── inotify ───────────────────────────────────────────────────────────────
  const watchers: FSWatcher[] = [];
  const dirs = new Set([
    path.resolve(opts.providersDir),
    path.resolve(path.dirname(opts.hostsFile)),
  ]);
  // Most installs have no plugins directory at all; only watch it when it is
  // there, and let the poll (whose fingerprint covers it) catch its creation.
  if (opts.pluginsDir && existsSync(opts.pluginsDir)) {
    dirs.add(path.resolve(opts.pluginsDir));
  }
  for (const dir of dirs) {
    try {
      const w = fsWatch(dir, { persistent: false }, () => trigger());
      w.on("error", (err) => log(`fs.watch on ${dir} failed: ${err.message}`));
      watchers.push(w);
    } catch (err) {
      log(
        `fs.watch unavailable for ${dir} (${err instanceof Error ? err.message : err}) — relying on polling`,
      );
    }
  }

  // ── poll fallback ─────────────────────────────────────────────────────────
  let poll: NodeJS.Timeout | null = null;
  if (pollMs > 0) {
    let last: string | null = null;
    const tick = async (): Promise<void> => {
      if (closed) return;
      try {
        const fp = await configFingerprint(
          opts.providersDir,
          opts.hostsFile,
          opts.pluginsDir,
        );
        if (last !== null && fp !== last) trigger();
        last = fp;
      } catch {
        // stat errors are already folded into the fingerprint; nothing to do.
      }
    };
    void tick();
    poll = setInterval(() => void tick(), pollMs);
    poll.unref();
  }

  log(
    `watching ${[...dirs].join(", ")} (debounce ${debounceMs} ms, poll ${pollMs > 0 ? `${pollMs} ms` : "off"})`,
  );

  return {
    trigger,
    close(): void {
      closed = true;
      if (debounce) clearTimeout(debounce);
      if (poll) clearInterval(poll);
      for (const w of watchers) w.close();
    },
  };
}
