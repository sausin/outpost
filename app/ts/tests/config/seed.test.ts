import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EXAMPLE_PROVIDER_YAML,
  seedConfig,
  STARTER_HOSTS_YAML,
} from "../../src/config/seed.ts";
import { loadProvidersFromYamls } from "../../src/providers/loader.ts";
import { loadHostsFromYaml } from "../../src/core/hosts.ts";
import { envFromWorkers } from "../../src/core/env.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "outpost-seed-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env["OUTPOST_SEED_CONFIG"];
});

function targets(root: string) {
  return {
    providersDir: path.join(root, "providers"),
    hostsFile: path.join(root, "hosts.yaml"),
  };
}

describe("seedConfig", () => {
  test("writes both starter files into an empty config volume", async () => {
    const t = targets(dir);
    const created = await seedConfig(t);

    expect(created).toEqual([t.hostsFile, path.join(t.providersDir, "example.yaml")]); // prettier-ignore
    expect(await readFile(t.hostsFile, "utf8")).toBe(STARTER_HOSTS_YAML);
    expect(await readFile(path.join(t.providersDir, "example.yaml"), "utf8")).toBe(EXAMPLE_PROVIDER_YAML); // prettier-ignore
  });

  test("never overwrites files the operator already wrote", async () => {
    const t = targets(dir);
    await mkdir(t.providersDir, { recursive: true });
    await writeFile(t.hostsFile, "hosts: []\n");
    await writeFile(path.join(t.providersDir, "mine.yaml"), "name: mine\n");

    expect(await seedConfig(t)).toEqual([]);
    expect(await readFile(t.hostsFile, "utf8")).toBe("hosts: []\n");
  });

  test("is a no-op the second time round", async () => {
    const t = targets(dir);
    await seedConfig(t);
    expect(await seedConfig(t)).toEqual([]);
  });

  test("OUTPOST_SEED_CONFIG=false disables it entirely", async () => {
    process.env["OUTPOST_SEED_CONFIG"] = "false";
    expect(await seedConfig(targets(dir))).toEqual([]);
  });

  test("an unusable config path is survivable, not fatal", async () => {
    // A regular file where the config directory should be: every mkdir below
    // it fails with ENOTDIR, standing in for a read-only or broken mount.
    const blocked = path.join(dir, "not-a-dir");
    await writeFile(blocked, "");

    const created = await seedConfig({
      providersDir: path.join(blocked, "providers"),
      hostsFile: path.join(blocked, "hosts.yaml"),
    });
    expect(created).toEqual([]);
  });
});

describe("seeded content is valid", () => {
  test("the example provider parses and is disabled", async () => {
    const { providers } = await loadProvidersFromYamls([
      { name: "example.yaml", content: EXAMPLE_PROVIDER_YAML },
    ]);
    // Parsed successfully but filtered out because enabled: false.
    expect(providers.size).toBe(0);
  });

  test("the example provider becomes live once enabled", async () => {
    const { providers } = await loadProvidersFromYamls([
      {
        name: "example.yaml",
        content: EXAMPLE_PROVIDER_YAML.replace(
          "enabled: false",
          "enabled: true",
        ),
      },
    ]);
    expect([...providers.keys()]).toEqual(["example"]);
    expect(providers.get("example")?.forwarding.deny).toEqual(["/v1/admin/**"]);
  });

  test("the starter hosts policy admits loopback and nothing else", () => {
    const hosts = loadHostsFromYaml(STARTER_HOSTS_YAML, envFromWorkers({}));
    expect(hosts.resolve("127.0.0.1")?.id).toBe("localhost");
    expect(hosts.resolve("::1")?.id).toBe("localhost");
    expect(hosts.resolve("192.168.1.20")).toBeNull();
  });
});
