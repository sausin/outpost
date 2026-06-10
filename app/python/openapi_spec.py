"""Generic OpenAPI 3.1 spec for Outpost.

Describes proxy semantics rather than upstream endpoints.
Registered providers appear as an enum on X-Provider.
"""

from __future__ import annotations


def build_openapi(provider_names: list[str] | None = None) -> dict:
    provider_enum = sorted(provider_names) if provider_names else []

    x_provider_param: dict = {
        "name": "X-Provider",
        "in": "header",
        "required": False,
        "description": (
            "Target provider name (e.g. `groww`, `stripe`). "
            "Also accepted as `X-Broker` for backward compatibility. "
            "Required when `DEFAULT_PROVIDER` is not set. "
            "See `GET /providers` for the list of registered providers."
        ),
        "schema": {"type": "string"},
    }
    if provider_enum:
        x_provider_param["schema"] = {"type": "string", "enum": provider_enum}

    return {
        "openapi": "3.1.0",
        "info": {
            "title": "Outpost — The edge sidecar for AI agents",
            "version": "0.1.0",
            "description": (
                "Outpost transparently forwards HTTP requests from AI agents to upstream "
                "REST APIs, injecting auth credentials, enforcing rate limits, caching responses, "
                "and applying per-host access control. Providers are configured via YAML files — "
                "no code changes needed to add a new upstream.\n\n"
                "**Routing**: set `X-Provider: <name>` on every request (or configure "
                "`DEFAULT_PROVIDER`). The proxy strips the header before forwarding.\n\n"
                "**Registered providers**: see `GET /providers`."
            ),
        },
        "servers": [{"url": "/", "description": "This proxy instance"}],
        "tags": [
            {"name": "proxy", "description": "Generic catch-all forwarding endpoint"},
            {"name": "management", "description": "Proxy health, introspection, and docs"},
        ],
        "components": {
            "schemas": {
                "ProxyError": {
                    "type": "object",
                    "required": ["status", "error"],
                    "properties": {
                        "status": {"type": "string", "enum": ["FAILURE"]},
                        "error": {
                            "type": "object",
                            "required": ["code", "message"],
                            "properties": {
                                "code": {
                                    "type": "string",
                                    "description": "Machine-readable error code",
                                    "examples": [
                                        "PROXY_UNKNOWN_PROVIDER",
                                        "PROXY_HOST_DENIED",
                                        "PROXY_NO_ROUTE",
                                        "PROXY_PATH_DENIED",
                                        "PROXY_SENSITIVE_DENIED",
                                        "PROXY_RATE_LIMITED",
                                        "PROXY_UPSTREAM_RATE_LIMITED",
                                        "PROXY_AUTH_ERROR",
                                        "PROXY_UPSTREAM_ERROR",
                                    ],
                                },
                                "message": {"type": "string"},
                                "metadata": {
                                    "nullable": True,
                                    "description": "Extra context (available providers, retry_after, etc.)",
                                },
                            },
                        },
                    },
                },
                "HealthResponse": {
                    "type": "object",
                    "properties": {
                        "status": {"type": "string", "enum": ["ok"]},
                        "providers": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Names of all registered and enabled providers",
                        },
                    },
                },
                "ProvidersResponse": {
                    "type": "object",
                    "properties": {
                        "providers": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "base_url": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
            "parameters": {
                "XProvider": x_provider_param,
                "IdempotencyKey": {
                    "name": "Idempotency-Key",
                    "in": "header",
                    "required": False,
                    "schema": {"type": "string"},
                    "description": (
                        "Optional. Identical POST requests with the same key within 24 h "
                        "return the cached response without forwarding upstream."
                    ),
                },
            },
            "responses": {
                "ProxyError": {
                    "description": "Proxy-originated error",
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/ProxyError"}}
                    },
                },
                "RateLimited": {
                    "description": "Rate limit exceeded (proxy or upstream)",
                    "headers": {
                        "Retry-After": {
                            "schema": {"type": "integer"},
                            "description": "Seconds until the client may retry",
                        }
                    },
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/ProxyError"}}
                    },
                },
            },
        },
        "paths": {
            "/healthz": {
                "get": {
                    "tags": ["management"],
                    "summary": "Liveness probe",
                    "description": "Returns `{status: ok}` when the proxy is running.",
                    "responses": {
                        "200": {
                            "description": "Proxy is healthy",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/HealthResponse"}
                                }
                            },
                        }
                    },
                }
            },
            "/providers": {
                "get": {
                    "tags": ["management"],
                    "summary": "List registered providers",
                    "description": "Returns every provider that loaded successfully at startup.",
                    "responses": {
                        "200": {
                            "description": "Provider list",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ProvidersResponse"}
                                }
                            },
                        }
                    },
                }
            },
            "/openapi.json": {
                "get": {
                    "tags": ["management"],
                    "summary": "This OpenAPI spec (dynamically generated)",
                    "responses": {"200": {"description": "OpenAPI 3.1 document"}},
                }
            },
            "/docs": {
                "get": {
                    "tags": ["management"],
                    "summary": "Swagger UI",
                    "responses": {"200": {"description": "HTML page"}},
                }
            },
            "/{path}": {
                "get": _proxy_op("GET"),
                "post": _proxy_op("POST"),
                "put": _proxy_op("PUT"),
                "delete": _proxy_op("DELETE"),
                "patch": _proxy_op("PATCH"),
            },
        },
    }


def _proxy_op(method: str) -> dict:
    description = (
        f"Forward a `{method}` request to the upstream provider identified by `X-Provider`. "
        "The proxy injects auth credentials, enforces rate limits, applies host policy, "
        "and (for GET) may return a cached response.\n\n"
        "Response headers added by the proxy:\n"
        "- `X-Proxy-Provider` — the provider that handled the request\n"
        "- `X-Proxy-Cache` — `HIT`, `MISS`, `BYPASS`, or `IDEMPOTENT-HIT`"
    )
    params: list[dict] = [
        {
            "name": "path",
            "in": "path",
            "required": True,
            "schema": {"type": "string"},
            "description": "Full path forwarded verbatim to the upstream base URL",
        },
        {"$ref": "#/components/parameters/XProvider"},
    ]
    if method == "POST":
        params.append({"$ref": "#/components/parameters/IdempotencyKey"})

    responses: dict = {
        "200": {"description": "Upstream response (status code is forwarded as-is)"},
        "400": {"$ref": "#/components/responses/ProxyError"},
        "403": {"$ref": "#/components/responses/ProxyError"},
        "404": {"$ref": "#/components/responses/ProxyError"},
        "429": {"$ref": "#/components/responses/RateLimited"},
        "502": {"$ref": "#/components/responses/ProxyError"},
    }

    op: dict = {
        "tags": ["proxy"],
        "summary": f"Proxy {method} to upstream",
        "description": description,
        "parameters": params,
        "responses": responses,
    }
    if method in ("POST", "PUT", "PATCH"):
        op["requestBody"] = {
            "required": False,
            "content": {"application/json": {"schema": {"type": "object"}}},
            "description": "Request body forwarded verbatim to the upstream",
        }
    return op
