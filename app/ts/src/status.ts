/**
 * Status page — `GET /dashboard` (HTML) and `GET /api/overview` (JSON).
 *
 * Modelled on Traefik's dashboard: a read-only view of what this instance has
 * loaded, served on the same port as the proxy, with no build step and no CDN
 * dependency so it works on an air-gapped NAS.
 *
 * The one rule: NOTHING here may carry a secret value. Credentials appear only
 * as the NAME of the environment variable plus a set/unset flag; a host's PSK
 * appears only as the env var it is read from. Anything that resolves a
 * credential at runtime (HostPolicy.authToken, an auth module's token) is kept
 * out of the serialised shape on purpose rather than filtered afterwards —
 * see `describeProvider` / `HostResolver.describe`.
 */

import type { Context } from "hono";

import type { ConfigProblem } from "./core/types.ts";
import type { HostDescription } from "./core/hosts.ts";
import type { AppDeps } from "./index.ts";
import type { GenericProvider } from "./providers/provider.ts";

// ─── What the runtime adapter tells the status page ──────────────────────────

export interface StorageHealth {
  ok: boolean;
  /** Human-readable, e.g. "PONG in 1 ms" or the connection error. */
  detail: string;
}

/**
 * Runtime-level facts the shared app cannot know by itself. Everything is
 * optional so the Workers adapter and unit tests can pass a partial view.
 */
export interface StatusSource {
  version?: string;
  runtime?: "node" | "workers";
  /** Epoch ms when the process started. */
  startedAt?: number;
  config?: {
    providersDir?: string;
    hostsFile?: string;
    /** Runtime plugins directory (Node only). */
    pluginsDir?: string;
    /** Whether the config files are re-read when they change on disk. */
    watch?: boolean;
    /** Epoch ms of the last successful (re)load. */
    loadedAt?: number;
    /** Number of successful reloads since boot. */
    reloads?: number;
    /** Problems from the last load attempt, beyond those on AppDeps.problems. */
    problems?: ConfigProblem[];
  };
  trustedProxies?: string[];
  /** Providers on disk with `enabled: false`. */
  disabledProviders?: Array<{ name: string; source: string }>;
  /** Is this credential env var set (non-empty)? Never returns the value. */
  credentialSet?: (envName: string) => boolean;
  /** Probe the storage backend (Redis on Node, KV on Workers). */
  storage?: () => Promise<StorageHealth>;
}

// ─── Serialised shapes ───────────────────────────────────────────────────────

export interface CredentialRef {
  env: string;
  set: boolean | null;
}

export interface ProviderOverview {
  name: string;
  base_url: string;
  description: string;
  docs_url: string;
  auth: { type: string; credentials: CredentialRef[] };
  forwarding: {
    mode: "transparent" | "allowlist";
    allow: Array<{
      method: string;
      pattern: string;
      category: string;
      cache_ttl: number;
      sensitive: boolean;
    }>;
    deny: string[];
    treat_writes_as_sensitive: boolean;
    default_cache_ttl: number;
    rate_limits: Record<string, Array<{ capacity: number; window_ms: number }>>;
  };
}

export interface HostOverview {
  id: string;
  cidrs: string[];
  can_call_sensitive: boolean;
  description: string | null;
  /** Env var holding the PSK, or null when the host needs none. */
  psk_env: string | null;
}

export interface Overview {
  status: "ok" | "degraded";
  version: string;
  runtime: string;
  started_at: string | null;
  uptime_seconds: number | null;
  config: {
    providers_dir: string | null;
    hosts_file: string | null;
    plugins_dir: string | null;
    watch: boolean | null;
    loaded_at: string | null;
    reloads: number;
    problems: ConfigProblem[];
  };
  default_provider: string | null;
  trusted_proxies: string[];
  providers: ProviderOverview[];
  disabled_providers: Array<{ name: string; source: string }>;
  hosts: HostOverview[];
  /** What this very request resolved to — the fastest way to debug a 403. */
  you: {
    ip: string | null;
    host: string | null;
    can_call_sensitive: boolean;
    psk_required: boolean;
  };
  storage: StorageHealth | null;
}

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * Collect the env var NAMES an auth block reads its credentials from: `env`,
 * `env_seed`, and anything ending in `_env`, at any depth (plugin `config:`
 * blocks and `custom_headers` specs nest them). Values under any other key —
 * an inline `value:`, a `redis_key`, a `module` path — are never emitted.
 */
export function credentialEnvNames(auth: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return;
    for (const [key, value] of Object.entries(node)) {
      if (
        (key === "env" || key === "env_seed" || key.endsWith("_env")) &&
        typeof value === "string" &&
        value.length > 0
      ) {
        if (!out.includes(value)) out.push(value);
      } else if (typeof value === "object" && value !== null) {
        walk(value);
      }
    }
  };
  walk(auth);
  return out;
}

export function describeProvider(
  p: GenericProvider,
  credentialSet?: (envName: string) => boolean,
): ProviderOverview {
  const def = p.def;
  const auth = def.auth as Record<string, unknown>;
  return {
    name: def.name,
    base_url: def.base_url,
    description: def.description,
    docs_url: def.docs_url,
    auth: {
      type: String(auth["type"] ?? "unknown"),
      credentials: credentialEnvNames(auth).map((env) => ({
        env,
        set: credentialSet ? credentialSet(env) : null,
      })),
    },
    forwarding: {
      mode: def.forwarding.mode,
      allow: def.forwarding.allow.map((r) => ({
        method: r.method,
        pattern: r.pattern,
        category: r.category,
        cache_ttl: r.cache_ttl,
        sensitive: r.sensitive,
      })),
      deny: [...def.forwarding.deny],
      treat_writes_as_sensitive: def.forwarding.treat_writes_as_sensitive,
      default_cache_ttl: def.forwarding.default_cache_ttl,
      rate_limits: Object.fromEntries(
        Object.entries(def.forwarding.rate_limits).map(([cat, ws]) => [
          cat,
          ws.map((w) => ({ capacity: w.capacity, window_ms: w.window_ms })),
        ]),
      ),
    },
  };
}

function describeHost(h: HostDescription): HostOverview {
  return {
    id: h.id,
    cidrs: h.cidrs,
    can_call_sensitive: h.canCallSensitive,
    description: h.description ?? null,
    psk_env: h.authTokenEnv,
  };
}

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

export async function buildOverview(
  deps: AppDeps,
  c: Context,
  source: StatusSource = {},
): Promise<Overview> {
  const cfg = source.config ?? {};
  const problems = [...(deps.problems ?? []), ...(cfg.problems ?? [])];

  let storage: StorageHealth | null = null;
  if (source.storage) {
    try {
      storage = await source.storage();
    } catch (err) {
      storage = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // The viewer's own address, resolved exactly as a proxied request would be.
  const ip = deps.resolveClientIp ? (deps.resolveClientIp(c) ?? null) : null;
  const policy = ip === null ? null : deps.hosts.resolve(ip);

  const degraded = problems.length > 0 || (storage !== null && !storage.ok);

  return {
    status: degraded ? "degraded" : "ok",
    version: source.version ?? "dev",
    runtime: source.runtime ?? "unknown",
    started_at: iso(source.startedAt),
    uptime_seconds:
      typeof source.startedAt === "number"
        ? Math.max(0, Math.round((Date.now() - source.startedAt) / 1000))
        : null,
    config: {
      providers_dir: cfg.providersDir ?? null,
      hosts_file: cfg.hostsFile ?? null,
      plugins_dir: cfg.pluginsDir ?? null,
      watch: cfg.watch ?? null,
      loaded_at: iso(cfg.loadedAt),
      reloads: cfg.reloads ?? 0,
      problems,
    },
    default_provider: deps.defaultProvider || null,
    trusted_proxies: source.trustedProxies ?? [],
    providers: [...deps.providers.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => describeProvider(p, source.credentialSet)),
    disabled_providers: source.disabledProviders ?? [],
    hosts: deps.hosts.describe().map(describeHost),
    you: {
      ip,
      host: policy?.id ?? null,
      can_call_sensitive: policy?.canCallSensitive ?? false,
      psk_required: Boolean(policy?.authToken),
    },
    storage,
  };
}

// ─── The page ────────────────────────────────────────────────────────────────
// Plain HTML + inline CSS/JS. It polls /api/overview and renders it; every
// value goes through a text node, never innerHTML, so provider descriptions
// and error messages from YAML files cannot inject markup.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outpost</title>
<style>
  :root {
    --bg: #f4f5f7; --panel: #ffffff; --line: #e3e6ea; --text: #1f2430; --muted: #6b7280;
    --ok: #15803d; --ok-bg: #dcfce7; --warn: #b45309; --warn-bg: #fef3c7; --bad: #b91c1c; --bad-bg: #fee2e2;
    --accent: #2563eb; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1218; --panel: #171b23; --line: #262c37; --text: #e6e8ec; --muted: #9aa3b2;
      --ok: #4ade80; --ok-bg: #14301f; --warn: #fbbf24; --warn-bg: #3a2b0a; --bad: #f87171; --bad-bg: #3b1212; --accent: #60a5fa; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 14px; padding: 14px 24px; background: var(--panel); border-bottom: 1px solid var(--line); }
  header h1 { font-size: 18px; margin: 0; letter-spacing: .2px; }
  header .meta { color: var(--muted); font-size: 13px; }
  header .spacer { flex: 1; }
  main { max-width: 1200px; margin: 0 auto; padding: 20px 24px 60px; display: grid; gap: 18px; }
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  section h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-top: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; border-top: 0; }
  code, .mono { font-family: var(--mono); font-size: 12.5px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .ok { color: var(--ok); background: var(--ok-bg); } .warn { color: var(--warn); background: var(--warn-bg); } .bad { color: var(--bad); background: var(--bad-bg); }
  .muted { color: var(--muted); }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
  .kv dt { color: var(--muted); } .kv dd { margin: 0; overflow-wrap: anywhere; }
  pre { margin: 8px 0 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; font-family: var(--mono); font-size: 12px; overflow: auto; }
  .empty { color: var(--muted); font-style: italic; }
  ul.problems { margin: 0; padding-left: 18px; } ul.problems li { margin: 4px 0; overflow-wrap: anywhere; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  footer { color: var(--muted); font-size: 12px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Outpost</h1>
  <span class="meta" id="version"></span>
  <span class="pill" id="status">loading…</span>
  <span class="spacer"></span>
  <span class="meta" id="uptime"></span>
  <a href="/docs">API docs</a>
</header>
<main>
  <div class="grid">
    <section>
      <h2>Your connection</h2>
      <div id="you"></div>
    </section>
    <section>
      <h2>Configuration</h2>
      <dl class="kv" id="config"></dl>
      <div id="problems"></div>
    </section>
    <section>
      <h2>Storage</h2>
      <div id="storage"></div>
    </section>
  </div>
  <section>
    <h2>Providers</h2>
    <div id="providers"></div>
  </section>
  <section>
    <h2>Host policy</h2>
    <div id="hosts"></div>
  </section>
  <footer>Refreshes every 5 s · <a href="/api/overview">/api/overview</a> · no credential values are ever shown here</footer>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === "class") n.className = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function pill(text, cls) { return el("span", { class: "pill " + cls }, [text]); }
  function code(text) { return el("code", null, [text]); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function table(headers, rows) {
    var t = el("table");
    t.appendChild(el("thead", null, [el("tr", null, headers.map(function (h) { return el("th", null, [h]); }))]));
    t.appendChild(el("tbody", null, rows.map(function (r) { return el("tr", null, r.map(function (c) {
      if (c && typeof c === "object" && !Array.isArray(c) && !(c instanceof Node)) return el("td", { colspan: String(c.colspan) }, c.content);
      return el("td", null, Array.isArray(c) ? c : [c]);
    })); })));
    return t;
  }
  function fmtUptime(s) {
    if (s == null) return "";
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return "up " + (d ? d + "d " : "") + (h || d ? h + "h " : "") + m + "m";
  }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleString() : "—"; }

  function render(o) {
    $("version").textContent = o.version + " · " + o.runtime;
    var st = $("status"); st.textContent = o.status; st.className = "pill " + (o.status === "ok" ? "ok" : "warn");
    $("uptime").textContent = fmtUptime(o.uptime_seconds);

    // Your connection
    var you = clear($("you"));
    var y = o.you;
    if (!y.ip) {
      you.appendChild(el("p", null, ["Could not determine your address."]));
    } else if (y.host) {
      you.appendChild(el("p", null, ["Seen as ", code(y.ip), " → host ", code(y.host), " ",
        pill(y.can_call_sensitive ? "sensitive allowed" : "read-only", y.can_call_sensitive ? "warn" : "ok"),
        " ", y.psk_required ? pill("PSK required", "ok") : pill("no PSK", "warn")]));
      you.appendChild(el("p", { class: "muted" }, ["Requests from this address are accepted by the proxy."]));
    } else {
      you.appendChild(el("p", null, ["Seen as ", code(y.ip), " ", pill("not in host policy", "bad")]));
      you.appendChild(el("p", { class: "muted" }, ["Agents at this address get 403 PROXY_HOST_DENIED. To allow them, add to hosts.yaml:"]));
      var v6 = y.ip.indexOf(":") >= 0;
      you.appendChild(el("pre", null, ["hosts:\\n  - id: my-agent\\n    cidrs: [\\"" + y.ip + (v6 ? "/128" : "/32") + "\\"]\\n    can_call_sensitive: false\\n    auth_token_env: MY_AGENT_TOKEN   # then set MY_AGENT_TOKEN as an env var"]));
    }
    if (o.trusted_proxies.length) you.appendChild(el("p", { class: "muted" }, ["Forwarding headers trusted from: " + o.trusted_proxies.join(", ")]));

    // Configuration
    var cfg = clear($("config"));
    [["Providers dir", o.config.providers_dir], ["Hosts file", o.config.hosts_file],
     ["Plugins dir", o.config.plugins_dir],
     ["Default provider", o.default_provider || "(none — X-Provider required)"],
     ["Live reload", o.config.watch == null ? "—" : (o.config.watch ? "on — edits apply without a restart" : "off — restart after editing")],
     ["Last loaded", fmtTime(o.config.loaded_at) + (o.config.reloads ? " (" + o.config.reloads + " reload" + (o.config.reloads === 1 ? "" : "s") + ")" : "")]
    ].forEach(function (kv) { cfg.appendChild(el("dt", null, [kv[0]])); cfg.appendChild(el("dd", null, [kv[1] == null ? "—" : String(kv[1])])); });
    var pr = clear($("problems"));
    if (o.config.problems.length) {
      pr.appendChild(el("p", null, [pill(o.config.problems.length + " problem" + (o.config.problems.length === 1 ? "" : "s"), "bad")]));
      pr.appendChild(el("ul", { class: "problems" }, o.config.problems.map(function (p) {
        return el("li", null, [code(p.scope + (p.source ? " · " + p.source : "")), " " + p.message]);
      })));
    }

    // Storage
    var s = clear($("storage"));
    if (!o.storage) s.appendChild(el("p", { class: "empty" }, ["no probe available"]));
    else s.appendChild(el("p", null, [pill(o.storage.ok ? "connected" : "unreachable", o.storage.ok ? "ok" : "bad"), " " + o.storage.detail]));
    if (o.storage && !o.storage.ok) s.appendChild(el("p", { class: "muted" }, ["Tokens, rate limits and caching need it; requests will fail until it is back."]));

    // Providers — loaded ones, then any that failed to load, as Traefik lists errored routers.
    var pv = clear($("providers"));
    var failed = o.config.problems.filter(function (p) { return p.scope === "provider"; });
    if (!o.providers.length && !failed.length) {
      pv.appendChild(el("p", { class: "empty" }, ["No providers loaded. Drop a YAML into the providers directory" + (o.config.watch ? " — it is picked up automatically." : " and restart.")]));
    } else {
      var rows = o.providers.map(function (p) {
        var creds = p.auth.credentials.length ? [] : [el("span", { class: "muted" }, ["none"])];
        p.auth.credentials.forEach(function (c, i) {
          if (i) creds.push(" ");
          creds.push(pill(c.env, c.set === false ? "bad" : c.set ? "ok" : "warn"));
        });
        var fwd = p.forwarding.mode === "allowlist"
          ? "allowlist · " + p.forwarding.allow.length + " rule" + (p.forwarding.allow.length === 1 ? "" : "s")
          : "transparent" + (p.forwarding.treat_writes_as_sensitive ? " · writes sensitive" : "");
        if (p.forwarding.deny.length) fwd += " · " + p.forwarding.deny.length + " denied";
        var rl = Object.keys(p.forwarding.rate_limits).map(function (cat) {
          return cat + ": " + p.forwarding.rate_limits[cat].map(function (w) { return w.capacity + "/" + (w.window_ms / 1000) + "s"; }).join(", ");
        }).join(" · ") || "none";
        return [[el("strong", null, [p.name]), p.description ? el("div", { class: "muted" }, [p.description]) : ""],
                code(p.base_url), code(p.auth.type), creds, fwd, el("span", { class: "mono" }, [rl])];
      });
      failed.forEach(function (f) {
        rows.push([[el("strong", null, [f.source || "?"]), " ", pill("failed to load", "bad")],
                   { colspan: 5, content: [el("span", { class: "muted" }, [f.message])] }]);
      });
      pv.appendChild(table(["Name", "Upstream", "Auth", "Credentials", "Forwarding", "Rate limits"], rows));
    }
    if (o.disabled_providers.length) {
      pv.appendChild(el("p", { class: "muted" }, ["Disabled: " + o.disabled_providers.map(function (d) { return d.name + " (" + d.source + ")"; }).join(", ")]));
    }

    // Hosts
    var hs = clear($("hosts"));
    if (!o.hosts.length) hs.appendChild(el("p", { class: "empty" }, ["hosts.yaml has no entries — every request is denied."]));
    else hs.appendChild(table(["Host", "CIDRs", "Sensitive calls", "Pre-shared key", "Description"], o.hosts.map(function (h) {
      return [code(h.id), el("span", { class: "mono" }, [h.cidrs.join(", ")]),
              pill(h.can_call_sensitive ? "allowed" : "denied", h.can_call_sensitive ? "warn" : "ok"),
              h.psk_env ? [pill("required", "ok"), " ", code(h.psk_env)] : pill("none", "warn"),
              el("span", { class: "muted" }, [h.description || ""])];
    })));
  }

  function refresh() {
    fetch("/api/overview", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(render).catch(function (e) {
      var st = $("status"); st.textContent = "unreachable"; st.className = "pill bad";
      $("uptime").textContent = String(e.message || e);
    });
  }
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
