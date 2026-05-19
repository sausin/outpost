from __future__ import annotations

import importlib
import logging

from app.auth.base import AuthModule

log = logging.getLogger(__name__)

_BUILTIN: dict[str, str] = {
    "none": "app.auth.modules.none_:NoneAuth",
    "bearer_static": "app.auth.modules.bearer_static:BearerStaticAuth",
    "bearer_redis": "app.auth.modules.bearer_redis:BearerRedisAuth",
    "api_key_header": "app.auth.modules.api_key_header:ApiKeyHeaderAuth",
    "api_key_query": "app.auth.modules.api_key_query:ApiKeyQueryAuth",
    "basic_auth": "app.auth.modules.basic_auth:BasicAuth",
    "hmac_signed": "app.auth.modules.hmac_signed:HmacSignedAuth",
    "oauth2_client_credentials": "app.auth.modules.oauth2_client_credentials:OAuth2ClientCredentialsAuth",
    "custom_headers": "app.auth.modules.custom_headers:CustomHeadersAuth",
    "plugin": "app.auth.modules.plugin:PluginAuth",
}


def resolve(type_name: str) -> type[AuthModule]:
    """Return the AuthModule class registered under type_name."""
    if type_name not in _BUILTIN:
        raise ValueError(f"Unknown auth type {type_name!r}. Built-ins: {sorted(_BUILTIN)}.")
    module_path, _, class_name = _BUILTIN[type_name].partition(":")
    module = importlib.import_module(module_path)
    return getattr(module, class_name)
