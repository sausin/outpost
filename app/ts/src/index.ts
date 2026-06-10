/**
 * Shared Hono application — the real proxy flow.
 * Mirrors app/python/main.py exactly.
 *
 * Both runtimes mount this:
 *   Workers: src/adapter/workers.ts
 *   Node:    src/adapter/node.ts
 */

import { Hono } from "hono";

import { CODES, errorResponse } from "./core/errors.ts";
import type { HostResolver } from "./core/hosts.ts";
import {
  cacheKey,
  idemKey,
  IDEM_TTL_SECONDS,
  queryHash,
} from "./core/cache_keys.ts";
import type { AuthContext } from "./core/types.ts";
import type { GenericProvider } from "./providers/provider.ts";
import type { RateLimitBackend, CacheBackend } from "./storage/interface.ts";
import { RateLimitedError } from "./storage/interface.ts";

// ─── hop-by-hop headers stripped from the incoming request before forwarding ──
const REQUEST_HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "x-broker",
  "x-provider",
  // Strip the PSK so it never leaks to upstream.
  "x-outpost-auth",
]);

// ─── hop-by-hop headers stripped from the upstream response ───────────────────
// content-encoding is intentionally included: fetch decompresses transparently
// so we forward the raw decompressed bytes — advertising gzip/br encoding would
// be wrong.
const RESPONSE_HOP_BY_HOP = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
  "content-length",
]);

// ─── Constant-time string compare — prevents timing attacks on PSK checks ─────
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Base64 helpers for byte-transparent cache serialisation ──────────────────
function bytesToBase64(bytes: Uint8Array): string {
  // Workers + Node 22 both have btoa() that accepts a binary string.
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface AppDeps {
  providers: Map<string, GenericProvider>;
  hosts: HostResolver;
  rateLimits: RateLimitBackend;
  cache: CacheBackend;
  defaultProvider: string;
}

/** Log warning once per X-Broker usage to nudge callers to migrate. */
const _brokerWarnedProviders = new Set<string>();

export function buildApp(deps: AppDeps): Hono {
  const { providers, hosts, rateLimits, cache, defaultProvider } = deps;

  const app = new Hono();

  // ── /healthz ───────────────────────────────────────────────────────────────
  app.get("/healthz", (c) =>
    c.json({ status: "ok", providers: [...providers.keys()].sort() }),
  );

  // ── /providers ────────────────────────────────────────────────────────────
  app.get("/providers", (c) =>
    c.json({
      providers: [...providers.values()].map((p) => ({
        name: p.name,
        base_url: p.baseUrl,
      })),
    }),
  );

  // ── catch-all proxy ───────────────────────────────────────────────────────
  app.all("*", async (c) => {
    const req = c.req.raw;
    const method = req.method;
    const url = new URL(req.url);
    const fullPath = url.pathname;

    // ── 1. Resolve provider ──────────────────────────────────────────────────
    const providerHeader = req.headers.get("x-provider");
    const brokerHeader = req.headers.get("x-broker");

    let providerName: string;
    if (providerHeader) {
      providerName = providerHeader.toLowerCase();
    } else if (brokerHeader) {
      providerName = brokerHeader.toLowerCase();
      // Warn once per provider name to avoid log spam on high-traffic deployments.
      if (!_brokerWarnedProviders.has(providerName)) {
        _brokerWarnedProviders.add(providerName);
        console.warn(
          `[proxy] X-Broker header used for routing (provider=${providerName}); migrate to X-Provider`,
        );
      }
    } else {
      providerName = (defaultProvider ?? "").toLowerCase();
    }

    if (!providerName || !providers.has(providerName)) {
      return errorResponse(
        400,
        CODES.UNKNOWN_PROVIDER,
        `Unknown or unspecified provider '${providerName}'`,
        { available: [...providers.keys()].sort() },
      );
    }

    const provider = providers.get(providerName)!;

    // ── 2. Client IP ─────────────────────────────────────────────────────────
    // Workers: cf-connecting-ip is the real client IP set by the CF edge.
    // Node behind a trusted proxy: first value from X-Forwarded-For.
    const ip =
      req.headers.get("cf-connecting-ip") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";

    // ── 3. Host policy ───────────────────────────────────────────────────────
    const policy = hosts.resolve(ip);
    if (policy === null) {
      return errorResponse(
        403,
        CODES.HOST_DENIED,
        `Source IP ${ip} not in host policy`,
      );
    }

    // ── 3a. Per-host PSK auth ─────────────────────────────────────────────────
    if (policy.authToken) {
      const provided = req.headers.get("x-outpost-auth") ?? "";
      if (
        provided.length === 0 ||
        !constantTimeEqual(provided, policy.authToken)
      ) {
        console.warn(
          `[proxy] PSK auth failed for host '${policy.id}' from ${ip}`,
        );
        return errorResponse(
          401,
          CODES.AUTH_REQUIRED,
          `Authentication required for host '${policy.id}'`,
          null,
          { "WWW-Authenticate": 'X-Outpost-Auth realm="outpost"' },
        );
      }
    }

    // ── 4. Guard empty path ──────────────────────────────────────────────────
    if (!fullPath || fullPath === "/") {
      return errorResponse(404, CODES.NO_ROUTE, "Empty path");
    }

    // ── 5. Deny check ────────────────────────────────────────────────────────
    if (provider.isDenied(fullPath)) {
      return errorResponse(
        403,
        CODES.PATH_DENIED,
        `Path ${fullPath} is denied for provider '${providerName}'`,
      );
    }

    // ── 6. Route classification ──────────────────────────────────────────────
    const route = provider.classify(method, fullPath);
    if (route === null) {
      return errorResponse(
        404,
        CODES.NO_ROUTE,
        `No matching route for ${method} ${fullPath}`,
      );
    }

    // ── 7. Sensitive check ───────────────────────────────────────────────────
    if (route.sensitive && !policy.canCallSensitive) {
      console.warn(
        `[proxy] host=${policy.id} ip=${ip} attempted sensitive op ${method} ${fullPath} [provider=${providerName}]`,
      );
      return errorResponse(
        403,
        CODES.SENSITIVE_DENIED,
        `Host '${policy.id}' is not permitted to call sensitive endpoints`,
      );
    }

    // ── 8. Idempotency cache check (POST + Idempotency-Key) ──────────────────
    const idemHeader = req.headers.get("idempotency-key");
    let cacheState = "BYPASS";

    if (method === "POST" && idemHeader) {
      const ikey = idemKey(providerName, idemHeader);
      const cached = await cache.get(ikey);
      if (cached !== null) {
        console.info(
          `[proxy] method=${method} path=${fullPath} provider=${providerName} status=${cached.statusCode} category=${route.category} cache=IDEMPOTENT-HIT`,
        );
        const cachedBytes = base64ToBytes(cached.bodyBase64);
        return new Response(cachedBytes, {
          status: cached.statusCode,
          headers: {
            "content-type": cached.contentType,
            "x-proxy-cache": "IDEMPOTENT-HIT",
            "x-proxy-provider": providerName,
          },
        });
      }
    }

    // ── 9. Response cache check (GET, cacheTtl > 0) ──────────────────────────
    let ckey: string | null = null;
    if (method === "GET" && route.cacheTtl > 0) {
      ckey = await cacheKey(
        providerName,
        method,
        fullPath,
        url.search.slice(1),
      );
      const cached = await cache.get(ckey);
      if (cached !== null) {
        console.info(
          `[proxy] method=${method} path=${fullPath} provider=${providerName} status=${cached.statusCode} category=${route.category} cache=HIT`,
        );
        const cachedBytes = base64ToBytes(cached.bodyBase64);
        return new Response(cachedBytes, {
          status: cached.statusCode,
          headers: {
            "content-type": cached.contentType,
            "x-proxy-cache": "HIT",
            "x-proxy-provider": providerName,
          },
        });
      }
      cacheState = "MISS";
    }

    // ── 10. Rate-limit acquire ────────────────────────────────────────────────
    const windows = provider.windowsFor(route.category);
    if (windows.length > 0) {
      try {
        // Queue timeout hard-coded at 5 s; Phase 5 can expose it via config.
        await rateLimits.acquire(providerName, route.category, windows, 5_000);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          console.info(
            `[proxy] method=${method} path=${fullPath} provider=${providerName} status=429 category=${route.category} cache=${cacheState}`,
          );
          return errorResponse(
            429,
            CODES.RATE_LIMITED,
            `Rate limit exceeded for category '${route.category}'`,
            { retry_after: Math.round(err.retryAfterSeconds * 1000) / 1000 },
            {
              "Retry-After": String(
                Math.max(1, Math.floor(err.retryAfterSeconds)),
              ),
            },
          );
        }
        throw err;
      }
    }

    // ── 11. Apply auth ────────────────────────────────────────────────────────
    const originalBody = req.body ? await req.arrayBuffer() : null;

    const authCtx: AuthContext = {
      method,
      fullPath,
      queryString: url.search.slice(1),
      body: originalBody,
      headers: req.headers,
    };

    let authResult;
    try {
      authResult = await provider.auth.apply(authCtx);
    } catch (err) {
      console.error(`[proxy] Auth failed for provider=${providerName}`, err);
      return errorResponse(
        502,
        CODES.AUTH_ERROR,
        `Auth module error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 12. Build forward headers ─────────────────────────────────────────────
    const fwdHeaders = new Headers();
    for (const [k, v] of req.headers.entries()) {
      if (!REQUEST_HOP_BY_HOP.has(k.toLowerCase())) {
        fwdHeaders.set(k, v);
      }
    }
    for (const [k, v] of Object.entries(provider.defaultHeaders)) {
      fwdHeaders.set(k, v);
    }
    if (authResult.headers) {
      for (const [k, v] of Object.entries(authResult.headers)) {
        fwdHeaders.set(k, v);
      }
    }

    // ── Merge query params ────────────────────────────────────────────────────
    const fwdParams = new URLSearchParams(url.search);
    if (authResult.queryParams) {
      for (const [k, v] of Object.entries(authResult.queryParams)) {
        fwdParams.set(k, v);
      }
    }
    const mergedQuery = fwdParams.toString();

    // ── Body override ─────────────────────────────────────────────────────────
    const fwdBody =
      authResult.bodyOverride !== undefined
        ? authResult.bodyOverride
        : originalBody;

    // ── 13. Forward request ───────────────────────────────────────────────────
    const targetUrl = `${provider.baseUrl}${fullPath}${mergedQuery ? `?${mergedQuery}` : ""}`;

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method,
        headers: fwdHeaders,
        body: fwdBody,
        // Propagate redirect policy; upstream APIs typically don't redirect.
        redirect: "follow",
      });
    } catch (err) {
      console.error(
        `[proxy] Upstream request failed provider=${providerName} path=${fullPath}`,
        err,
      );
      return errorResponse(
        502,
        CODES.UPSTREAM_ERROR,
        `Upstream error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 14. Upstream 429 handling ─────────────────────────────────────────────
    if (upstream.status === 429) {
      let retryAfter = 1.0;
      const retryAfterHeader = upstream.headers.get("retry-after");
      if (retryAfterHeader) {
        const parsed = parseFloat(retryAfterHeader);
        if (Number.isFinite(parsed)) retryAfter = parsed;
      }

      await rateLimits.noteUpstream429(
        providerName,
        route.category,
        retryAfter,
      );

      // JSON-parse the 429 body only when content-type says it's JSON.
      // Non-JSON 429s get null metadata — status code rejection still works.
      let upstreamBody: unknown = null;
      const ct429 = upstream.headers.get("content-type") ?? "";
      if (ct429.toLowerCase().includes("application/json")) {
        try {
          upstreamBody = await upstream.json();
        } catch {
          upstreamBody = null;
        }
      } else {
        // Drain the body to avoid resource leaks.
        await upstream.text().catch(() => {});
      }

      console.info(
        `[proxy] method=${method} path=${fullPath} provider=${providerName} status=429 category=${route.category} cache=${cacheState} upstream=429`,
      );

      return errorResponse(
        429,
        CODES.UPSTREAM_RATE_LIMITED,
        "Upstream returned 429",
        { upstream_body: upstreamBody, retry_after: retryAfter },
        { "Retry-After": String(Math.max(1, Math.floor(retryAfter))) },
      );
    }

    // ── 15. Read raw bytes once — fetch decompresses transparently ────────────
    // These are the post-decompression bytes we'll forward verbatim.
    const upstreamBytes = new Uint8Array(await upstream.arrayBuffer());
    const upstreamContentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";

    // ── 16. Auth-rejection check ──────────────────────────────────────────────
    // JSON-parse ONLY for the auth-rejection body inspection and only when the
    // content-type says it's JSON. Non-JSON responses still go through the
    // status-code rejection path inside isRejection().
    let bodyForAuthCheck: unknown = null;
    if (upstreamContentType.toLowerCase().includes("application/json")) {
      try {
        const text = new TextDecoder().decode(upstreamBytes);
        bodyForAuthCheck = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        bodyForAuthCheck = null;
      }
    }

    if (provider.auth.isRejection(upstream.status, bodyForAuthCheck)) {
      await provider.auth.invalidate();
    }

    // ── 17. Persist response cache + idempotency on 2xx ──────────────────────
    if (upstream.status >= 200 && upstream.status < 300) {
      const entry = {
        statusCode: upstream.status,
        bodyBase64: bytesToBase64(upstreamBytes),
        contentType: upstreamContentType,
      };

      if (ckey !== null) {
        await cache.put(ckey, entry, route.cacheTtl);
      }

      if (method === "POST" && idemHeader) {
        await cache.put(
          idemKey(providerName, idemHeader),
          entry,
          IDEM_TTL_SECONDS,
        );
      }
    }

    // ── 18. Strip response headers, add proxy metadata, return ───────────────
    const respHeaders = new Headers();
    for (const [k, v] of upstream.headers.entries()) {
      const kl = k.toLowerCase();
      // RESPONSE_HOP_BY_HOP already excludes content-encoding (we forward decompressed
      // bytes). Content-Type, Cache-Control, Retry-After, etc. pass through verbatim.
      if (
        !RESPONSE_HOP_BY_HOP.has(kl) &&
        !provider.stripResponseHeaders.has(kl)
      ) {
        respHeaders.set(k, v);
      }
    }
    respHeaders.set("x-proxy-cache", cacheState);
    respHeaders.set("x-proxy-provider", providerName);

    console.info(
      `[proxy] method=${method} path=${fullPath} provider=${providerName} status=${upstream.status} category=${route.category} cache=${cacheState}`,
    );

    return new Response(upstreamBytes, {
      status: upstream.status,
      headers: respHeaders,
    });
  });

  return app;
}

/**
 * Compute a stable query hash for use in cache keys.
 * Re-exported so adapters don't need to import cache_keys directly.
 */
export { queryHash };
