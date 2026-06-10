"""Pydantic v2 models describing the YAML provider definition.

Minimal shape:
    name: stripe
    base_url: https://api.stripe.com
    auth:
      type: bearer_static
      env: STRIPE_SECRET_KEY

Full shape adds: description, docs_url, enabled, default_headers,
strip_response_headers, and a forwarding block with mode, allow/deny
rules, rate_limits, and transparent-mode tunables.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class WindowSchema(BaseModel):
    capacity: int = Field(gt=0)
    window_ms: int = Field(gt=0)


class AllowRuleSchema(BaseModel):
    method: str
    pattern: str
    category: str = "default"
    cache_ttl: int = 0
    sensitive: bool = False

    @field_validator("method")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()


class ForwardingSchema(BaseModel):
    mode: Literal["transparent", "allowlist"] = "transparent"
    allow: list[AllowRuleSchema] = Field(default_factory=list)
    deny: list[str] = Field(default_factory=list)
    treat_writes_as_sensitive: bool = True
    default_cache_ttl: int = 0
    default_category: str = "default"
    rate_limits: dict[str, list[WindowSchema]] = Field(
        default_factory=lambda: {
            "default": [
                WindowSchema(capacity=50, window_ms=1000),
                WindowSchema(capacity=500, window_ms=60_000),
            ]
        }
    )


class AuthSchema(BaseModel):
    type: str
    model_config = {"extra": "allow"}


class ProviderSchema(BaseModel):
    name: str
    base_url: str
    description: str = ""
    docs_url: str = ""
    enabled: bool = True
    default_headers: dict[str, str] = Field(default_factory=dict)
    strip_response_headers: list[str] = Field(default_factory=list)
    auth: AuthSchema
    forwarding: ForwardingSchema = Field(default_factory=ForwardingSchema)

    @field_validator("name")
    @classmethod
    def _name_safe(cls, v: str) -> str:
        if not v or not all(c.isalnum() or c in "-_" for c in v):
            raise ValueError("name must be non-empty alphanumeric, dash, or underscore")
        return v.lower()
