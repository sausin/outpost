"""Scan a directory for *.yaml provider definitions and build runtime providers."""

from __future__ import annotations

import logging
from pathlib import Path

import yaml
from redis.asyncio import Redis

from app.core.config import settings
from app.providers.provider import GenericProvider
from app.providers.schema import ProviderSchema

log = logging.getLogger(__name__)


def load_provider_files() -> list[ProviderSchema]:
    """Read all YAMLs from providers_dir (and extra_providers_dir if set).

    Later files with the same name override earlier ones.
    """
    dirs = [settings.providers_dir]
    if settings.extra_providers_dir:
        dirs.append(settings.extra_providers_dir)

    by_name: dict[str, ProviderSchema] = {}
    for d in dirs:
        p = Path(d)
        if not p.is_dir():
            log.warning("providers dir does not exist or is not a directory: %s", p)
            continue
        for f in sorted(p.glob("*.yaml")) + sorted(p.glob("*.yml")):
            try:
                data = yaml.safe_load(f.read_text())
                schema = ProviderSchema.model_validate(data)
            except Exception as e:
                log.error("Failed to load provider YAML %s: %s", f, e)
                continue
            if not schema.enabled:
                log.info("Provider %s is disabled (file=%s); skipping", schema.name, f.name)
                continue
            if schema.name in by_name:
                log.info("Provider %s overridden by %s", schema.name, f)
            by_name[schema.name] = schema
            log.info("Loaded provider definition: %s (file=%s)", schema.name, f.name)

    return list(by_name.values())


def build_providers(redis: Redis) -> dict[str, GenericProvider]:
    """Instantiate a GenericProvider for each enabled definition."""
    out: dict[str, GenericProvider] = {}
    for schema in load_provider_files():
        try:
            provider = GenericProvider.from_schema(schema, redis=redis)
        except Exception as e:
            log.error("Failed to build provider %s: %s", schema.name, e)
            continue
        out[schema.name] = provider
    return out


async def aclose_providers(providers: dict[str, GenericProvider]) -> None:
    for p in providers.values():
        await p.aclose()
