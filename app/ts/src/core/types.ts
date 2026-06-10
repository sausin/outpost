/** Core domain types — mirrors app/auth/base.py and app/providers/provider.py */

export interface AuthContext {
  method: string;
  fullPath: string;
  queryString: string;
  body: ArrayBuffer | null;
  headers: Headers;
}

export interface AuthResult {
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  bodyOverride?: ArrayBuffer | null;
}

export interface RouteRule {
  /** HTTP method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "*" */
  method: string;
  /** Glob pattern, e.g. "/v1/customers/**" */
  pattern: string;
  category: string;
  cacheTtl: number;
  sensitive: boolean;
}

export interface ClassifiedRoute {
  category: string;
  cacheTtl: number;
  sensitive: boolean;
  /** null in transparent mode (no matched allow rule) */
  rawPattern: string | null;
}

export interface WindowLimit {
  capacity: number;
  windowMs: number;
}
