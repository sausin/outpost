import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { OAuth2ClientCredentialsAuth } from "../../src/auth/modules/oauth2_client_credentials.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";
import type { AuthDeps } from "../../src/auth/types.ts";
import type { AuthContext } from "../../src/core/types.ts";

function makeDeps(storage: InMemoryStorage): AuthDeps {
  return {
    env: {
      DEFAULT_PROVIDER: "",
      PROVIDERS_DIR: "",
      HOSTS_CONFIG_PATH: "",
      PROXY_PORT: "",
      LOG_LEVEL: "",
      CLIENT_ID: "test-client-id",
      CLIENT_SECRET: "test-client-secret",
    },
    tokenStorage: storage,
  };
}

const BASE_CONFIG = {
  client_id_env: "CLIENT_ID",
  client_secret_env: "CLIENT_SECRET",
  token_url: "https://auth.example.com/token",
  redis_key: "oauth2:test",
  redis_lock_key: "oauth2:test:lock",
};

function fakeCtx(): AuthContext {
  return {
    method: "GET",
    fullPath: "/v1/resource",
    queryString: "",
    body: null,
    headers: new Headers(),
  };
}

function makeTokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: token, expires_in: expiresIn }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("OAuth2ClientCredentialsAuth", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("first call mints token and caches it in storage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeTokenResponse("access_token_abc"),
    );
    const auth = await OAuth2ClientCredentialsAuth.fromConfig(
      BASE_CONFIG,
      makeDeps(storage),
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer access_token_abc");
    expect(await storage.get("oauth2:test")).toBe("access_token_abc");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  test("second call uses cache and does not call fetch again", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access_token_cached",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const auth = await OAuth2ClientCredentialsAuth.fromConfig(
      BASE_CONFIG,
      makeDeps(storage),
    );
    await auth.apply(fakeCtx()); // populates cache
    const result = await auth.apply(fakeCtx()); // should hit cache, no fetch
    expect(result.headers?.["Authorization"]).toBe(
      "Bearer access_token_cached",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the first call fetched
  });

  test("after cache expiry, mints again", async () => {
    // Set up spy with two sequential responses
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "first_token", expires_in: 60 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "second_token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const auth = await OAuth2ClientCredentialsAuth.fromConfig(
      BASE_CONFIG,
      makeDeps(storage),
    );
    await auth.apply(fakeCtx()); // First mint
    // Manually expire the cached entry to force a second mint
    storage.setExpired("oauth2:test", "first_token");

    const result = await auth.apply(fakeCtx()); // Second mint
    expect(result.headers?.["Authorization"]).toBe("Bearer second_token");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  test("invalidate clears the storage key", async () => {
    await storage.set("oauth2:test", "existing_token");
    const auth = await OAuth2ClientCredentialsAuth.fromConfig(
      BASE_CONFIG,
      makeDeps(storage),
    );
    await auth.invalidate();
    expect(await storage.get("oauth2:test")).toBeNull();
  });

  test("token URL POST has correct form body fields", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        ),
      );
    const auth = await OAuth2ClientCredentialsAuth.fromConfig(
      { ...BASE_CONFIG, scope: "read:all" },
      makeDeps(storage),
    );
    await auth.apply(fakeCtx());

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.example.com/token");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("scope")).toBe("read:all");
  });
});
