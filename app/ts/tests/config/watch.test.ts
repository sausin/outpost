import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { configFingerprint, watchConfig } from "../../src/config/watch.ts";
import type { ConfigWatcher } from "../../src/config/watch.ts";

let root: string;
let providersDir: string;
let hostsFile: string;
const watchers: ConfigWatcher[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "outpost-watch-"));
  providersDir = path.join(root, "providers");
  hostsFile = path.join(root, "hosts.yaml");
  await mkdir(providersDir);
  await writeFile(hostsFile, "hosts: []\n");
});

afterEach(async () => {
  for (const w of watchers.splice(0)) w.close();
  await rm(root, { recursive: true, force: true });
});

/** Resolve once `count` reloads have happened, or fail after `timeoutMs`. */
function reloads(count: number, timeoutMs = 5000) {
  let n = 0;
  let resolve!: () => void;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    setTimeout(() => rej(new Error(`only ${n}/${count} reloads`)), timeoutMs);
  });
  return {
    onChange: () => {
      n += 1;
      if (n >= count) resolve();
    },
    done,
    get count() {
      return n;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("configFingerprint", () => {
  test("changes when a provider YAML is added, edited or removed, and when hosts.yaml changes", async () => {
    const a = await configFingerprint(providersDir, hostsFile);

    const file = path.join(providersDir, "github.yaml");
    await writeFile(file, "name: github\n");
    const b = await configFingerprint(providersDir, hostsFile);
    expect(b).not.toBe(a);

    // Touch with different content/size so mtime granularity can't hide it.
    await writeFile(file, "name: github\nbase_url: https://api.github.com\n");
    const c = await configFingerprint(providersDir, hostsFile);
    expect(c).not.toBe(b);

    await unlink(file);
    const d = await configFingerprint(providersDir, hostsFile);
    expect(d).toBe(a);

    await writeFile(
      hostsFile,
      "hosts:\n  - id: x\n    cidrs: ['10.0.0.0/8']\n",
    );
    expect(await configFingerprint(providersDir, hostsFile)).not.toBe(d);
  });

  test("ignores non-YAML files in the providers directory", async () => {
    const a = await configFingerprint(providersDir, hostsFile);
    await writeFile(path.join(providersDir, "notes.txt"), "scratch");
    expect(await configFingerprint(providersDir, hostsFile)).toBe(a);
  });

  test("a missing providers directory is a stable fingerprint, not an error", async () => {
    const missing = path.join(root, "nope");
    expect(await configFingerprint(missing, hostsFile)).toBe(
      await configFingerprint(missing, hostsFile),
    );
  });
});

describe("watchConfig", () => {
  test("reloads once for a burst of edits to the providers directory", async () => {
    const r = reloads(1);
    watchers.push(
      watchConfig({
        providersDir,
        hostsFile,
        onChange: r.onChange,
        debounceMs: 100,
        pollMs: 0,
        log: () => {},
      }),
    );
    await sleep(50);

    await writeFile(path.join(providersDir, "a.yaml"), "name: a\n");
    await writeFile(path.join(providersDir, "b.yaml"), "name: b\n");
    await writeFile(path.join(providersDir, "a.yaml"), "name: a\nenabled: true\n"); // prettier-ignore
    await r.done;

    // Debounce collapsed the burst; give it a moment to prove nothing else fires.
    await sleep(250);
    expect(r.count).toBe(1);
  });

  test("reloads when hosts.yaml is rewritten", async () => {
    const r = reloads(1);
    watchers.push(
      watchConfig({
        providersDir,
        hostsFile,
        onChange: r.onChange,
        debounceMs: 100,
        pollMs: 0,
        log: () => {},
      }),
    );
    await sleep(50);
    await writeFile(hostsFile, "hosts:\n  - id: lan\n    cidrs: ['192.168.1.0/24']\n"); // prettier-ignore
    await r.done;
  });

  test("the poll fallback catches a change on its own", async () => {
    // inotify cannot be switched off, so watch a directory that does not exist
    // (fs.watch throws → skipped) and let the poll observe the file appearing.
    const r = reloads(1, 8000);
    const ghostDir = path.join(root, "later");
    watchers.push(
      watchConfig({
        providersDir: ghostDir,
        hostsFile: path.join(ghostDir, "hosts.yaml"),
        onChange: r.onChange,
        debounceMs: 50,
        pollMs: 150,
        log: () => {},
      }),
    );
    await sleep(200); // first tick records the baseline
    await mkdir(ghostDir);
    await writeFile(path.join(ghostDir, "hosts.yaml"), "hosts: []\n");
    await r.done;
  });

  test("a reload that arrives mid-reload runs once more afterwards, never concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let runs = 0;
    const w = watchConfig({
      providersDir,
      hostsFile,
      onChange: async () => {
        runs += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(150);
        inFlight -= 1;
      },
      debounceMs: 10,
      pollMs: 0,
      log: () => {},
    });
    watchers.push(w);

    w.trigger();
    await sleep(60); // first run is now in progress
    w.trigger();
    w.trigger();
    await sleep(500);

    expect(maxInFlight).toBe(1);
    expect(runs).toBe(2);
  });

  test("close() stops further reloads", async () => {
    let runs = 0;
    const w = watchConfig({
      providersDir,
      hostsFile,
      onChange: () => {
        runs += 1;
      },
      debounceMs: 20,
      pollMs: 0,
      log: () => {},
    });
    w.close();
    await writeFile(path.join(providersDir, "x.yaml"), "name: x\n");
    w.trigger();
    await sleep(150);
    expect(runs).toBe(0);
  });
});
