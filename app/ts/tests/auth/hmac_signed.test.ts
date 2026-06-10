import { describe, test, expect, vi, afterEach } from "vitest";
import { HmacSignedAuth } from "../../src/auth/modules/hmac_signed.ts";
import type { AuthDeps } from "../../src/auth/types.ts";
import type { AuthContext } from "../../src/core/types.ts";

function makeDeps(env: Record<string, string> = {}): AuthDeps {
  return {
    env: {
      DEFAULT_PROVIDER: "",
      PROVIDERS_DIR: "",
      HOSTS_CONFIG_PATH: "",
      PROXY_PORT: "",
      LOG_LEVEL: "",
      ...env,
    },
    tokenStorage: {} as never,
  };
}

function fakeCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    method: "GET",
    fullPath: "/api/v3/order",
    queryString: "symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1",
    body: null,
    headers: new Headers(),
    ...overrides,
  };
}

describe("HmacSignedAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("query payload mode produces correct HMAC-SHA256 signature", async () => {
    // Known fixture: Binance-style HMAC sign
    // secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j"
    // query = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559"
    // expected sig (SHA-256 HMAC hex) = "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71"
    const secret =
      "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const timestamp = "1499827319559";
    const query =
      "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000";

    // Pin Date.now() so timestamp param is fixed
    vi.spyOn(Date, "now").mockReturnValue(Number(timestamp));

    const auth = HmacSignedAuth.fromConfig(
      {
        key_env: "API_KEY",
        secret_env: "API_SECRET",
        payload: "query",
        timestamp_param: "timestamp",
        signature_param: "signature",
      },
      makeDeps({ API_KEY: "vmPUZE6mv9SD5VNHk4HlbA1111", API_SECRET: secret }),
    );

    const result = await auth.apply(fakeCtx({ queryString: query }));
    expect(result.queryParams?.["signature"]).toBe(
      "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71",
    );
    // API key header injected
    expect(result.headers?.["X-MBX-APIKEY"]).toBe("vmPUZE6mv9SD5VNHk4HlbA1111");
  });

  test("body payload mode signs the body bytes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const bodyText = '{"side":"BUY"}';
    const bodyBuffer = new TextEncoder().encode(bodyText).buffer as ArrayBuffer;

    const auth = HmacSignedAuth.fromConfig(
      {
        key_env: "K",
        secret_env: "S",
        payload: "body",
        signature_header: "X-Signature",
        timestamp_header: "X-Timestamp",
      },
      makeDeps({ K: "apikey", S: "mysecret" }),
    );
    const result = await auth.apply(fakeCtx({ body: bodyBuffer }));
    // Signature should be a 64-char hex string (SHA-256)
    expect(result.headers?.["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.headers?.["X-Timestamp"]).toBe("1000");
  });

  test("signature in header when signature_header is configured", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const auth = HmacSignedAuth.fromConfig(
      {
        key_env: "K",
        secret_env: "S",
        payload: "query",
        signature_header: "X-Sig",
        timestamp_param: "ts",
      },
      makeDeps({ K: "k", S: "s" }),
    );
    const result = await auth.apply(fakeCtx({ queryString: "a=1" }));
    expect(result.headers?.["X-Sig"]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.queryParams?.["signature"]).toBeUndefined();
  });

  test("SHA-512 digest produces a 128-char hex signature", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const auth = HmacSignedAuth.fromConfig(
      { key_env: "K", secret_env: "S", payload: "query", digest: "sha512" },
      makeDeps({ K: "k", S: "s" }),
    );
    const result = await auth.apply(fakeCtx({ queryString: "x=1" }));
    expect(result.queryParams?.["signature"]).toMatch(/^[0-9a-f]{128}$/);
  });

  test("API key header is set on every apply call", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const auth = HmacSignedAuth.fromConfig(
      { key_env: "K", secret_env: "S", payload: "query" },
      makeDeps({ K: "myapikey", S: "secret" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["X-MBX-APIKEY"]).toBe("myapikey");
  });
});
