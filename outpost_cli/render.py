"""YAML rendering and rich syntax-highlighted preview helpers."""

from __future__ import annotations

import re

import yaml
from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.text import Text


def _represent_str(dumper: yaml.Dumper, data: str) -> yaml.ScalarNode:
    """Use literal block style for multi-line strings, quoted for strings containing special chars."""
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


yaml.add_representer(str, _represent_str)


def build_yaml(data: dict) -> str:
    """Serialise provider data dict to a YAML string."""
    return yaml.dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True, width=100)


def preview_yaml(yaml_str: str, console: Console | None = None) -> None:
    """Print a syntax-highlighted YAML panel."""
    con = console or Console()
    syntax = Syntax(yaml_str, "yaml", theme="monokai", line_numbers=True, word_wrap=False)
    con.print(
        Panel(
            syntax,
            title="[bold cyan]Generated YAML — review before saving[/bold cyan]",
            border_style="cyan",
            padding=(1, 2),
        )
    )


def print_header(console: Console, existing_providers: list[str]) -> None:
    """Print the wizard welcome panel."""
    lines = [
        "[bold white]Outpost · Provider Wizard[/bold white]",
        "[dim]Generate a YAML in 6 quick steps.[/dim]",
        "[dim]Ctrl-C anytime to cancel — nothing is written until you confirm at the end.[/dim]",
    ]
    if existing_providers:
        names = ", ".join(existing_providers)
        lines.append(f"[dim]Existing providers: {names}[/dim]")

    console.print(
        Panel(
            "\n".join(lines),
            border_style="blue",
            padding=(1, 2),
        )
    )


def print_step(console: Console, step: int, total: int, title: str) -> None:
    console.print(f"\n[bold blue]Step {step}/{total}[/bold blue] [bold]{title}[/bold]")
    console.rule(style="dim blue")


def print_success(console: Console, path: str, env_vars: list[str], provider_name: str) -> None:
    """Print the post-save next-steps panel."""
    env_lines = "\n".join(f"       {v}=..." for v in env_vars) if env_vars else "       (none detected)"
    body = (
        f"[green]✓ Saved to {path}[/green]\n\n"
        "[bold]Next steps:[/bold]\n"
        "  1. Add referenced env vars to your .env:\n"
        f"{env_lines}\n"
        "  2. (Re)start the proxy:\n"
        "       docker compose restart proxy\n"
        "  3. Test it:\n"
        f"       curl -H \"X-Provider: {provider_name}\" http://localhost:8080/<your-path>"
    )
    console.print(Panel(body, border_style="green", padding=(1, 2)))


def extract_env_vars(yaml_str: str) -> list[str]:
    """Scan YAML text for env var references (keys ending in _env or env: value)."""
    found: set[str] = set()
    # Match: some_env: VARNAME  or  env: VARNAME
    for match in re.finditer(r"(?:^|\s)[\w_]*env:\s+([A-Z][A-Z0-9_]+)", yaml_str, re.MULTILINE):
        found.add(match.group(1))
    return sorted(found)


def format_validation_error(exc: Exception) -> Text:
    """Format a Pydantic ValidationError as readable rich Text."""
    text = Text()
    text.append("Validation failed:\n", style="bold red")
    try:
        for err in exc.errors():  # type: ignore[attr-defined]
            loc = " → ".join(str(p) for p in err["loc"])
            msg = err["msg"]
            text.append(f"  • {loc}: {msg}\n", style="red")
    except AttributeError:
        text.append(str(exc), style="red")
    return text
