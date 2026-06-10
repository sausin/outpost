"""FastAPI app: generic auth-injecting reverse proxy."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from redis.asyncio import Redis

from app.python.auth.base import AuthContext
from app.python.core import cache as cache_mod
from app.python.core.config import settings
from app.python.core.errors import (
    CODE_AUTH_ERROR,
    CODE_HOST_DENIED,
    CODE_NO_ROUTE,
    CODE_PATH_DENIED,
    CODE_RATE_LIMITED,
    CODE_SENSITIVE_DENIED,
    CODE_UNKNOWN_PROVIDER,
    CODE_UPSTREAM_ERROR,
    CODE_UPSTREAM_RATE_LIMITED,
    error_response,
)
from app.python.core.hosts import HostResolver
from app.python.core.ratelimit import RateLimited, RateLimiter
from app.python.openapi_spec import build_openapi
from app.python.providers.loader import aclose_providers, build_providers

log = logging.getLogger(__name__)

# Headers stripped from the incoming request before forwarding.
HOP_BY_HOP = {
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "authorization",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-real-ip",
    "x-broker",  # legacy routing header — strip before forwarding
    "x-provider",  # routing header — strip before forwarding
}

# Headers stripped from the upstream response before returning to the client.
RESPONSE_HOP_BY_HOP = {"content-encoding", "transfer-encoding", "connection", "content-length"}


def _client_ip(request: Request) -> str:
    if settings.trusted_proxies:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.redis = redis
    app.state.providers = build_providers(redis)
    if not app.state.providers:
        log.warning("No providers enabled — all proxy requests will fail with 400")
    app.state.hosts = HostResolver(settings.hosts_config_path)
    app.state.limiter = RateLimiter(redis, settings.rate_limit_queue_timeout)
    log.info("Outpost ready; providers=%s", list(app.state.providers))
    try:
        yield
    finally:
        await aclose_providers(app.state.providers)
        await redis.aclose()


app = FastAPI(
    title="Outpost — The edge sidecar for AI agents",
    description=(
        "Outpost forwards your agent's HTTP calls to any upstream API with "
        "auth injection, rate-limiting, response caching, idempotency, and "
        "host-based access control. Providers are declared in YAML."
    ),
    version="0.1.0",
    lifespan=lifespan,
    openapi_url=None,
    docs_url=None,
    redoc_url=None,
)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"status": "ok", "providers": sorted(app.state.providers.keys())}


@app.get("/openapi.json", include_in_schema=False)
async def openapi_json():
    return build_openapi(provider_names=sorted(app.state.providers.keys()))


@app.get("/docs", include_in_schema=False)
async def swagger_ui():
    from fastapi.responses import HTMLResponse

    return HTMLResponse(
        "<!doctype html><html><head><title>Outpost</title>"
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">'
        '</head><body><div id="ui"></div>'
        '<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>'
        "<script>SwaggerUIBundle({url: '/openapi.json', dom_id: '#ui'});</script>"
        "</body></html>"
    )


@app.get("/providers", include_in_schema=False)
async def list_providers():
    providers: dict = app.state.providers
    return {"providers": [{"name": p.name, "base_url": p.base_url} for p in providers.values()]}


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    include_in_schema=False,
)
async def proxy(path: str, request: Request) -> Response:
    method = request.method
    full_path = f"/{path}"

    # 1. Resolve provider from X-Provider (preferred) or X-Broker (legacy compat).
    provider_header = request.headers.get("x-provider")
    broker_header = request.headers.get("x-broker")
    if provider_header:
        provider_name = provider_header.lower()
    elif broker_header:
        provider_name = broker_header.lower()
        log.info(
            "X-Broker header used for routing (provider=%s); migrate to X-Provider",
            provider_name,
        )
    else:
        provider_name = (settings.default_provider or "").lower()

    providers: dict = app.state.providers

    if not provider_name or provider_name not in providers:
        return error_response(
            400,
            CODE_UNKNOWN_PROVIDER,
            f"Unknown or unspecified provider '{provider_name}'",
            metadata={"available": sorted(providers.keys())},
        )
    provider = providers[provider_name]

    # 2. Host policy.
    ip = _client_ip(request)
    policy = app.state.hosts.resolve(ip)
    if policy is None:
        return error_response(403, CODE_HOST_DENIED, f"Source IP {ip} not in host policy")

    # 3. full_path already set; guard empty path.
    if full_path == "/":
        return error_response(404, CODE_NO_ROUTE, "Empty path")

    # 4. Deny check.
    if provider.is_denied(full_path):
        return error_response(
            403, CODE_PATH_DENIED, f"Path {full_path} is denied for provider '{provider_name}'"
        )

    # 5. Route classification.
    route = provider.classify(method, full_path)
    if route is None:
        return error_response(404, CODE_NO_ROUTE, f"No matching route for {method} {full_path}")

    # 6. Sensitive check.
    if route.sensitive and not policy.can_call_sensitive:
        log.warning(
            "host=%s ip=%s attempted sensitive op %s %s [provider=%s]",
            policy.id,
            ip,
            method,
            full_path,
            provider_name,
        )
        return error_response(
            403,
            CODE_SENSITIVE_DENIED,
            f"Host '{policy.id}' is not permitted to call sensitive endpoints",
        )

    # 7. Idempotency cache check (POST + Idempotency-Key header).
    idem_header = request.headers.get("idempotency-key")
    cache_state = "BYPASS"
    if method == "POST" and idem_header:
        ikey = cache_mod.idem_key(provider_name, idem_header)
        cached = await cache_mod.get_cached(app.state.redis, ikey)
        if cached is not None:
            log.info(
                "method=%s path=%s provider=%s status=%s category=%s cache=IDEMPOTENT-HIT",
                method,
                full_path,
                provider_name,
                cached["status_code"],
                route.category,
            )
            return JSONResponse(
                status_code=cached["status_code"],
                content=cached["body"],
                headers={"X-Proxy-Cache": "IDEMPOTENT-HIT", "X-Proxy-Provider": provider_name},
            )

    # 8. Response cache check (GET, cache_ttl > 0).
    ckey: str | None = None
    if method == "GET" and route.cache_ttl > 0:
        ckey = cache_mod.cache_key(provider_name, method, full_path, request.url.query)
        cached = await cache_mod.get_cached(app.state.redis, ckey)
        if cached is not None:
            log.info(
                "method=%s path=%s provider=%s status=%s category=%s cache=HIT",
                method,
                full_path,
                provider_name,
                cached["status_code"],
                route.category,
            )
            return JSONResponse(
                status_code=cached["status_code"],
                content=cached["body"],
                headers={"X-Proxy-Cache": "HIT", "X-Proxy-Provider": provider_name},
            )
        cache_state = "MISS"

    # 9. Rate-limit acquire.
    windows = provider.windows_for(route.category)
    if windows:
        try:
            await app.state.limiter.acquire(provider_name, route.category, windows)
        except RateLimited as e:
            log.info(
                "method=%s path=%s provider=%s status=429 category=%s cache=%s",
                method,
                full_path,
                provider_name,
                route.category,
                cache_state,
            )
            return error_response(
                429,
                CODE_RATE_LIMITED,
                f"Rate limit exceeded for category '{route.category}'",
                metadata={"retry_after": round(e.retry_after, 3)},
                headers={"Retry-After": str(max(1, int(e.retry_after)))},
            )

    # 10. Apply auth.
    body = await request.body()
    try:
        auth_result = await provider.auth.apply(
            AuthContext(
                method=method,
                full_path=full_path,
                query_string=request.url.query,
                body=body,
                headers={k.lower(): v for k, v in request.headers.items()},
            )
        )
    except Exception as exc:
        log.exception("Auth failed for provider=%s", provider_name)
        return error_response(502, CODE_AUTH_ERROR, f"Auth module error: {exc}")

    # 11. Build forward headers.
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    fwd_headers.update(provider.default_headers)
    if auth_result.headers:
        fwd_headers.update(auth_result.headers)

    # 12. Merge query params.
    fwd_params = dict(request.query_params)
    if auth_result.query_params:
        fwd_params.update(auth_result.query_params)

    # 13. Body override.
    fwd_body = auth_result.body_override if auth_result.body_override is not None else body

    # 14. Forward request.
    try:
        upstream = await provider.http.request(
            method,
            full_path,
            params=fwd_params,
            headers=fwd_headers,
            content=fwd_body,
        )
    except Exception as exc:
        log.exception("Upstream request failed provider=%s path=%s", provider_name, full_path)
        return error_response(502, CODE_UPSTREAM_ERROR, str(exc))

    # 15. Upstream 429 handling.
    if upstream.status_code == 429:
        try:
            retry_after = float(upstream.headers.get("retry-after", "1.0"))
        except (ValueError, TypeError):
            retry_after = 1.0
        await app.state.limiter.note_upstream_429(provider_name, route.category, retry_after)
        try:
            upstream_body = upstream.json()
        except ValueError:
            upstream_body = {"raw": upstream.text}
        log.info(
            "method=%s path=%s provider=%s status=429 category=%s cache=%s upstream=429",
            method,
            full_path,
            provider_name,
            route.category,
            cache_state,
        )
        return error_response(
            429,
            CODE_UPSTREAM_RATE_LIMITED,
            "Upstream returned 429",
            metadata={"upstream_body": upstream_body, "retry_after": retry_after},
            headers={"Retry-After": str(max(1, int(retry_after)))},
        )

    # 16. Parse body; check for auth rejection.
    try:
        body_json = upstream.json()
    except ValueError:
        body_json = {"raw": upstream.text}

    if provider.auth.is_rejection(upstream.status_code, body_json):
        await provider.auth.invalidate()

    # 17. Persist caches on success.
    if 200 <= upstream.status_code < 300:
        if ckey is not None:
            await cache_mod.put_cached(
                app.state.redis,
                ckey,
                {"status_code": upstream.status_code, "body": body_json},
                route.cache_ttl,
            )
        if method == "POST" and idem_header:
            await cache_mod.put_cached(
                app.state.redis,
                cache_mod.idem_key(provider_name, idem_header),
                {"status_code": upstream.status_code, "body": body_json},
                cache_mod.IDEM_TTL,
            )

    # 18. Strip response headers.
    strip = RESPONSE_HOP_BY_HOP | provider.strip_response_headers
    resp_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in strip}
    resp_headers["X-Proxy-Cache"] = cache_state
    resp_headers["X-Proxy-Provider"] = provider_name

    log.info(
        "method=%s path=%s provider=%s status=%s category=%s cache=%s",
        method,
        full_path,
        provider_name,
        upstream.status_code,
        route.category,
        cache_state,
    )

    # 19. Return response.
    return JSONResponse(
        status_code=upstream.status_code,
        content=body_json,
        headers=resp_headers,
    )
