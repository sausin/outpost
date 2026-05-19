"""Settings loaded from environment / .env file."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Network
    proxy_host: str = "0.0.0.0"
    proxy_port: int = 8080
    trusted_proxies: str = ""  # comma-separated CIDRs

    # Provider configuration
    providers_dir: str = "./builtin_providers"  # where to scan for *.yaml
    extra_providers_dir: str = ""  # optional: user-supplied dir; merged on top
    # If set and X-Broker header is absent, use this provider name.
    # Empty = require X-Broker header on every request.
    default_provider: str = ""
    plugins_module_path: str = ""  # optional: extra import path for plugin auth modules

    # Infra
    redis_url: str = "redis://localhost:6379/0"
    hosts_config_path: str = "./hosts.yaml"

    # Rate-limit queue: max wait before 429 (seconds)
    rate_limit_queue_timeout: float = 2.0


settings = Settings()
