import type { AuthModuleConstructor } from "./types.ts";

type Loader = () => Promise<{ default: AuthModuleConstructor }>;

const REGISTRY: Record<string, Loader> = {
  none: () =>
    import("./modules/none.ts").then((m) => ({ default: m.NoneAuth })),
  bearer_static: () =>
    import("./modules/bearer_static.ts").then((m) => ({
      default: m.BearerStaticAuth,
    })),
  bearer_redis: () =>
    import("./modules/bearer_redis.ts").then((m) => ({
      default: m.BearerRedisAuth,
    })),
  api_key_header: () =>
    import("./modules/api_key_header.ts").then((m) => ({
      default: m.ApiKeyHeaderAuth,
    })),
  api_key_query: () =>
    import("./modules/api_key_query.ts").then((m) => ({
      default: m.ApiKeyQueryAuth,
    })),
  basic_auth: () =>
    import("./modules/basic_auth.ts").then((m) => ({ default: m.BasicAuth })),
  hmac_signed: () =>
    import("./modules/hmac_signed.ts").then((m) => ({
      default: m.HmacSignedAuth,
    })),
  oauth2_client_credentials: () =>
    import("./modules/oauth2_client_credentials.ts").then((m) => ({
      default: m.OAuth2ClientCredentialsAuth,
    })),
  custom_headers: () =>
    import("./modules/custom_headers.ts").then((m) => ({
      default: m.CustomHeadersAuth,
    })),
  plugin: () =>
    import("./modules/plugin.ts").then((m) => ({ default: m.PluginAuth })),
};

export async function resolve(
  typeName: string,
): Promise<AuthModuleConstructor> {
  const loader = REGISTRY[typeName];
  if (!loader) {
    throw new Error(
      `Unknown auth type "${typeName}". Built-ins: ${Object.keys(REGISTRY).sort().join(", ")}.`,
    );
  }
  const mod = await loader();
  return mod.default;
}
