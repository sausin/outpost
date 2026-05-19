"""Top-level orchestration for the `outpost add-provider` interactive wizard."""

from __future__ import annotations

import sys
from pathlib import Path

import questionary
from rich.console import Console

from outpost_cli.auth_prompts import AUTH_DISPATCH
from outpost_cli.render import (
    build_yaml,
    extract_env_vars,
    preview_yaml,
    print_header,
    print_step,
    print_success,
)
from outpost_cli.validators import (
    normalize_name,
    normalize_url,
    validate_header_name,
    validate_name,
    validate_pattern,
    validate_positive_int,
    validate_url,
    validate_url_optional,
)

PROVIDERS_DIR = Path(__file__).parent.parent / "app" / "builtin_providers"

AUTH_CHOICES = [
    questionary.Choice(
        "bearer_static  — Authorization: Bearer $ENV  (OpenAI, Stripe, Anthropic)",
        value="bearer_static",
    ),
    questionary.Choice(
        "bearer_redis   — operator-rotated token, stored in Redis",
        value="bearer_redis",
    ),
    questionary.Choice(
        "api_key_header — env-sourced value placed in any header  (X-API-Key style)",
        value="api_key_header",
    ),
    questionary.Choice(
        "api_key_query  — env-sourced value as a query param  (legacy APIs)",
        value="api_key_query",
    ),
    questionary.Choice(
        "basic_auth     — Authorization: Basic base64(user:pass)",
        value="basic_auth",
    ),
    questionary.Choice(
        "hmac_signed    — HMAC-SHA256 signed request  (Binance, Coinbase)",
        value="hmac_signed",
    ),
    questionary.Choice(
        "oauth2_client_credentials — auto-mint via client_credentials grant",
        value="oauth2_client_credentials",
    ),
    questionary.Choice(
        "custom_headers — multiple static/env-sourced headers  (multi-header schemes)",
        value="custom_headers",
    ),
    questionary.Choice(
        "none           — no auth  (public APIs)",
        value="none",
    ),
    questionary.Choice(
        "plugin         — custom Python class for exotic auth  (TOTP, SigV4, ...)",
        value="plugin",
    ),
]

METHOD_CHOICES = ["GET", "POST", "PUT", "DELETE", "PATCH", "*"]


# ── step helpers ──────────────────────────────────────────────────────────────


def _step1_basics(console: Console) -> dict:
    print_step(console, 1, 6, "Basics")

    name_raw = questionary.text(
        "Provider name:",
        validate=validate_name,
        instruction="  lowercase letters, digits, hyphens, underscores",
    ).ask()
    if name_raw is None:
        raise KeyboardInterrupt
    name = normalize_name(name_raw)

    base_url_raw = questionary.text(
        "Base URL:",
        validate=validate_url,
        instruction="  e.g. https://api.stripe.com  (trailing slash stripped automatically)",
    ).ask()
    if base_url_raw is None:
        raise KeyboardInterrupt
    base_url = normalize_url(base_url_raw)

    description = questionary.text("Description (optional):", default="").ask()
    if description is None:
        raise KeyboardInterrupt

    docs_url_raw = questionary.text(
        "Docs URL (optional):",
        default="",
        validate=validate_url_optional,
        instruction="  e.g. https://stripe.com/docs/api",
    ).ask()
    if docs_url_raw is None:
        raise KeyboardInterrupt
    docs_url = normalize_url(docs_url_raw)

    return {
        "name": name,
        "base_url": base_url,
        "description": description.strip(),
        "docs_url": docs_url,
    }


def _step2_auth(console: Console, provider_name: str) -> dict:
    print_step(console, 2, 6, "Authentication")

    auth_type = questionary.select(
        "Authentication type:",
        choices=AUTH_CHOICES,
        instruction="  Use arrow keys, Enter to confirm",
    ).ask()
    if auth_type is None:
        raise KeyboardInterrupt

    fn = AUTH_DISPATCH[auth_type]
    # Functions that accept provider_name for smart defaults
    _provider_aware = {
        "bearer_static",
        "bearer_redis",
        "api_key_header",
        "api_key_query",
        "basic_auth",
        "hmac_signed",
        "oauth2_client_credentials",
    }
    if auth_type in _provider_aware:
        return fn(provider_name)  # type: ignore[call-arg]
    return fn()  # type: ignore[call-arg]


def _collect_allow_rules(console: Console) -> list[dict]:
    rules: list[dict] = []
    console.print(
        "  [dim]Glob syntax: * matches one path segment, ** matches any path, "
        "{name} is a single-segment placeholder.[/dim]"
    )

    while True:
        console.print(f"\n  [dim]Rules added: {len(rules)}[/dim]")
        add_more = questionary.confirm(
            "Add an allow rule?",
            default=len(rules) == 0,
        ).ask()
        if add_more is None:
            raise KeyboardInterrupt
        if not add_more:
            if not rules:
                console.print(
                    "  [yellow]Warning: no allow rules — all requests will be blocked.[/yellow]"
                )
            break

        method = questionary.select("HTTP method:", choices=METHOD_CHOICES).ask()
        if method is None:
            raise KeyboardInterrupt

        pattern = questionary.text(
            "Path pattern:",
            validate=validate_pattern,
            instruction="  e.g. /v1/orders, /v1/holdings, /v1/data/**",
        ).ask()
        if pattern is None:
            raise KeyboardInterrupt

        category = questionary.text(
            "Category:",
            default="default",
            instruction="  common: read, write, orders, live_data, non_trading",
        ).ask()
        if category is None:
            raise KeyboardInterrupt

        cache_ttl_raw = questionary.text(
            "Cache TTL seconds (0 = no cache):",
            default="0",
            validate=validate_positive_int,
        ).ask()
        if cache_ttl_raw is None:
            raise KeyboardInterrupt
        cache_ttl = int(cache_ttl_raw.strip())

        is_write = method in ("POST", "PUT", "DELETE", "PATCH")
        sensitive = questionary.confirm(
            "Mark as sensitive (write agents need explicit permission)?",
            default=is_write,
        ).ask()
        if sensitive is None:
            raise KeyboardInterrupt

        rule: dict = {
            "method": method,
            "pattern": pattern.strip(),
            "category": category.strip() or "default",
        }
        if cache_ttl:
            rule["cache_ttl"] = cache_ttl
        if sensitive:
            rule["sensitive"] = True

        rules.append(rule)

    return rules


def _collect_deny_patterns(console: Console) -> list[str]:
    add_deny = questionary.confirm(
        "Add deny patterns to explicitly block paths?", default=False
    ).ask()
    if add_deny is None:
        raise KeyboardInterrupt
    if not add_deny:
        return []

    patterns: list[str] = []
    console.print("  [dim]Enter path patterns to block; blank line to finish.[/dim]")
    while True:
        p = questionary.text(
            f"Deny pattern (blank to finish, {len(patterns)} added):",
            default="",
        ).ask()
        if p is None:
            raise KeyboardInterrupt
        if not p.strip():
            break
        if not p.strip().startswith("/"):
            console.print("  [yellow]Pattern should start with /; added as-is.[/yellow]")
        patterns.append(p.strip())

    return patterns


def _step3_forwarding(console: Console) -> tuple[str, list[dict], list[str]]:
    print_step(console, 3, 6, "Forwarding mode")

    mode = questionary.select(
        "Forwarding mode:",
        choices=[
            questionary.Choice(
                "transparent — forward every request; writes flagged sensitive by default",
                value="transparent",
            ),
            questionary.Choice(
                "allowlist   — only listed paths forwarded  (recommended for production)",
                value="allowlist",
            ),
        ],
    ).ask()
    if mode is None:
        raise KeyboardInterrupt

    allow_rules: list[dict] = []
    if mode == "allowlist":
        allow_rules = _collect_allow_rules(console)

    deny_patterns = _collect_deny_patterns(console)
    return mode, allow_rules, deny_patterns


def _collect_rate_limit_windows(console: Console, category: str) -> list[dict]:
    """Collect capacity + window pairs for one category."""
    console.print(
        f"  [dim]Configuring rate-limit windows for category '[bold]{category}[/bold]'.[/dim]\n"
        "  [dim]0 capacity = no cap. The most restrictive window wins when multiple apply.[/dim]"
    )
    windows: list[dict] = []
    while True:
        add = questionary.confirm(
            f"Add a window for '{category}'? ({len(windows)} so far)",
            default=len(windows) == 0,
        ).ask()
        if add is None:
            raise KeyboardInterrupt
        if not add:
            break

        cap_raw = questionary.text(
            "  Capacity (requests allowed, e.g. 10):",
            validate=validate_positive_int,
        ).ask()
        if cap_raw is None:
            raise KeyboardInterrupt

        win_raw = questionary.text(
            "  Window in seconds (e.g. 1 for per-second, 60 for per-minute):",
            validate=validate_positive_int,
        ).ask()
        if win_raw is None:
            raise KeyboardInterrupt

        windows.append({"capacity": int(cap_raw.strip()), "window_ms": int(win_raw.strip()) * 1000})

    return windows


def _step4_rate_limits(
    console: Console, mode: str, allow_rules: list[dict]
) -> dict[str, list[dict]]:
    print_step(console, 4, 6, "Rate limits")

    use_defaults = questionary.confirm(
        "Use sensible defaults (50/sec + 500/min on a single bucket)?",
        default=True,
    ).ask()
    if use_defaults is None:
        raise KeyboardInterrupt

    if use_defaults:
        return {
            "default": [{"capacity": 50, "window_ms": 1000}, {"capacity": 500, "window_ms": 60000}]
        }

    categories: list[str] = ["default"]
    if mode == "allowlist" and allow_rules:
        seen: set[str] = set()
        for r in allow_rules:
            cat = r.get("category", "default")
            if cat not in seen:
                seen.add(cat)
                if cat != "default":
                    categories.append(cat)

    rate_limits: dict[str, list[dict]] = {}
    for cat in categories:
        windows = _collect_rate_limit_windows(console, cat)
        if windows:
            rate_limits[cat] = windows

    return rate_limits or {
        "default": [{"capacity": 50, "window_ms": 1000}, {"capacity": 500, "window_ms": 60000}]
    }


def _step5_default_headers(console: Console) -> dict[str, str]:
    print_step(console, 5, 6, "Default headers")

    console.print("  [dim]Common examples: Accept: application/json  |  X-API-VERSION: 1.0[/dim]")
    add = questionary.confirm(
        "Add default headers sent on every forwarded request?",
        default=False,
    ).ask()
    if add is None:
        raise KeyboardInterrupt
    if not add:
        return {}

    headers: dict[str, str] = {}
    while True:
        name = questionary.text(
            f"Header name (blank to finish, {len(headers)} added):",
            default="",
            validate=lambda v: True if not v.strip() else validate_header_name(v),
        ).ask()
        if name is None:
            raise KeyboardInterrupt
        if not name.strip():
            break

        val = questionary.text(f"Value for '{name.strip()}':", default="").ask()
        if val is None:
            raise KeyboardInterrupt
        headers[name.strip()] = val

    return headers


def _step6_preview_save(console: Console, provider_data: dict, provider_name: str) -> bool:
    print_step(console, 6, 6, "Preview & save")

    yaml_str = build_yaml(provider_data)
    preview_yaml(yaml_str, console)

    target = PROVIDERS_DIR / f"{provider_name}.yaml"
    if target.exists():
        console.print(f"\n  [yellow]Warning: {target} already exists.[/yellow]")
        overwrite = questionary.confirm("Overwrite existing file?", default=False).ask()
        if overwrite is None:
            raise KeyboardInterrupt
        if not overwrite:
            console.print("  [dim]File not saved.[/dim]")
            return False

    save = questionary.confirm(
        f"Save to app/builtin_providers/{provider_name}.yaml?",
        default=True,
    ).ask()
    if save is None:
        raise KeyboardInterrupt
    if not save:
        console.print("[dim]Discarded — nothing written.[/dim]")
        return False

    target.write_text(yaml_str, encoding="utf-8")
    env_vars = extract_env_vars(yaml_str)
    print_success(console, str(target), env_vars, provider_name)
    return True


# ── public entry point ────────────────────────────────────────────────────────


def run_wizard() -> None:
    """Run the full add-provider wizard."""
    console = Console()

    existing = sorted(p.stem for p in PROVIDERS_DIR.glob("*.yaml"))
    print_header(console, existing)

    try:
        basics = _step1_basics(console)
        provider_name: str = basics["name"]

        auth = _step2_auth(console, provider_name)

        mode, allow_rules, deny_patterns = _step3_forwarding(console)

        rate_limits = _step4_rate_limits(console, mode, allow_rules)

        default_headers = _step5_default_headers(console)

        # ── assemble provider data dict ──────────────────────────────────────
        provider_data: dict = {"name": provider_name, "base_url": basics["base_url"]}
        if basics["description"]:
            provider_data["description"] = basics["description"]
        if basics["docs_url"]:
            provider_data["docs_url"] = basics["docs_url"]
        if default_headers:
            provider_data["default_headers"] = default_headers
        provider_data["auth"] = auth

        forwarding: dict = {"mode": mode}
        if allow_rules:
            forwarding["allow"] = allow_rules
        if deny_patterns:
            forwarding["deny"] = deny_patterns

        # only include rate_limits when non-default
        default_rl = {
            "default": [{"capacity": 50, "window_ms": 1000}, {"capacity": 500, "window_ms": 60000}]
        }
        if rate_limits != default_rl or mode != "transparent":
            forwarding["rate_limits"] = rate_limits

        provider_data["forwarding"] = forwarding

        _step6_preview_save(console, provider_data, provider_name)

    except KeyboardInterrupt:
        console.print("\n[dim]Cancelled.[/dim]")
        sys.exit(130)
