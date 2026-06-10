/**
 * Glob-style path pattern compiler — mirrors app/core/pathmatch.py
 *
 * Supported syntax:
 *   *        matches one or more characters except '/' (single-segment wildcard)
 *   **       matches any characters including '/' (multi-segment wildcard)
 *   {name}   treated as * (placeholder for one path segment; no capture in v1)
 *   anything else is treated as a literal character
 *
 * All matches are anchored (start-to-end); partial matches are not considered.
 */

export interface CompiledRule {
  method: string;
  pattern: RegExp;
  rawPattern: string;
}

/**
 * Compile a glob path pattern into a RegExp.
 *
 * Examples:
 *   "/v1/customers"     matches only that exact path
 *   "/v1/customers/*"   matches /v1/customers/cust_123 but NOT /v1/customers/cust_123/cards
 *   "/v1/customers/**"  matches both of the above
 *   "/v1/{id}/details"  matches /v1/foo/details
 */
export function compilePattern(pattern: string): RegExp {
  const tokens: string[] = [];
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        tokens.push(".+"); // multi-segment: any characters (at least one)
        i += 2;
      } else {
        tokens.push("[^/]+"); // single-segment wildcard
        i += 1;
      }
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        // Unclosed brace — treat '{' as literal
        tokens.push(escapeRegex(ch));
        i += 1;
      } else {
        tokens.push("[^/]+");
        i = end + 1;
      }
    } else {
      tokens.push(escapeRegex(ch));
      i += 1;
    }
  }

  return new RegExp(`^${tokens.join("")}$`);
}

export function compileRule(method: string, pattern: string): CompiledRule {
  return {
    method: method.toUpperCase(),
    pattern: compilePattern(pattern),
    rawPattern: pattern,
  };
}

export function matches(
  rule: CompiledRule,
  method: string,
  path: string,
): boolean {
  if (rule.method !== "*" && rule.method !== method.toUpperCase()) {
    return false;
  }
  return rule.pattern.test(path);
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
