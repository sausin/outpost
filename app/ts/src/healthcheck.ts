/**
 * Standalone container healthcheck — `node dist/healthcheck.js`.
 *
 * Why a dedicated entrypoint rather than `curl`/`wget`: app catalogs (TrueNAS,
 * Unraid) run the health probe as a binary *inside* the container, and slim
 * runtime images can't be relied on to ship an HTTP client. Node is by
 * definition present here, so this has zero footprint and no extra layer.
 *
 * Exits 0 when GET /healthz answers 200, 1 otherwise (including timeout).
 */

import http from "node:http";

const port = Number(
  process.env["OUTPOST_PORT"] ?? process.env["PROXY_PORT"] ?? "8080",
);
const timeoutMs = Number(process.env["OUTPOST_HEALTHCHECK_TIMEOUT_MS"] ?? 2000);

const req = http.get(
  { host: "127.0.0.1", port, path: "/healthz", timeout: timeoutMs },
  (res) => {
    // Drain so the socket closes cleanly instead of lingering until timeout.
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);

req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});

req.on("error", () => process.exit(1));
