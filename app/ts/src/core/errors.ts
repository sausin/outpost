/** Proxy-originated error responses — mirrors app/core/errors.py */

export const CODES = {
  UNKNOWN_PROVIDER: "PROXY_UNKNOWN_PROVIDER",
  HOST_DENIED: "PROXY_HOST_DENIED",
  AUTH_REQUIRED: "PROXY_AUTH_REQUIRED",
  NO_ROUTE: "PROXY_NO_ROUTE",
  PATH_DENIED: "PROXY_PATH_DENIED",
  SENSITIVE_DENIED: "PROXY_SENSITIVE_DENIED",
  RATE_LIMITED: "PROXY_RATE_LIMITED",
  UPSTREAM_RATE_LIMITED: "PROXY_UPSTREAM_RATE_LIMITED",
  AUTH_ERROR: "PROXY_AUTH_ERROR",
  UPSTREAM_ERROR: "PROXY_UPSTREAM_ERROR",
  PROVIDER_CONFIG_ERROR: "PROXY_PROVIDER_CONFIG_ERROR",
  PROVIDER_DISABLED: "PROXY_PROVIDER_DISABLED",
} as const;

export type ErrorCode = (typeof CODES)[keyof typeof CODES];

export interface ProxyError {
  status: "FAILURE";
  error: {
    code: ErrorCode;
    message: string;
    metadata: unknown | null;
  };
}

export function errorResponse(
  statusCode: number,
  code: ErrorCode,
  message: string,
  metadata: unknown = null,
  headers?: Record<string, string>,
): Response {
  const body: ProxyError = {
    status: "FAILURE",
    error: { code, message, metadata },
  };
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}
