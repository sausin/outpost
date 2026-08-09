/**
 * Generic OpenAPI 3.1 spec for Outpost — port of app/python/openapi_spec.py.
 *
 * It describes the *proxy's* semantics, not the upstream endpoints: the
 * catch-all forwarder, the management routes, and the error envelope.
 * Registered providers show up as an enum on the X-Provider parameter, so the
 * Swagger page at /docs doubles as a live view of what this instance can talk
 * to. This is the only browser-facing page Outpost serves.
 */

const PROXY_METHODS = ["get", "post", "put", "delete", "patch"] as const;

function proxyOperation(method: string): Record<string, unknown> {
  const parameters: Array<Record<string, unknown>> = [
    {
      name: "path",
      in: "path",
      required: true,
      schema: { type: "string" },
      description: "Full path forwarded verbatim to the upstream base URL",
    },
    { $ref: "#/components/parameters/XProvider" },
  ];
  if (method === "POST") {
    parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
  }

  const op: Record<string, unknown> = {
    tags: ["proxy"],
    summary: `Proxy ${method} to upstream`,
    description:
      `Forward a \`${method}\` request to the upstream provider identified by \`X-Provider\`. ` +
      "The proxy injects auth credentials, enforces rate limits, applies host policy, " +
      "and (for GET) may return a cached response.\n\n" +
      "Response headers added by the proxy:\n" +
      "- `X-Proxy-Provider` — the provider that handled the request\n" +
      "- `X-Proxy-Cache` — `HIT`, `MISS`, `BYPASS`, or `IDEMPOTENT-HIT`",
    parameters,
    responses: {
      "200": { description: "Upstream response (status code is forwarded as-is)" }, // prettier-ignore
      "400": { $ref: "#/components/responses/ProxyError" },
      "403": { $ref: "#/components/responses/ProxyError" },
      "404": { $ref: "#/components/responses/ProxyError" },
      "429": { $ref: "#/components/responses/RateLimited" },
      "502": { $ref: "#/components/responses/ProxyError" },
    },
  };

  if (["POST", "PUT", "PATCH"].includes(method)) {
    op["requestBody"] = {
      required: false,
      content: { "application/json": { schema: { type: "object" } } },
      description: "Request body forwarded verbatim to the upstream",
    };
  }

  return op;
}

export function buildOpenApi(providerNames: string[] = []): object {
  const providerEnum = [...providerNames].sort();

  const xProvider: Record<string, unknown> = {
    name: "X-Provider",
    in: "header",
    required: false,
    description:
      "Target provider name (e.g. `groww`, `stripe`). " +
      "Also accepted as `X-Broker` for backward compatibility. " +
      "Required when `DEFAULT_PROVIDER` is not set. " +
      "See `GET /providers` for the list of registered providers.",
    schema:
      providerEnum.length > 0
        ? { type: "string", enum: providerEnum }
        : { type: "string" },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Outpost — The edge sidecar for AI agents",
      version: "0.1.0",
      description:
        "Outpost transparently forwards HTTP requests from AI agents to upstream " +
        "REST APIs, injecting auth credentials, enforcing rate limits, caching responses, " +
        "and applying per-host access control. Providers are configured via YAML files — " +
        "no code changes needed to add a new upstream.\n\n" +
        "**Routing**: set `X-Provider: <name>` on every request (or configure " +
        "`DEFAULT_PROVIDER`). The proxy strips the header before forwarding.\n\n" +
        "**Registered providers**: see `GET /providers`.",
    },
    servers: [{ url: "/", description: "This proxy instance" }],
    tags: [
      { name: "proxy", description: "Generic catch-all forwarding endpoint" },
      { name: "management", description: "Proxy health, introspection, and docs" }, // prettier-ignore
    ],
    components: {
      schemas: {
        ProxyError: {
          type: "object",
          required: ["status", "error"],
          properties: {
            status: { type: "string", enum: ["FAILURE"] },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  description: "Machine-readable error code",
                  examples: [
                    "PROXY_UNKNOWN_PROVIDER",
                    "PROXY_HOST_DENIED",
                    "PROXY_AUTH_REQUIRED",
                    "PROXY_NO_ROUTE",
                    "PROXY_PATH_DENIED",
                    "PROXY_SENSITIVE_DENIED",
                    "PROXY_RATE_LIMITED",
                    "PROXY_UPSTREAM_RATE_LIMITED",
                    "PROXY_AUTH_ERROR",
                    "PROXY_UPSTREAM_ERROR",
                  ],
                },
                message: { type: "string" },
                metadata: {
                  nullable: true,
                  description:
                    "Extra context (available providers, retry_after, etc.)",
                },
              },
            },
          },
        },
        HealthResponse: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["ok"] },
            providers: {
              type: "array",
              items: { type: "string" },
              description: "Names of all registered and enabled providers",
            },
          },
        },
        ProvidersResponse: {
          type: "object",
          properties: {
            providers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  base_url: { type: "string" },
                },
              },
            },
          },
        },
      },
      parameters: {
        XProvider: xProvider,
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          schema: { type: "string" },
          description:
            "Optional. Identical POST requests with the same key within 24 h " +
            "return the cached response without forwarding upstream.",
        },
      },
      responses: {
        ProxyError: {
          description: "Proxy-originated error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProxyError" },
            },
          },
        },
        RateLimited: {
          description: "Rate limit exceeded (proxy or upstream)",
          headers: {
            "Retry-After": {
              schema: { type: "integer" },
              description: "Seconds until the client may retry",
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProxyError" },
            },
          },
        },
      },
    },
    paths: {
      "/healthz": {
        get: {
          tags: ["management"],
          summary: "Liveness probe",
          description:
            "Returns `{status: ok}` when the proxy is running. Always 200 once " +
            "the process is up, including when zero providers are configured.",
          responses: {
            "200": {
              description: "Proxy is healthy",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                },
              },
            },
          },
        },
      },
      "/providers": {
        get: {
          tags: ["management"],
          summary: "List registered providers",
          description:
            "Returns every provider that loaded successfully at startup.",
          responses: {
            "200": {
              description: "Provider list",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ProvidersResponse" },
                },
              },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["management"],
          summary: "This OpenAPI spec (dynamically generated)",
          responses: { "200": { description: "OpenAPI 3.1 document" } },
        },
      },
      "/docs": {
        get: {
          tags: ["management"],
          summary: "Swagger UI",
          responses: { "200": { description: "HTML page" } },
        },
      },
      "/{path}": Object.fromEntries(
        PROXY_METHODS.map((m) => [m, proxyOperation(m.toUpperCase())]),
      ),
    },
  };
}

/**
 * Swagger UI shell. The bundle is pulled from jsDelivr at view time (same as
 * the Python runtime) — shipping ~1.5 MB of vendored JS into a sidecar image
 * for a page that is only ever opened by a human isn't a good trade.
 */
export const SWAGGER_UI_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Outpost</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>SwaggerUIBundle({ url: "openapi.json", dom_id: "#ui" });</script>
  </body>
</html>
`;
