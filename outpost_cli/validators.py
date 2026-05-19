"""Input validation helpers for wizard prompts."""

from __future__ import annotations

import re


def validate_name(value: str) -> bool | str:
    """Provider name: non-empty, lowercase alphanumeric / dash / underscore."""
    v = value.strip().lower()
    if not v:
        return "Provider name cannot be empty."
    if not re.fullmatch(r"[a-z0-9][a-z0-9_\-]*", v):
        return "Use only lowercase letters, digits, hyphens, or underscores (must start with a letter/digit)."
    return True


def validate_url(value: str) -> bool | str:
    """Must start with http:// or https://."""
    v = value.strip().rstrip("/")
    if not v:
        return "URL cannot be empty."
    if not (v.startswith("http://") or v.startswith("https://")):
        return "URL must start with http:// or https://."
    return True


def validate_url_optional(value: str) -> bool | str:
    """Empty is fine; non-empty must be a valid URL."""
    if not value.strip():
        return True
    return validate_url(value)


def validate_env_var(value: str) -> bool | str:
    """Env var names: uppercase letters, digits, underscores; no leading digit."""
    v = value.strip()
    if not v:
        return "Env var name cannot be empty."
    if "=" in v:
        return "Enter only the variable name (e.g. STRIPE_SECRET_KEY), not an assignment."
    if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", v):
        return "Env var must be UPPERCASE with letters, digits, and underscores only."
    return True


def validate_env_var_optional(value: str) -> bool | str:
    if not value.strip():
        return True
    return validate_env_var(value)


def validate_pattern(value: str) -> bool | str:
    """Allow-rule path pattern must start with /."""
    v = value.strip()
    if not v:
        return "Pattern cannot be empty."
    if not v.startswith("/"):
        return "Pattern must start with / (e.g. /v1/orders)."
    return True


def validate_positive_int(value: str) -> bool | str:
    """Must be a non-negative integer."""
    try:
        n = int(value.strip())
        if n < 0:
            return "Value must be 0 or greater."
        return True
    except ValueError:
        return "Enter a whole number (e.g. 10)."


def validate_module_path(value: str) -> bool | str:
    """Plugin module path: dotted.path:ClassName."""
    v = value.strip()
    if not v:
        return "Module path cannot be empty."
    if ":" not in v:
        return "Format must be dotted.module.path:ClassName (e.g. app.plugins.my_auth:MyAuth)."
    mod, cls = v.rsplit(":", 1)
    if not mod or not cls:
        return "Both module path and class name must be non-empty."
    if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_.]*", mod):
        return "Module path must be a valid dotted Python identifier."
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", cls):
        return "Class name must be a valid Python identifier."
    return True


def validate_header_name(value: str) -> bool | str:
    v = value.strip()
    if not v:
        return "Header name cannot be empty."
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", v):
        return "Header names may only contain letters, digits, hyphens, and underscores."
    return True


def parse_int_list(raw: str) -> list[int]:
    """Parse comma-separated string of integers, skipping blanks."""
    result = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            result.append(int(part))
    return result


def normalize_name(value: str) -> str:
    return value.strip().lower()


def normalize_url(value: str) -> str:
    return value.strip().rstrip("/")


def suggest_env_var(provider_name: str, suffix: str) -> str:
    """Build a suggested env var name like STRIPE_SECRET_KEY."""
    return f"{provider_name.upper().replace('-', '_')}_{suffix}"
