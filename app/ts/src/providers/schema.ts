/**
 * Zod schemas mirroring app/providers/schema.py 1:1.
 *
 * Minimal shape:
 *   name: stripe
 *   base_url: https://api.stripe.com
 *   auth:
 *     type: bearer_static
 *     env: STRIPE_SECRET_KEY
 */

import { z } from "zod";

export const WindowSchema = z.object({
  capacity: z.number().int().positive(),
  window_ms: z.number().int().positive(),
});

export const AllowRuleSchema = z.object({
  method: z.string().transform((s) => s.toUpperCase()),
  pattern: z.string(),
  category: z.string().default("default"),
  cache_ttl: z.number().int().nonnegative().default(0),
  sensitive: z.boolean().default(false),
});

export const ForwardingSchema = z.object({
  mode: z.enum(["transparent", "allowlist"]).default("transparent"),
  allow: z.array(AllowRuleSchema).default([]),
  deny: z.array(z.string()).default([]),
  treat_writes_as_sensitive: z.boolean().default(true),
  default_cache_ttl: z.number().int().nonnegative().default(0),
  default_category: z.string().default("default"),
  rate_limits: z.record(z.array(WindowSchema)).default({
    default: [
      { capacity: 50, window_ms: 1000 },
      { capacity: 500, window_ms: 60_000 },
    ],
  }),
});

export const AuthSchema = z.object({ type: z.string() }).passthrough();

export const ProviderSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "alphanumeric, dash, underscore only")
    .transform((s) => s.toLowerCase()),
  base_url: z.string().url(),
  description: z.string().default(""),
  docs_url: z.string().default(""),
  enabled: z.boolean().default(true),
  default_headers: z.record(z.string()).default({}),
  strip_response_headers: z.array(z.string()).default([]),
  auth: AuthSchema,
  forwarding: ForwardingSchema.default({}),
});

export type ProviderDef = z.infer<typeof ProviderSchema>;
export type AllowRule = z.infer<typeof AllowRuleSchema>;
export type ForwardingDef = z.infer<typeof ForwardingSchema>;
export type WindowDef = z.infer<typeof WindowSchema>;
