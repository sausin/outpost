import type { AuthContext, AuthResult } from "../../core/types.ts";
import type { AuthModule, AuthDeps } from "../types.ts";

export class NoneAuth implements AuthModule {
  static readonly typeName = "none";

  static fromConfig(
    _config: Record<string, unknown>,
    _deps: AuthDeps,
  ): NoneAuth {
    return new NoneAuth();
  }

  async apply(_ctx: AuthContext): Promise<AuthResult> {
    return {};
  }

  async invalidate(): Promise<void> {}

  isRejection(_statusCode: number, _body: unknown): boolean {
    return false;
  }
}
