import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";
import { invalidateOnFromConfig } from "../types.ts";

/**
 * Subset of JSONPath: dotted segments, optional [] suffix for array scatter.
 * e.g. "errors[].errorCode" → collect every errorCode from the errors array.
 * Returns a flat list of leaf values.
 */
function walkPath(body: unknown, path: string): unknown[] {
  if (body === null || body === undefined) return [];
  let nodes: unknown[] = [body];
  for (const segment of path.split(".")) {
    const nextNodes: unknown[] = [];
    if (segment.endsWith("[]")) {
      const key = segment.slice(0, -2);
      for (const n of nodes) {
        if (n !== null && typeof n === "object" && !Array.isArray(n)) {
          const record = n as Record<string, unknown>;
          if (key in record) {
            const v = record[key];
            if (Array.isArray(v)) {
              nextNodes.push(...v);
            }
          }
        }
      }
    } else {
      for (const n of nodes) {
        if (n !== null && typeof n === "object" && !Array.isArray(n)) {
          const record = n as Record<string, unknown>;
          if (segment in record) {
            nextNodes.push(record[segment]);
          }
        }
      }
    }
    nodes = nextNodes;
  }
  return nodes;
}

export class BearerRedisAuth implements AuthModule {
  static readonly typeName = "bearer_redis";

  private constructor(
    private readonly deps: AuthDeps,
    private readonly redisKey: string,
    private readonly envSeed: string | null,
    private readonly header: string,
    private readonly prefix: string,
    private readonly invalidateOn: Set<number>,
    private readonly bodyJsonPath: string | null,
    private readonly bodyCodes: Set<string>,
  ) {}

  static fromConfig(
    config: Record<string, unknown>,
    deps: AuthDeps,
  ): BearerRedisAuth {
    const redisKey = config["redis_key"];
    if (typeof redisKey !== "string" || !redisKey) {
      throw new Error(
        "BearerRedisAuth: 'redis_key' must be a non-empty string.",
      );
    }

    const envSeed =
      typeof config["env_seed"] === "string" ? config["env_seed"] : null;
    const header =
      typeof config["header"] === "string" ? config["header"] : "Authorization";
    const prefix =
      typeof config["prefix"] === "string" ? config["prefix"] : "Bearer ";
    const invalidateOn = invalidateOnFromConfig(config, [401]);

    let bodyJsonPath: string | null = null;
    let bodyCodes: Set<string> = new Set();
    const bodyCodesCfg = config["invalidate_on_body_codes"];
    if (
      bodyCodesCfg !== null &&
      bodyCodesCfg !== undefined &&
      typeof bodyCodesCfg === "object" &&
      !Array.isArray(bodyCodesCfg)
    ) {
      const cfg = bodyCodesCfg as Record<string, unknown>;
      if (typeof cfg["json_path"] === "string") {
        bodyJsonPath = cfg["json_path"];
      }
      if (Array.isArray(cfg["codes"])) {
        bodyCodes = new Set(
          (cfg["codes"] as unknown[])
            .filter(
              (v): v is string | number =>
                typeof v === "string" || typeof v === "number",
            )
            .map(String),
        );
      }
    }

    return new BearerRedisAuth(
      deps,
      redisKey,
      envSeed,
      header,
      prefix,
      invalidateOn,
      bodyJsonPath,
      bodyCodes,
    );
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    let raw = await this.deps.tokenStorage.get(this.redisKey);

    if (!raw && this.envSeed) {
      const seed = this.deps.env[this.envSeed];
      if (typeof seed === "string" && seed) {
        // Seed into storage; no TTL — operator owns lifecycle.
        await this.deps.tokenStorage.set(this.redisKey, seed);
        raw = seed;
      }
    }

    if (!raw) {
      throw new Error(
        `BearerRedisAuth: token not configured at redis_key=${JSON.stringify(this.redisKey)}.`,
      );
    }

    return { headers: { [this.header]: `${this.prefix}${raw}` } };
  }

  async invalidate(): Promise<void> {
    await this.deps.tokenStorage.delete(this.redisKey);
  }

  isRejection(statusCode: number, body: unknown): boolean {
    if (this.invalidateOn.has(statusCode)) return true;
    if (this.bodyJsonPath && body !== null && body !== undefined) {
      const leaves = walkPath(body, this.bodyJsonPath);
      for (const leaf of leaves) {
        if (this.bodyCodes.has(String(leaf))) return true;
      }
    }
    return false;
  }
}
