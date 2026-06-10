import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { GrowwTotpMintAuth } from "../../src/plugins/groww_totp_mint.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";
import type { AuthDeps } from "../../src/auth/types.ts";
import type { AuthContext } from "../../src/core/types.ts";

/**
 * RFC 6238 test vector (Appendix B — SHA-1 TOTP):
 *   seed: "12345678901234567890" (ASCII)
 *   In base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
 *   Time step 59 (T=1), code: "287082"
 */
const RFC_SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_T_SECONDS = 59; // floor(59/30) = 1
const RFC_EXPECTED_CODE = "287082";

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
      GROWW_API_KEY: "gk_test",
      GROWW_TOTP_SEED: RFC_SEED_BASE32,
      ...env,
    },
    tokenStorage: storage,
  };
}

function fakeCtx(): AuthContext {
  return {
    method: "GET",
    fullPath: "/v1/positions",
    queryString: "",
    body: null,
    headers: new Headers(),
  };
}

describe("GrowwTotpMintAuth — TOTP generation", () => {
  test("matches RFC 6238 test vector (SHA-1, 6 digits, step 30)", async () => {
    // We can't call totp() directly (private), so we check it via mint + fetch mock.
    // Freeze time to the RFC vector timestamp.
    vi.spyOn(Date, "now").mockReturnValue(RFC_T_SECONDS * 1000);

    const storage = new InMemoryStorage();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "minted_token" }), { status: 200 }),
    );

    const auth = GrowwTotpMintAuth.fromConfig({}, makeDeps(storage));
    await auth.apply(fakeCtx());

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      key_type: string;
      totp: string;
    };
    expect(sentBody.totp).toBe(RFC_EXPECTED_CODE);

    vi.restoreAllMocks();
  });
});

describe("GrowwTotpMintAuth — token caching", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("first call mints via mocked fetch and caches in storage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "tok_mint_1" }), { status: 200 }),
    );
    const auth = GrowwTotpMintAuth.fromConfig({}, makeDeps(storage));
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer tok_mint_1");
    expect(await storage.get("groww:token")).toBe("tok_mint_1");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  test("cache hit: second apply does not call fetch", async () => {
    await storage.set("groww:token", "cached_tok");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const auth = GrowwTotpMintAuth.fromConfig({}, makeDeps(storage));
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer cached_tok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("invalidate clears the token from storage", async () => {
    await storage.set("groww:token", "old_tok");
    const auth = GrowwTotpMintAuth.fromConfig({}, makeDeps(storage));
    await auth.invalidate();
    expect(await storage.get("groww:token")).toBeNull();
  });

  test("missing api_key env var throws a clear error", () => {
    const deps = makeDeps(storage, { GROWW_API_KEY: "" });
    expect(() => GrowwTotpMintAuth.fromConfig({}, deps)).toThrow(
      /api_key env var not set/,
    );
  });

  test("missing totp_seed env var throws a clear error", () => {
    const deps = makeDeps(storage, { GROWW_TOTP_SEED: "" });
    expect(() => GrowwTotpMintAuth.fromConfig({}, deps)).toThrow(
      /totp_seed env var not set/,
    );
  });
});
