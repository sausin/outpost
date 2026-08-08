import { describe, test, expect } from "vitest";
import { envFromWorkers } from "../../src/core/env.ts";

// envFromWorkers and envFromNode share one builder, so exercising the Workers
// entry-point (which takes its source as an argument) covers both.

describe("env resolution", () => {
  test("falls back to sane defaults when nothing is set", () => {
    const env = envFromWorkers({});
    expect(env.PROXY_PORT).toBe("8080");
    expect(env.BIND_ADDRESS).toBe("0.0.0.0");
    expect(env.PROVIDERS_DIR).toBe("./builtin_providers");
    expect(env.HOSTS_CONFIG_PATH).toBe("./hosts.yaml");
    expect(env.DEFAULT_PROVIDER).toBe("");
  });

  test("OUTPOST_* names are honoured", () => {
    const env = envFromWorkers({
      OUTPOST_PORT: "9000",
      OUTPOST_BIND_ADDRESS: "127.0.0.1",
      OUTPOST_PROVIDERS_DIR: "/config/providers",
      OUTPOST_HOSTS_FILE: "/config/hosts.yaml",
      OUTPOST_DEFAULT_PROVIDER: "stripe",
    });
    expect(env.PROXY_PORT).toBe("9000");
    expect(env.BIND_ADDRESS).toBe("127.0.0.1");
    expect(env.PROVIDERS_DIR).toBe("/config/providers");
    expect(env.HOSTS_CONFIG_PATH).toBe("/config/hosts.yaml");
    expect(env.DEFAULT_PROVIDER).toBe("stripe");
  });

  test("legacy names still work when the OUTPOST_* one is absent", () => {
    const env = envFromWorkers({
      PROXY_PORT: "9100",
      PROXY_HOST: "10.0.0.5",
      PROVIDERS_DIR: "/legacy/providers",
      HOSTS_CONFIG_PATH: "/legacy/hosts.yaml",
      DEFAULT_PROVIDER: "openai",
    });
    expect(env.PROXY_PORT).toBe("9100");
    expect(env.BIND_ADDRESS).toBe("10.0.0.5");
    expect(env.PROVIDERS_DIR).toBe("/legacy/providers");
    expect(env.HOSTS_CONFIG_PATH).toBe("/legacy/hosts.yaml");
    expect(env.DEFAULT_PROVIDER).toBe("openai");
  });

  test("OUTPOST_* wins over the legacy name, and a stale legacy value cannot shadow it", () => {
    const env = envFromWorkers({
      OUTPOST_PROVIDERS_DIR: "/config/providers",
      PROVIDERS_DIR: "/legacy/providers",
      OUTPOST_PORT: "9000",
      PROXY_PORT: "8080",
    });
    expect(env.PROVIDERS_DIR).toBe("/config/providers");
    expect(env.PROXY_PORT).toBe("9000");
  });

  test("empty strings are treated as unset", () => {
    const env = envFromWorkers({ OUTPOST_PORT: "", PROXY_PORT: "9200" });
    expect(env.PROXY_PORT).toBe("9200");
  });

  test("unrelated vars (provider credentials) pass straight through", () => {
    const env = envFromWorkers({ GITHUB_TOKEN: "ghp_example" });
    expect(env["GITHUB_TOKEN"]).toBe("ghp_example");
  });
});
