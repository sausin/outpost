/**
 * Provider loader — scans a directory (or receives pre-loaded YAML strings) for
 * *.yaml / *.yml provider definitions, validates via ProviderSchema, and returns
 * the enabled set keyed by name.  Later files with the same provider name override
 * earlier ones (same behaviour as the Python implementation).
 *
 * Two entry-points:
 *   loadProvidersFromDir   — Node.js path; reads from the filesystem.
 *   loadProvidersFromYamls — runtime-agnostic; Workers bundles YAMLs at build time.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import yaml from "js-yaml";
import { ZodError } from "zod";

import { inlineProviderSources, PROVIDERS_VAR } from "../config/inline.ts";
import type { ConfigProblem } from "../core/types.ts";
import { ProviderSchema } from "./schema.ts";
import type { ProviderDef } from "./schema.ts";

/** One line per problem — `base_url: Invalid url` — instead of zod's JSON dump. */
function describeParseError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

export interface ProviderLoadResult {
  providers: Map<string, ProviderDef>;
  /** Sources that failed to parse or validate — logged, skipped, and shown on the status page. */
  problems: ConfigProblem[];
  /** Providers present on disk but `enabled: false`. */
  disabled: Array<{ name: string; source: string }>;
  /** Where each loaded provider was defined (file name or OUTPOST_PROVIDERS). */
  sources: Map<string, string>;
}

/**
 * Parse and validate a list of {name, content} YAML sources.
 * This is the shared core used by both entry-points.
 */
export async function loadProvidersFromYamls(
  sources: Array<{ name: string; content: string }>,
): Promise<ProviderLoadResult> {
  const byName = new Map<string, ProviderDef>();
  const problems: ConfigProblem[] = [];
  const disabled: Array<{ name: string; source: string }> = [];
  const sourceOf = new Map<string, string>();

  for (const { name: sourceName, content } of sources) {
    let def: ProviderDef;
    try {
      const raw = yaml.load(content);
      def = ProviderSchema.parse(raw);
    } catch (err) {
      const message = describeParseError(err);
      console.error(
        `[loader] Failed to parse provider YAML '${sourceName}': ${message}`,
      );
      problems.push({ scope: "provider", source: sourceName, message });
      continue;
    }

    if (!def.enabled) {
      console.info(
        `[loader] Provider '${def.name}' is disabled (source=${sourceName}); skipping`,
      );
      disabled.push({ name: def.name, source: sourceName });
      continue;
    }

    if (byName.has(def.name)) {
      console.info(
        `[loader] Provider '${def.name}' overridden by source '${sourceName}'`,
      );
    } else {
      console.info(
        `[loader] Loaded provider '${def.name}' from '${sourceName}'`,
      );
    }

    byName.set(def.name, def);
    sourceOf.set(def.name, sourceName);
  }

  return { providers: byName, problems, disabled, sources: sourceOf };
}

/**
 * Walk a directory for *.yaml and *.yml files, parse them, return enabled providers.
 * Node.js only — uses node:fs/promises.
 */
export async function loadProvidersFromDir(
  dir: string,
): Promise<ProviderLoadResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const message = `Providers dir does not exist or is not readable: ${dir} — ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[loader] ${message}`);
    return {
      providers: new Map(),
      problems: [{ scope: "config", source: dir, message }],
      disabled: [],
      sources: new Map(),
    };
  }

  const yamlFiles = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort(); // deterministic ordering

  const sources = await Promise.all(
    yamlFiles.map(async (f) => {
      const fullPath = path.join(dir, f);
      const content = await readFile(fullPath, "utf8");
      return { name: f, content };
    }),
  );

  return loadProvidersFromYamls(sources);
}

/**
 * Merge OUTPOST_PROVIDERS (raw env value) on top of an already-loaded set.
 * An inline provider replaces a file provider with the same name — including
 * an inline `enabled: false`, which switches the file's definition off. With
 * the variable unset this returns `base` untouched.
 */
export async function withInlineProviders(
  base: ProviderLoadResult,
  raw: string | undefined,
): Promise<ProviderLoadResult> {
  if (typeof raw !== "string" || raw.trim() === "") return base;

  const { sources, problems: parseProblems } = inlineProviderSources(raw);
  const inline = await loadProvidersFromYamls(sources);

  const providers = new Map(base.providers);
  const sourceOf = new Map(base.sources);
  const overridden = (name: string): void => {
    const from = sourceOf.get(name);
    if (from) {
      console.info(
        `[loader] Provider '${name}' from '${from}' is replaced by ${PROVIDERS_VAR}`,
      );
    }
    providers.delete(name);
    sourceOf.delete(name);
  };

  for (const d of inline.disabled) overridden(d.name);
  for (const [name, def] of inline.providers) {
    overridden(name);
    providers.set(name, def);
    sourceOf.set(name, inline.sources.get(name) ?? PROVIDERS_VAR);
  }

  const inlineNames = new Set([
    ...inline.providers.keys(),
    ...inline.disabled.map((d) => d.name),
  ]);
  return {
    providers,
    sources: sourceOf,
    problems: [...base.problems, ...parseProblems, ...inline.problems],
    disabled: [
      ...base.disabled.filter((d) => !inlineNames.has(d.name)),
      ...inline.disabled,
    ],
  };
}
