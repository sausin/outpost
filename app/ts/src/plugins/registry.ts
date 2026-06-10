/**
 * Static plugin registry — required for bundled targets (Workers + Node tsup
 * bundle). Dynamic `import()` with a variable path doesn't survive bundling
 * (esbuild can't resolve it statically), so we keep an explicit map keyed by
 * the YAML's `module_ts:` value.
 *
 * Adding a new plugin: write the file in this directory, import its class
 * here, and add an entry to PLUGIN_REGISTRY. The YAML then references it as
 * `module_ts: plugins/<file>.ts:<ClassName>` (or any string — the key is
 * opaque to the loader).
 *
 * Tests may mutate this registry in-place to inject fixture plugins.
 */

import type { AuthModuleConstructor } from "../auth/types.ts";

import { GrowwApprovalMintAuth } from "./groww_approval_mint.ts";
import { GrowwTotpMintAuth } from "./groww_totp_mint.ts";

export const PLUGIN_REGISTRY: Record<string, AuthModuleConstructor> = {
  "plugins/groww_totp_mint.ts:GrowwTotpMintAuth":
    GrowwTotpMintAuth as unknown as AuthModuleConstructor,
  "plugins/groww_approval_mint.ts:GrowwApprovalMintAuth":
    GrowwApprovalMintAuth as unknown as AuthModuleConstructor,
};
