"""Glob-style path pattern compiler for provider allow/deny rules.

Supported syntax:
  *        matches one or more characters except '/' (single-segment wildcard)
  **       matches any characters including '/' (multi-segment wildcard)
  {name}   treated as * (placeholder for one path segment; no capture in v1)
  anything else is treated as a literal character

All matches are anchored (start-to-end); partial matches are not considered.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


def compile_pattern(pattern: str) -> re.Pattern:
    """Compile a glob path pattern into a regex.

    Examples:
      "/v1/customers"     matches only that exact path
      "/v1/customers/*"   matches /v1/customers/cust_123 but NOT /v1/customers/cust_123/cards
      "/v1/customers/**"  matches both of the above
      "/v1/{id}/details"  matches /v1/foo/details
    """
    tokens: list[str] = []
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "*":
            # Check for ** before consuming a single *
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                tokens.append(".+")  # multi-segment: any characters (at least one)
                i += 2
            else:
                tokens.append("[^/]+")  # single-segment wildcard
                i += 1
        elif ch == "{":
            # Skip to matching '}'; treat whole placeholder as a single segment wildcard
            end = pattern.find("}", i)
            if end == -1:
                # Unclosed brace — treat '{' as literal
                tokens.append(re.escape(ch))
                i += 1
            else:
                tokens.append("[^/]+")
                i = end + 1
        else:
            tokens.append(re.escape(ch))
            i += 1
    return re.compile("".join(tokens))


@dataclass(frozen=True)
class CompiledRule:
    method: str  # "GET" / "POST" / ... / "*"
    pattern: re.Pattern
    raw_pattern: str  # kept for logging / OpenAPI


def compile_rule(method: str, pattern: str) -> CompiledRule:
    return CompiledRule(
        method=method.upper(),
        pattern=compile_pattern(pattern),
        raw_pattern=pattern,
    )


def matches(rule: CompiledRule, method: str, path: str) -> bool:
    if rule.method != "*" and rule.method != method.upper():
        return False
    return rule.pattern.fullmatch(path) is not None
