"""Click entry point and subcommand dispatch for the Outpost CLI."""

from __future__ import annotations

import sys
from pathlib import Path

import click
from rich.console import Console


@click.group()
def cli() -> None:
    """Outpost — the edge sidecar for AI agents."""


@cli.command("add-provider")
def add_provider() -> None:
    """Interactively generate a new provider YAML."""
    try:
        from outpost_cli.wizard import run_wizard

        run_wizard()
    except KeyboardInterrupt:
        Console().print("\n[dim]Cancelled.[/dim]")
        sys.exit(130)


@cli.command("validate")
@click.argument("file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def validate(file: Path) -> None:
    """Validate an existing provider YAML against the schema."""
    import yaml

    console = Console()

    try:
        from app.python.providers.schema import ProviderSchema  # type: ignore[import]
    except ImportError:
        console.print(
            "[red]Cannot import app.python.providers.schema — run outpost from the repo root.[/red]"
        )
        sys.exit(1)

    try:
        raw = yaml.safe_load(file.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        console.print(f"[red]✗ YAML parse error:[/red] {exc}")
        sys.exit(1)

    from pydantic import ValidationError

    try:
        provider = ProviderSchema.model_validate(raw)
        mode = provider.forwarding.mode
        rule_count = len(provider.forwarding.allow)
        auth_type = provider.auth.type
        console.print(
            f"[green]✓ Valid[/green]  [bold]{provider.name}[/bold] — "
            f"mode={mode}, rules={rule_count}, auth={auth_type}"
        )
    except ValidationError as exc:
        from outpost_cli.render import format_validation_error

        console.print(format_validation_error(exc))
        sys.exit(1)
    except Exception as exc:
        console.print(f"[red]✗ Unexpected error:[/red] {exc}")
        sys.exit(1)
