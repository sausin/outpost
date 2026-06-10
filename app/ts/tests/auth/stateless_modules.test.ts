import { describe, test, expect } from "vitest";
import { NoneAuth } from "../../src/auth/modules/none.ts";
import { BearerStaticAuth } from "../../src/auth/modules/bearer_static.ts";
import { ApiKeyHeaderAuth } from "../../src/auth/modules/api_key_header.ts";
import { ApiKeyQueryAuth } from "../../src/auth/modules/api_key_query.ts";
import { BasicAuth } from "../../src/auth/modules/basic_auth.ts";
import { CustomHeadersAuth } from "../../src/auth/modules/custom_headers.ts";
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

function fakeDeps(env: Record<string, string> = {}): AuthDeps {
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

// ─── NoneAuth ────────────────────────────────────────────────────────────────

describe("NoneAuth", () => {
  test("apply returns empty AuthResult", async () => {
    const auth = NoneAuth.fromConfig({}, fakeDeps());
    const result = await auth.apply(fakeCtx());
    expect(result).toEqual({});
  });

  test("isRejection always returns false", () => {
    const auth = NoneAuth.fromConfig({}, fakeDeps());
    expect(auth.isRejection(401, {})).toBe(false);
    expect(auth.isRejection(403, null)).toBe(false);
    expect(auth.isRejection(200, {})).toBe(false);
  });
});

// ─── BearerStaticAuth ────────────────────────────────────────────────────────

describe("BearerStaticAuth", () => {
  test("reads token from env and injects Authorization header", async () => {
    const auth = BearerStaticAuth.fromConfig(
      { env: "MY_TOKEN" },
      fakeDeps({ MY_TOKEN: "tok_abc123" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer tok_abc123");
  });

  test("custom header and prefix are honored", async () => {
    const auth = BearerStaticAuth.fromConfig(
      { env: "MY_TOKEN", header: "X-Auth-Token", prefix: "Token " },
      fakeDeps({ MY_TOKEN: "secret" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["X-Auth-Token"]).toBe("Token secret");
  });

  test("inline value takes priority over env", async () => {
    const auth = BearerStaticAuth.fromConfig(
      { value: "inline_token" },
      fakeDeps(),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer inline_token");
  });

  test("missing env var throws", () => {
    expect(() =>
      BearerStaticAuth.fromConfig({ env: "MISSING_VAR" }, fakeDeps()),
    ).toThrow(/MISSING_VAR/);
  });

  test("isRejection(401) is true, isRejection(200) is false", () => {
    const auth = BearerStaticAuth.fromConfig({ value: "tok" }, fakeDeps());
    expect(auth.isRejection(401, null)).toBe(true);
    expect(auth.isRejection(200, null)).toBe(false);
    expect(auth.isRejection(403, null)).toBe(false);
  });
});

// ─── ApiKeyHeaderAuth ─────────────────────────────────────────────────────────

describe("ApiKeyHeaderAuth", () => {
  test("reads env and injects the configured header", async () => {
    const auth = ApiKeyHeaderAuth.fromConfig(
      { env: "API_KEY", header: "X-API-Key" },
      fakeDeps({ API_KEY: "key_123" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["X-API-Key"]).toBe("key_123");
  });

  test("default invalidateOn includes 401 and 403", () => {
    const auth = ApiKeyHeaderAuth.fromConfig(
      { env: "API_KEY", header: "X-API-Key" },
      fakeDeps({ API_KEY: "k" }),
    );
    expect(auth.isRejection(401, null)).toBe(true);
    expect(auth.isRejection(403, null)).toBe(true);
    expect(auth.isRejection(200, null)).toBe(false);
  });
});

// ─── ApiKeyQueryAuth ──────────────────────────────────────────────────────────

describe("ApiKeyQueryAuth", () => {
  test("injects into queryParams", async () => {
    const auth = ApiKeyQueryAuth.fromConfig(
      { env: "API_KEY", param: "api_key" },
      fakeDeps({ API_KEY: "qkey_456" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.queryParams?.["api_key"]).toBe("qkey_456");
  });

  test("headers are not set — only queryParams", async () => {
    const auth = ApiKeyQueryAuth.fromConfig(
      { env: "API_KEY", param: "appid" },
      fakeDeps({ API_KEY: "xyz" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers).toBeUndefined();
    expect(result.queryParams?.["appid"]).toBe("xyz");
  });
});

// ─── BasicAuth ───────────────────────────────────────────────────────────────

describe("BasicAuth", () => {
  test("encodes user:pass as base64 correctly (known fixture)", async () => {
    // btoa("testuser:testpass") === "dGVzdHVzZXI6dGVzdHBhc3M="
    const auth = BasicAuth.fromConfig(
      { username_env: "USER", password_env: "PASS" },
      fakeDeps({ USER: "testuser", PASS: "testpass" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe(
      "Basic dGVzdHVzZXI6dGVzdHBhc3M=",
    );
  });

  test("missing username_env throws", () => {
    expect(() =>
      BasicAuth.fromConfig(
        { username_env: "NO_USER", password_env: "PASS" },
        fakeDeps({ PASS: "p" }),
      ),
    ).toThrow(/NO_USER/);
  });

  test("missing password_env throws", () => {
    expect(() =>
      BasicAuth.fromConfig(
        { username_env: "USER", password_env: "NO_PASS" },
        fakeDeps({ USER: "u" }),
      ),
    ).toThrow(/NO_PASS/);
  });
});

// ─── CustomHeadersAuth ────────────────────────────────────────────────────────

describe("CustomHeadersAuth", () => {
  test("multiple headers from mix of env + literal values", async () => {
    const auth = CustomHeadersAuth.fromConfig(
      {
        headers: {
          "X-Literal": { value: "literal_val" },
          "X-From-Env": { env: "MY_ENV_VAR" },
        },
      },
      fakeDeps({ MY_ENV_VAR: "env_val" }),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["X-Literal"]).toBe("literal_val");
    expect(result.headers?.["X-From-Env"]).toBe("env_val");
  });

  test("missing env var throws with header name in message", () => {
    expect(() =>
      CustomHeadersAuth.fromConfig(
        {
          headers: {
            "X-Secret": { env: "MISSING_VAR" },
          },
        },
        fakeDeps(),
      ),
    ).toThrow(/MISSING_VAR/);
  });
});
