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

import { ProviderSchema } from "./schema.ts";
import type { ProviderDef } from "./schema.ts";

export interface ProviderLoadResult {
  providers: Map<string, ProviderDef>;
}

/**
 * Parse and validate a list of {name, content} YAML sources.
 * This is the shared core used by both entry-points.
 */
export async function loadProvidersFromYamls(
  sources: Array<{ name: string; content: string }>,
): Promise<ProviderLoadResult> {
  const byName = new Map<string, ProviderDef>();

  for (const { name: sourceName, content } of sources) {
    let def: ProviderDef;
    try {
      const raw = yaml.load(content);
      def = ProviderSchema.parse(raw);
    } catch (err) {
      console.error(
        `[loader] Failed to parse provider YAML '${sourceName}': ${err}`,
      );
      continue;
    }

    if (!def.enabled) {
      console.info(
        `[loader] Provider '${def.name}' is disabled (source=${sourceName}); skipping`,
      );
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
  }

  return { providers: byName };
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
    console.warn(
      `[loader] Providers dir does not exist or is not readable: ${dir} — ${err}`,
    );
    return { providers: new Map() };
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
