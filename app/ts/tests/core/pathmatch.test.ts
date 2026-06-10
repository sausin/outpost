import { describe, test, expect } from "vitest";
import {
  compilePattern,
  compileRule,
  matches,
} from "../../src/core/pathmatch.ts";

describe("compilePattern / matches — path matching", () => {
  test("exact path matches itself and not a child", () => {
    const rule = compileRule("GET", "/v1/customers");
    expect(matches(rule, "GET", "/v1/customers")).toBe(true);
    expect(matches(rule, "GET", "/v1/customers/123")).toBe(false);
  });

  test("single-segment wildcard * matches one segment, not two", () => {
    const rule = compileRule("GET", "/v1/customers/*");
    expect(matches(rule, "GET", "/v1/customers/abc")).toBe(true);
    expect(matches(rule, "GET", "/v1/customers/abc/cards")).toBe(false);
  });

  test("multi-segment wildcard ** matches single and multi-segment children", () => {
    const rule = compileRule("GET", "/v1/customers/**");
    expect(matches(rule, "GET", "/v1/customers/abc")).toBe(true);
    expect(matches(rule, "GET", "/v1/customers/abc/cards")).toBe(true);
    expect(matches(rule, "GET", "/v1/customers/abc/cards/456")).toBe(true);
  });

  test("{name} placeholder matches one segment only", () => {
    const rule = compileRule("GET", "/v1/{id}/details");
    expect(matches(rule, "GET", "/v1/ACC123/details")).toBe(true);
    expect(matches(rule, "GET", "/v1/a/b/details")).toBe(false);
    expect(matches(rule, "GET", "/v1//details")).toBe(false);
  });

  test("literal dot is not a regex wildcard", () => {
    const rule = compileRule("GET", "/v1/foo.bar");
    expect(matches(rule, "GET", "/v1/foo.bar")).toBe(true);
    expect(matches(rule, "GET", "/v1/fooXbar")).toBe(false);
  });

  test("method * matches any HTTP method when path matches", () => {
    const rule = compileRule("*", "/v1/resource");
    expect(matches(rule, "GET", "/v1/resource")).toBe(true);
    expect(matches(rule, "POST", "/v1/resource")).toBe(true);
    expect(matches(rule, "DELETE", "/v1/resource")).toBe(true);
  });

  test("method mismatch returns false even when path matches", () => {
    const rule = compileRule("GET", "/v1/customers");
    expect(matches(rule, "POST", "/v1/customers")).toBe(false);
  });

  test("method comparison is case-insensitive (rule normalises to upper)", () => {
    const rule = compileRule("get", "/v1/customers");
    expect(matches(rule, "GET", "/v1/customers")).toBe(true);
    expect(matches(rule, "get", "/v1/customers")).toBe(true);
  });

  test("* at the start of a path segment works as wildcard", () => {
    const rule = compileRule("GET", "/*/foo");
    expect(matches(rule, "GET", "/bar/foo")).toBe(true);
    expect(matches(rule, "GET", "/baz/foo")).toBe(true);
    expect(matches(rule, "GET", "/bar/baz/foo")).toBe(false);
  });

  test("compilePattern anchors the regex — no partial match", () => {
    const re = compilePattern("/v1/users");
    expect(re.test("/v1/users")).toBe(true);
    expect(re.test("/v1/users/extra")).toBe(false);
    expect(re.test("prefix/v1/users")).toBe(false);
  });
});
