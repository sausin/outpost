/**
 * GenericProvider — runtime instance built from a ProviderDef.
 * Mirrors app/providers/provider.py exactly.
 *
 * The proxy calls:
 *   provider.isDenied(path)           → boolean
 *   provider.classify(method, path)   → ClassifiedRoute | null
 *   provider.windowsFor(category)     → WindowLimit[]
 *   provider.auth                     → AuthModule
 */

import type { ProviderDef } from "./schema.ts";
import type { ClassifiedRoute, WindowLimit } from "../core/types.ts";
import { compileRule, matches, type CompiledRule } from "../core/pathmatch.ts";
import type { AuthModule } from "../auth/types.ts";

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

interface AllowMeta {
  category: string;
  cacheTtl: number;
  sensitive: boolean;
  rawPattern: string;
}

export class GenericProvider {
  readonly name: string;
  readonly baseUrl: string;
  readonly defaultHeaders: Record<string, string>;
  readonly stripResponseHeaders: Set<string>;
  readonly auth: AuthModule;

  private readonly allow: Array<{ rule: CompiledRule; meta: AllowMeta }>;
  private readonly deny: CompiledRule[];
  private readonly rateLimits: Record<string, WindowLimit[]>;
  private readonly def: ProviderDef;

  constructor(def: ProviderDef, auth: AuthModule) {
    this.def = def;
    this.name = def.name;
    this.baseUrl = def.base_url;
    this.defaultHeaders = { ...def.default_headers };
    this.stripResponseHeaders = new Set(
      def.strip_response_headers.map((h) => h.toLowerCase()),
    );
    this.auth = auth;

    this.allow = def.forwarding.allow.map((r) => ({
      rule: compileRule(r.method, r.pattern),
      meta: {
        category: r.category,
        cacheTtl: r.cache_ttl,
        sensitive: r.sensitive,
        rawPattern: r.pattern,
      },
    }));

    this.deny = def.forwarding.deny.map((p) => compileRule("*", p));

    this.rateLimits = {};
    for (const [cat, windows] of Object.entries(def.forwarding.rate_limits)) {
      this.rateLimits[cat] = windows.map((w) => ({
        capacity: w.capacity,
        windowMs: w.window_ms,
      }));
    }
  }

  isDenied(path: string): boolean {
    return this.deny.some((r) => matches(r, "*", path));
  }

  classify(method: string, path: string): ClassifiedRoute | null {
    if (this.isDenied(path)) return null;

    const m = method.toUpperCase();
    const fwd = this.def.forwarding;

    if (fwd.mode === "allowlist") {
      for (const { rule, meta } of this.allow) {
        if (matches(rule, m, path)) {
          return {
            category: meta.category,
            cacheTtl: meta.cacheTtl,
            sensitive: meta.sensitive,
            rawPattern: meta.rawPattern,
          };
        }
      }
      return null;
    }

    // transparent mode — all non-denied paths pass through
    const isWrite = WRITE_METHODS.has(m);
    return {
      category: fwd.default_category,
      cacheTtl: isWrite ? 0 : fwd.default_cache_ttl,
      sensitive: isWrite && fwd.treat_writes_as_sensitive,
      rawPattern: null,
    };
  }

  windowsFor(category: string): WindowLimit[] {
    return this.rateLimits[category] ?? this.rateLimits["default"] ?? [];
  }
}
