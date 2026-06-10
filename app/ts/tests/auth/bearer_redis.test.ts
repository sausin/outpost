import { describe, test, expect, beforeEach } from "vitest";
import { BearerRedisAuth } from "../../src/auth/modules/bearer_redis.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";
import type { AuthDeps } from "../../src/auth/types.ts";
import type { AuthContext } from "../../src/core/types.ts";

function fakeCtx(): AuthContext {
  return {
    method: "GET",
    fullPath: "/v1/test",
    queryString: "",
    body: null,
    headers: new Headers(),
  };
}

function makeDeps(
  storage: InMemoryStorage,
  env: Record<string, string> = {},
): AuthDeps {
  return {
    env: {
      DEFAULT_PROVIDER: "",
      PROVIDERS_DIR: "",
      HOSTS_CONFIG_PATH: "",
      PROXY_PORT: "",
      LOG_LEVEL: "",
      ...env,
    },
    tokenStorage: storage,
  };
}

describe("BearerRedisAuth", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  test("reads token from storage via redis_key", async () => {
    await storage.set("my:token", "stored_token_xyz");
    const auth = BearerRedisAuth.fromConfig(
      { redis_key: "my:token" },
      makeDeps(storage),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer stored_token_xyz");
  });

  test("seeds from env_seed when storage is empty", async () => {
    const auth = BearerRedisAuth.fromConfig(
      { redis_key: "my:token", env_seed: "SEED_VAR" },
      makeDeps(storage, { SEED_VAR: "seeded_token" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer seeded_token");
    // Confirm seeded value was written to storage
    expect(await storage.get("my:token")).toBe("seeded_token");
  });

  test("invalidate deletes the redis_key from storage", async () => {
    await storage.set("my:token", "tok");
    const auth = BearerRedisAuth.fromConfig(
      { redis_key: "my:token" },
      makeDeps(storage),
    );
    await auth.invalidate();
    expect(await storage.get("my:token")).toBeNull();
  });

  test("isRejection(401) returns true by default", () => {
    const auth = BearerRedisAuth.fromConfig(
      { redis_key: "k" },
      makeDeps(storage),
    );
    expect(auth.isRejection(401, null)).toBe(true);
    expect(auth.isRejection(200, null)).toBe(false);
  });

  test("isRejection on body code via json_path", () => {
    const auth = BearerRedisAuth.fromConfig(
      {
        redis_key: "k",
        invalidate_on_body_codes: {
          json_path: "error.code",
          codes: ["TOKEN_EXPIRED", "INVALID_TOKEN"],
        },
      },
      makeDeps(storage),
    );
    expect(auth.isRejection(200, { error: { code: "TOKEN_EXPIRED" } })).toBe(
      true,
    );
    expect(auth.isRejection(200, { error: { code: "SOME_OTHER_ERROR" } })).toBe(
      false,
    );
  });

  test("apply includes injected token in the configured header", async () => {
    await storage.set("groww:tok", "access123");
    const auth = BearerRedisAuth.fromConfig(
      { redis_key: "groww:tok", header: "X-Groww-Token", prefix: "" },
      makeDeps(storage),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["X-Groww-Token"]).toBe("access123");
  });
});
