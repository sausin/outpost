"""Proxy-originated error responses."""

from __future__ import annotations

from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Error code constants — use these by name rather than raw string literals.
# ---------------------------------------------------------------------------
CODE_UNKNOWN_PROVIDER = "PROXY_UNKNOWN_PROVIDER"
CODE_HOST_DENIED = "PROXY_HOST_DENIED"
CODE_NO_ROUTE = "PROXY_NO_ROUTE"  # path not in allowlist
CODE_PATH_DENIED = "PROXY_PATH_DENIED"  # path matches deny rule
CODE_SENSITIVE_DENIED = (
    "PROXY_SENSITIVE_DENIED"  # host can't call sensitive endpoints (was PROXY_TRADE_DENIED)
)
CODE_RATE_LIMITED = "PROXY_RATE_LIMITED"
CODE_UPSTREAM_RATE_LIMITED = "PROXY_UPSTREAM_RATE_LIMITED"
CODE_AUTH_ERROR = "PROXY_AUTH_ERROR"  # auth module failed (was PROXY_TOKEN_ERROR)
CODE_UPSTREAM_ERROR = "PROXY_UPSTREAM_ERROR"
CODE_PROVIDER_CONFIG_ERROR = "PROXY_PROVIDER_CONFIG_ERROR"  # invalid provider YAML; used at startup
CODE_PROVIDER_DISABLED = "PROXY_PROVIDER_DISABLED"


def error_response(
    status_code: int,
    code: str,
    message: str,
    metadata: dict | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    """Return a uniform error envelope for all proxy-originated errors."""
    return JSONResponse(
        status_code=status_code,
        content={
            "status": "FAILURE",
            "error": {"code": code, "message": message, "metadata": metadata},
        },
        headers=headers or {},
    )
