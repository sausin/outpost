import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { GrowwApprovalMintAuth } from "../../src/plugins/groww_approval_mint.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";
import type { AuthDeps } from "../../src/auth/types.ts";
import type { AuthContext } from "../../src/core/types.ts";

const FIXED_TS_MS = 1_700_000_000_000;
const FIXED_TS_S = Math.floor(FIXED_TS_MS / 1000).toString(); // "1700000000"

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
      GROWW_API_SECRET: "super_secret",
      ...env,
    },
    tokenStorage: storage,
  };
}

function fakeCtx(): AuthContext {
  return {
    method: "POST",
    fullPath: "/v1/token/api/access",
    queryString: "",
    body: null,
    headers: new Headers(),
  };
}

describe("GrowwApprovalMintAuth — checksum", () => {
  afterEach(() => vi.restoreAllMocks());

  test("checksum is sha256(secret + timestamp) and sent in POST body", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED_TS_MS);
    const storage = new InMemoryStorage();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "approval_tok" }), { status: 200 }),
    );

    const auth = GrowwApprovalMintAuth.fromConfig({}, makeDeps(storage));
    await auth.apply(fakeCtx());

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      key_type: string;
      checksum: string;
      timestamp: string;
    };

    // Compute expected checksum independently
    const expectedInput = "super_secret" + FIXED_TS_S;
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(expectedInput),
    );
    const expectedChecksum = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    expect(sentBody.key_type).toBe("approval");
    expect(sentBody.checksum).toBe(expectedChecksum);
    expect(sentBody.timestamp).toBe(FIXED_TS_S);
  });
});

describe("GrowwApprovalMintAuth — token caching", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.spyOn(Date, "now").mockReturnValue(FIXED_TS_MS);
  });

  afterEach(() => vi.restoreAllMocks());

  test("first call mints and caches the token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "approval_minted" }), {
        status: 200,
      }),
    );
    const auth = GrowwApprovalMintAuth.fromConfig({}, makeDeps(storage));
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer approval_minted");
    expect(await storage.get("groww:token")).toBe("approval_minted");
  });

  test("invalidate clears the token from storage", async () => {
    await storage.set("groww:token", "old");
    const auth = GrowwApprovalMintAuth.fromConfig({}, makeDeps(storage));
    await auth.invalidate();
    expect(await storage.get("groww:token")).toBeNull();
  });

  test("missing api_key env var throws a clear error", () => {
    const deps = makeDeps(storage, { GROWW_API_KEY: "" });
    expect(() => GrowwApprovalMintAuth.fromConfig({}, deps)).toThrow(
      /api_key env var not set/,
    );
  });

  test("missing api_secret env var throws a clear error", () => {
    const deps = makeDeps(storage, { GROWW_API_SECRET: "" });
    expect(() => GrowwApprovalMintAuth.fromConfig({}, deps)).toThrow(
      /api_secret env var not set/,
    );
  });
});
