import { describe, test, expect, vi } from "vitest";
import { HostResolver, loadHostsFromYaml } from "../../src/core/hosts.ts";
import type { AppEnv } from "../../src/core/env.ts";

function fakeEnv(extra: Record<string, string> = {}): AppEnv {
  return {
    DEFAULT_PROVIDER: "",
    PROVIDERS_DIR: "",
    HOSTS_CONFIG_PATH: "",
    PROXY_PORT: "",
    LOG_LEVEL: "",
    ...extra,
  };
}

describe("HostResolver — basic resolution", () => {
  test("IPv4 address matches an encompassing /24 CIDR", () => {
    const r = new HostResolver([
      {
        cidr: "192.168.1.0/24",
        policy: { id: "office", canCallSensitive: false },
      },
    ]);
    expect(r.resolve("192.168.1.42")?.id).toBe("office");
  });

  test("longest-prefix wins — /32 over /24", () => {
    const r = new HostResolver([
      {
        cidr: "192.168.1.0/24",
        policy: { id: "network", canCallSensitive: false },
      },
      {
        cidr: "192.168.1.10/32",
        policy: { id: "specific-host", canCallSensitive: true },
      },
    ]);
    expect(r.resolve("192.168.1.10")?.id).toBe("specific-host");
    expect(r.resolve("192.168.1.99")?.id).toBe("network");
  });

  test("unmatched IP returns null", () => {
    const r = new HostResolver([
      {
        cidr: "10.0.0.0/8",
        policy: { id: "internal", canCallSensitive: false },
      },
    ]);
    expect(r.resolve("172.16.0.1")).toBeNull();
  });

  test("invalid IP string returns null", () => {
    const r = new HostResolver([
      {
        cidr: "10.0.0.0/8",
        policy: { id: "internal", canCallSensitive: false },
      },
    ]);
    expect(r.resolve("not-an-ip")).toBeNull();
    expect(r.resolve("999.999.999.999")).toBeNull();
  });

  test("IPv6 address matches its CIDR", () => {
    const r = new HostResolver([
      {
        cidr: "::1/128",
        policy: { id: "loopback6", canCallSensitive: true },
      },
    ]);
    expect(r.resolve("::1")?.id).toBe("loopback6");
  });

  test("canCallSensitive: true is preserved on resolved policy", () => {
    const r = new HostResolver([
      {
        cidr: "10.0.0.1/32",
        policy: { id: "trader", canCallSensitive: true },
      },
    ]);
    expect(r.resolve("10.0.0.1")?.canCallSensitive).toBe(true);
  });

  test("invalid CIDR is skipped; valid entries still work", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new HostResolver([
      { cidr: "not-a-cidr", policy: { id: "bad", canCallSensitive: false } },
      {
        cidr: "10.1.0.0/16",
        policy: { id: "good", canCallSensitive: false },
      },
    ]);
    expect(r.resolve("10.1.2.3")?.id).toBe("good");
    consoleWarn.mockRestore();
  });

  test("empty entries array gives resolver that returns null for any IP", () => {
    const r = new HostResolver([]);
    expect(r.resolve("1.2.3.4")).toBeNull();
    expect(r.resolve("127.0.0.1")).toBeNull();
  });
});

describe("loadHostsFromYaml", () => {
  test("can_trade: true falls back to canCallSensitive with a warning", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const yaml = `
hosts:
  - id: legacy
    cidrs: ["172.20.0.0/16"]
    can_trade: true
`;
    const r = loadHostsFromYaml(yaml, fakeEnv());
    expect(r.resolve("172.20.0.5")?.canCallSensitive).toBe(true);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("deprecated"),
    );
    consoleWarn.mockRestore();
  });

  test("can_call_sensitive: true is parsed directly", () => {
    const yaml = `
hosts:
  - id: trading-node
    cidrs: ["10.5.0.0/24"]
    can_call_sensitive: true
`;
    const r = loadHostsFromYaml(yaml, fakeEnv());
    expect(r.resolve("10.5.0.1")?.canCallSensitive).toBe(true);
  });

  // ── PSK / auth_token_env tests ─────────────────────────────────────────────

  test("auth_token_env is resolved from env at load time", () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const yaml = `
hosts:
  - id: secured
    cidrs: ["10.0.0.0/8"]
    can_call_sensitive: false
    auth_token_env: MY_PSK
`;
    const r = loadHostsFromYaml(yaml, fakeEnv({ MY_PSK: "supersecret" }));
    expect(r.resolve("10.0.0.1")?.authToken).toBe("supersecret");
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining("secured"),
    );
    consoleInfo.mockRestore();
  });

  test("fail-fast when auth_token_env is set but env var is missing", () => {
    const yaml = `
hosts:
  - id: secured
    cidrs: ["10.0.0.0/8"]
    can_call_sensitive: false
    auth_token_env: MISSING_VAR
`;
    expect(() => loadHostsFromYaml(yaml, fakeEnv())).toThrow(
      /MISSING_VAR.*unset or empty/,
    );
  });

  test("fail-fast when auth_token_env resolves to empty string", () => {
    const yaml = `
hosts:
  - id: secured
    cidrs: ["10.0.0.0/8"]
    can_call_sensitive: false
    auth_token_env: EMPTY_VAR
`;
    expect(() => loadHostsFromYaml(yaml, fakeEnv({ EMPTY_VAR: "" }))).toThrow(
      /EMPTY_VAR.*unset or empty/,
    );
  });

  test("host without auth_token_env has no authToken on its policy", () => {
    const yaml = `
hosts:
  - id: open
    cidrs: ["10.0.0.0/8"]
    can_call_sensitive: false
`;
    const r = loadHostsFromYaml(yaml, fakeEnv());
    expect(r.resolve("10.0.0.1")?.authToken).toBeUndefined();
  });

  test("multiple hosts can have different auth tokens", () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const yaml = `
hosts:
  - id: host-a
    cidrs: ["10.1.0.0/24"]
    can_call_sensitive: false
    auth_token_env: PSK_A
  - id: host-b
    cidrs: ["10.2.0.0/24"]
    can_call_sensitive: false
    auth_token_env: PSK_B
  - id: host-c
    cidrs: ["10.3.0.0/24"]
    can_call_sensitive: false
`;
    const r = loadHostsFromYaml(
      yaml,
      fakeEnv({ PSK_A: "token-alpha", PSK_B: "token-beta" }),
    );
    expect(r.resolve("10.1.0.5")?.authToken).toBe("token-alpha");
    expect(r.resolve("10.2.0.5")?.authToken).toBe("token-beta");
    expect(r.resolve("10.3.0.5")?.authToken).toBeUndefined();
    consoleInfo.mockRestore();
  });
});
