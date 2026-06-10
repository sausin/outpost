"""Host policy: load hosts.yaml, resolve client IP -> host policy via longest-prefix match.

Each host may optionally carry a pre-shared key (PSK) sourced from an env var.
When set, the proxy requires every request from that host to present a matching
`X-Outpost-Auth: <psk>` header. Hosts without a PSK skip the check (handy for
localhost-dev). Per-host scoping means revoking one agent's PSK is one env-var
rotation away — others are unaffected.
"""

from __future__ import annotations

import ipaddress
import logging
import os
from dataclasses import dataclass
from pathlib import Path

import yaml

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class HostPolicy:
    id: str
    can_call_sensitive: bool
    description: str = ""
    # Resolved PSK (from the env var named in YAML), or None if the host doesn't
    # require one. Stored at load time so missing env vars fail-fast at startup.
    auth_token: str | None = None

    # Backward-compat property so callers that haven't migrated yet still work.
    @property
    def can_trade(self) -> bool:
        return self.can_call_sensitive


class HostResolver:
    """Resolves a source IP to a HostPolicy by longest-prefix CIDR match.

    Loaded once at startup; reload by re-instantiating. Lookup is O(N_cidrs) which
    is fine for tens-to-hundreds of entries — if it grows, swap to a patricia trie.
    """

    def __init__(self, config_path: str):
        self._entries: list[tuple[ipaddress._BaseNetwork, HostPolicy]] = []
        self._load(config_path)

    def _load(self, path: str) -> None:
        data = yaml.safe_load(Path(path).read_text())
        entries: list[tuple[ipaddress._BaseNetwork, HostPolicy]] = []
        for host in data.get("hosts", []):
            can_sensitive = host.get("can_call_sensitive")
            if can_sensitive is None and "can_trade" in host:
                log.info(
                    "hosts.yaml: host %s uses deprecated 'can_trade' key; use 'can_call_sensitive'",
                    host["id"],
                )
                can_sensitive = host["can_trade"]

            auth_token: str | None = None
            token_env = host.get("auth_token_env")
            if token_env:
                resolved = os.environ.get(token_env, "")
                if not resolved:
                    raise RuntimeError(
                        f"hosts.yaml: host '{host['id']}' requires PSK via env "
                        f"var '{token_env}' but it is unset or empty. Set it "
                        f"in .env (or unset auth_token_env to disable PSK for this host)."
                    )
                auth_token = resolved
                log.info("hosts.yaml: host '%s' configured with PSK from %s", host["id"], token_env)

            policy = HostPolicy(
                id=host["id"],
                can_call_sensitive=bool(can_sensitive),
                description=host.get("description", ""),
                auth_token=auth_token,
            )
            for cidr in host["cidrs"]:
                entries.append((ipaddress.ip_network(cidr, strict=False), policy))
        # Longer prefix first — /32 wins over /24.
        entries.sort(key=lambda e: e[0].prefixlen, reverse=True)
        self._entries = entries

    def resolve(self, ip_str: str) -> HostPolicy | None:
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return None
        for net, policy in self._entries:
            if ip in net:
                return policy
        return None
