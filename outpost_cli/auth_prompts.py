"""One prompt function per auth type; each returns a dict ready for YAML output."""

from __future__ import annotations

import questionary

from outpost_cli.validators import (
    parse_int_list,
    suggest_env_var,
    validate_env_var,
    validate_env_var_optional,
    validate_header_name,
    validate_module_path,
)

# ── helpers ──────────────────────────────────────────────────────────────────


def _ask_invalidate_on(default: str = "401") -> list[int]:
    raw = questionary.text(
        "HTTP status codes that invalidate auth (comma-separated):",
        default=default,
        instruction="  e.g. 401, 403",
    ).ask()
    if raw is None:
        raise KeyboardInterrupt
    return parse_int_list(raw) if raw.strip() else []


# ── one function per auth type ────────────────────────────────────────────────


def prompt_none() -> dict:
    """No auth — public APIs."""
    codes = questionary.text(
        "Invalidate-on codes (blank = none):",
        default="",
        instruction="  Leave blank for public APIs.",
    ).ask()
    if codes is None:
        raise KeyboardInterrupt
    result: dict = {"type": "none"}
    parsed = parse_int_list(codes) if codes.strip() else []
    if parsed:
        result["invalidate_on"] = parsed
    return result


def prompt_bearer_static(provider_name: str = "") -> dict:
    """Authorization: Bearer $ENV — for OpenAI, Stripe, Anthropic, etc."""
    default_env = suggest_env_var(provider_name, "SECRET_KEY") if provider_name else "API_SECRET_KEY"
    env = questionary.text(
        "Env var holding the bearer token:",
        default=default_env,
        validate=validate_env_var,
        instruction="  e.g. STRIPE_SECRET_KEY",
    ).ask()
    if env is None:
        raise KeyboardInterrupt

    header = questionary.text(
        "Header name:",
        default="Authorization",
        validate=validate_header_name,
    ).ask()
    if header is None:
        raise KeyboardInterrupt

    prefix = questionary.text(
        "Token prefix (include trailing space if needed):",
        default="Bearer ",
    ).ask()
    if prefix is None:
        raise KeyboardInterrupt

    invalidate_on = _ask_invalidate_on("401")

    result: dict = {"type": "bearer_static", "env": env.strip()}
    if header.strip() != "Authorization":
        result["header"] = header.strip()
    if prefix != "Bearer ":
        result["prefix"] = prefix
    if invalidate_on != [401]:
        result["invalidate_on"] = invalidate_on
    return result


def prompt_bearer_redis(provider_name: str = "") -> dict:
    """Operator-rotated token stored in Redis."""
    redis_key = questionary.text(
        "Redis key that holds the token:",
        default=f"outpost:{provider_name or 'provider'}:token",
        instruction="  e.g. outpost:upstox:access_token",
    ).ask()
    if redis_key is None:
        raise KeyboardInterrupt

    env_seed = questionary.text(
        "Optional env var for seed/fallback (blank to skip):",
        default="",
        validate=validate_env_var_optional,
    ).ask()
    if env_seed is None:
        raise KeyboardInterrupt

    header = questionary.text("Header name:", default="Authorization", validate=validate_header_name).ask()
    if header is None:
        raise KeyboardInterrupt

    prefix = questionary.text("Token prefix:", default="Bearer ").ask()
    if prefix is None:
        raise KeyboardInterrupt

    invalidate_on = _ask_invalidate_on("401")

    result: dict = {"type": "bearer_redis", "redis_key": redis_key.strip()}
    if env_seed.strip():
        result["env_seed"] = env_seed.strip()
    if header.strip() != "Authorization":
        result["header"] = header.strip()
    if prefix != "Bearer ":
        result["prefix"] = prefix
    if invalidate_on != [401]:
        result["invalidate_on"] = invalidate_on
    return result


def prompt_api_key_header(provider_name: str = "") -> dict:
    """Env-sourced API key placed in a request header (X-API-Key style)."""
    default_env = suggest_env_var(provider_name, "API_KEY") if provider_name else "API_KEY"
    env = questionary.text(
        "Env var holding the API key:",
        default=default_env,
        validate=validate_env_var,
    ).ask()
    if env is None:
        raise KeyboardInterrupt

    header = questionary.text(
        "Header name:",
        default="X-API-Key",
        validate=validate_header_name,
        instruction="  e.g. X-API-Key, X-Auth-Token",
    ).ask()
    if header is None:
        raise KeyboardInterrupt

    prefix = questionary.text("Key prefix (usually empty):", default="").ask()
    if prefix is None:
        raise KeyboardInterrupt

    invalidate_on = _ask_invalidate_on("401, 403")

    result: dict = {"type": "api_key_header", "env": env.strip(), "header": header.strip()}
    if prefix.strip():
        result["prefix"] = prefix.strip()
    parsed_codes = parse_int_list("401, 403")
    if invalidate_on != parsed_codes:
        result["invalidate_on"] = invalidate_on
    return result


def prompt_api_key_query(provider_name: str = "") -> dict:
    """Env-sourced key passed as a query parameter (legacy APIs)."""
    default_env = suggest_env_var(provider_name, "API_KEY") if provider_name else "API_KEY"
    env = questionary.text(
        "Env var holding the API key:",
        default=default_env,
        validate=validate_env_var,
    ).ask()
    if env is None:
        raise KeyboardInterrupt

    param = questionary.text(
        "Query parameter name:",
        default="api_key",
        instruction="  e.g. api_key, token, access_token",
    ).ask()
    if param is None:
        raise KeyboardInterrupt

    invalidate_on = _ask_invalidate_on("401")

    result: dict = {"type": "api_key_query", "env": env.strip(), "param": param.strip()}
    if invalidate_on != [401]:
        result["invalidate_on"] = invalidate_on
    return result


def prompt_basic_auth(provider_name: str = "") -> dict:
    """Authorization: Basic base64(user:pass)."""
    pfx = provider_name.upper().replace("-", "_") if provider_name else "SERVICE"
    username_env = questionary.text(
        "Env var for username:",
        default=f"{pfx}_USERNAME",
        validate=validate_env_var,
    ).ask()
    if username_env is None:
        raise KeyboardInterrupt

    password_env = questionary.text(
        "Env var for password:",
        default=f"{pfx}_PASSWORD",
        validate=validate_env_var,
    ).ask()
    if password_env is None:
        raise KeyboardInterrupt

    invalidate_on = _ask_invalidate_on("401")

    result: dict = {
        "type": "basic_auth",
        "username_env": username_env.strip(),
        "password_env": password_env.strip(),
    }
    if invalidate_on != [401]:
        result["invalidate_on"] = invalidate_on
    return result


def prompt_hmac_signed(provider_name: str = "") -> dict:
    """HMAC-SHA256 signed requests (Binance, Coinbase style)."""
    pfx = provider_name.upper().replace("-", "_") if provider_name else "SERVICE"

    key_env = questionary.text(
        "Env var for the API key:",
        default=f"{pfx}_API_KEY",
        validate=validate_env_var,
    ).ask()
    if key_env is None:
        raise KeyboardInterrupt

    secret_env = questionary.text(
        "Env var for the HMAC secret:",
        default=f"{pfx}_SECRET_KEY",
        validate=validate_env_var,
    ).ask()
    if secret_env is None:
        raise KeyboardInterrupt

    key_header = questionary.text(
        "Header that carries the API key:",
        default="X-MBX-APIKEY",
        validate=validate_header_name,
        instruction="  e.g. X-MBX-APIKEY (Binance), CB-ACCESS-KEY (Coinbase)",
    ).ask()
    if key_header is None:
        raise KeyboardInterrupt

    sig_placement = questionary.select(
        "Where to put the HMAC signature?",
        choices=["query parameter", "header"],
    ).ask()
    if sig_placement is None:
        raise KeyboardInterrupt

    if sig_placement == "query parameter":
        sig_param = questionary.text(
            "Signature query parameter name:",
            default="signature",
        ).ask()
        if sig_param is None:
            raise KeyboardInterrupt
    else:
        sig_param = None

    sig_header_val = None
    if sig_placement == "header":
        sig_header_val = questionary.text(
            "Signature header name:",
            default="X-Signature",
            validate=validate_header_name,
        ).ask()
        if sig_header_val is None:
            raise KeyboardInterrupt

    ts_placement = questionary.select(
        "Where to put the timestamp?",
        choices=["query parameter", "header", "none"],
    ).ask()
    if ts_placement is None:
        raise KeyboardInterrupt

    ts_param = ts_header_val = None
    if ts_placement == "query parameter":
        ts_param = questionary.text("Timestamp query param name:", default="timestamp").ask()
        if ts_param is None:
            raise KeyboardInterrupt
    elif ts_placement == "header":
        ts_header_val = questionary.text(
            "Timestamp header name:",
            default="X-Timestamp",
            validate=validate_header_name,
        ).ask()
        if ts_header_val is None:
            raise KeyboardInterrupt

    digest = questionary.select(
        "Hash digest:",
        choices=["sha256", "sha512", "sha384"],
        default="sha256",
    ).ask()
    if digest is None:
        raise KeyboardInterrupt

    payload = questionary.select(
        "What to sign?",
        choices=["query", "body", "query+body"],
        default="query",
    ).ask()
    if payload is None:
        raise KeyboardInterrupt

    result: dict = {
        "type": "hmac_signed",
        "key_env": key_env.strip(),
        "secret_env": secret_env.strip(),
        "key_header": key_header.strip(),
    }
    if sig_param:
        result["signature_param"] = sig_param.strip()
    if sig_header_val:
        result["signature_header"] = sig_header_val.strip()
    if ts_param:
        result["timestamp_param"] = ts_param.strip()
    if ts_header_val:
        result["timestamp_header"] = ts_header_val.strip()
    if digest != "sha256":
        result["digest"] = digest
    if payload != "query":
        result["payload"] = payload
    return result


def prompt_oauth2_client_credentials(provider_name: str = "") -> dict:
    """Auto-mint via OAuth2 client_credentials grant."""
    pfx = provider_name.upper().replace("-", "_") if provider_name else "SERVICE"

    client_id_env = questionary.text(
        "Env var for client_id:",
        default=f"{pfx}_CLIENT_ID",
        validate=validate_env_var,
    ).ask()
    if client_id_env is None:
        raise KeyboardInterrupt

    client_secret_env = questionary.text(
        "Env var for client_secret:",
        default=f"{pfx}_CLIENT_SECRET",
        validate=validate_env_var,
    ).ask()
    if client_secret_env is None:
        raise KeyboardInterrupt

    token_url = questionary.text(
        "Token endpoint URL:",
        default="https://",
        instruction="  e.g. https://auth.example.com/oauth/token",
    ).ask()
    if token_url is None:
        raise KeyboardInterrupt

    scope = questionary.text("Scope (blank to omit):", default="").ask()
    if scope is None:
        raise KeyboardInterrupt

    audience = questionary.text("Audience (blank to omit):", default="").ask()
    if audience is None:
        raise KeyboardInterrupt

    redis_key = questionary.text(
        "Redis key for token cache (blank = default):",
        default="",
        instruction="  Leave blank to use the default key based on provider name.",
    ).ask()
    if redis_key is None:
        raise KeyboardInterrupt

    invalidate_on = _ask_invalidate_on("401")

    result: dict = {
        "type": "oauth2_client_credentials",
        "client_id_env": client_id_env.strip(),
        "client_secret_env": client_secret_env.strip(),
        "token_url": token_url.strip(),
    }
    if scope.strip():
        result["scope"] = scope.strip()
    if audience.strip():
        result["audience"] = audience.strip()
    if redis_key.strip():
        result["redis_key"] = redis_key.strip()
    if invalidate_on != [401]:
        result["invalidate_on"] = invalidate_on
    return result


def prompt_custom_headers() -> dict:
    """Multiple static headers (multi-header auth schemes)."""
    from rich.console import Console

    console = Console()
    headers: dict[str, dict] = {}
    console.print("  [dim]Add one header at a time. Press Enter with no name to finish.[/dim]")

    while True:
        name = questionary.text(
            f"Header name (or blank to finish, {len(headers)} added so far):",
            default="",
            validate=lambda v: True if not v.strip() else validate_header_name(v),
        ).ask()
        if name is None:
            raise KeyboardInterrupt
        if not name.strip():
            break

        source = questionary.select(
            f"For header '{name.strip()}', provide value via:",
            choices=["env var", "literal value"],
        ).ask()
        if source is None:
            raise KeyboardInterrupt

        if source == "env var":
            env = questionary.text(
                "Env var name:",
                validate=validate_env_var,
            ).ask()
            if env is None:
                raise KeyboardInterrupt
            headers[name.strip()] = {"env": env.strip()}
        else:
            val = questionary.text("Literal value:").ask()
            if val is None:
                raise KeyboardInterrupt
            headers[name.strip()] = {"value": val}

    if not headers:
        from rich.console import Console as C

        C().print("  [yellow]No headers added — defaulting to 'none' auth.[/yellow]")
        return {"type": "none"}

    return {"type": "custom_headers", "headers": headers}


def prompt_plugin() -> dict:
    """Custom Python class for exotic auth (TOTP, AWS SigV4, etc.)."""
    from rich.console import Console

    Console().print(
        "  [dim]Specify a Python module path and class implementing the AuthModule protocol.[/dim]"
    )

    module = questionary.text(
        "Module path (dotted.path:ClassName):",
        default="app.plugins.my_auth:MyAuth",
        validate=validate_module_path,
        instruction="  e.g. app.plugins.groww_mint:GrowwMintAuth",
    ).ask()
    if module is None:
        raise KeyboardInterrupt

    config: dict = {}
    add_config = questionary.confirm("Add config key/value pairs for the plugin?", default=True).ask()
    if add_config is None:
        raise KeyboardInterrupt

    if add_config:
        from rich.console import Console as C

        C().print("  [dim]Enter config keys the plugin expects (e.g. api_key_env, auth_mode).[/dim]")
        while True:
            key = questionary.text(
                f"Config key (blank to finish, {len(config)} added):",
                default="",
            ).ask()
            if key is None:
                raise KeyboardInterrupt
            if not key.strip():
                break
            val = questionary.text(f"Value for '{key.strip()}':").ask()
            if val is None:
                raise KeyboardInterrupt
            config[key.strip()] = val

    result: dict = {"type": "plugin", "module": module.strip()}
    if config:
        result["config"] = config
    return result


AUTH_DISPATCH: dict[str, object] = {
    "none": prompt_none,
    "bearer_static": prompt_bearer_static,
    "bearer_redis": prompt_bearer_redis,
    "api_key_header": prompt_api_key_header,
    "api_key_query": prompt_api_key_query,
    "basic_auth": prompt_basic_auth,
    "hmac_signed": prompt_hmac_signed,
    "oauth2_client_credentials": prompt_oauth2_client_credentials,
    "custom_headers": prompt_custom_headers,
    "plugin": prompt_plugin,
}
