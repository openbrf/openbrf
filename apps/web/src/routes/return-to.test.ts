import { describe, expect, it } from "vitest";

import { safeReturnTo } from "./return-to";

/**
 * The guard on where sign-in lands.
 *
 * This is a security boundary rather than a convenience: the value comes out
 * of a query string, so whoever wrote the link chose it, and a value that
 * leaves the origin turns this cooperative's own sign-in screen into the last
 * step before a page asking a member for the password they just typed. Every
 * rejection below is a documented way out of an origin, so each one is named
 * rather than left to a single "looks wrong" case.
 */

describe("a path inside this application", () => {
  it.each([
    "/",
    "/documents",
    "/registers/members",
    "/documents?shelf=styrelsen",
    "/meetings?year=2026&tab=decisions",
    "/documents#arsredovisning",
    "/dokument/arsredovisning",
    // Already encoded, so the characters refused raw are not refused here: a
    // %09 in a path is a path segment and not a tab a browser strips.
    "/documents/%09namn",
    "/documents/%2f%2fexample.test",
  ])("is kept as it was written: %s", (value) => {
    expect(safeReturnTo(value)).toBe(value);
  });
});

describe("another origin, however it is spelled", () => {
  it.each([
    // Protocol-relative: no scheme, and a host all the same.
    "//evil.example",
    "///evil.example",
    "//evil.example/documents",
    // A backslash a browser normalises to a slash, so this is the case above.
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "/documents\\..\\..",
    // A scheme, named outright.
    "https://evil.example",
    "http://evil.example/documents",
    "javascript:alert(1)",
    "data:text/html,<script></script>",
    "//evil.example:8443",
  ])("is refused: %s", (value) => {
    expect(safeReturnTo(value)).toBeNull();
  });
});

describe("a separator a browser strips before it parses the URL", () => {
  it.each([
    ["tab first", "\t//evil.example"],
    ["tab after the slash", "/\t/evil.example"],
    ["newline first", "\n//evil.example"],
    ["newline after the slash", "/\n/evil.example"],
    ["carriage return", "/\r/evil.example"],
    ["all three", "/\t\n\r/evil.example"],
    ["a null byte", "/\u0000/evil.example"],
    ["a vertical tab", "/\u000b/evil.example"],
    ["DEL", "/\u007f/evil.example"],
  ])("is refused: %s", (_name, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });
});

describe("a space", () => {
  it.each([
    ["trailing", "/path "],
    ["leading", " /path"],
    ["embedded", "/path /evil.example"],
    ["the whole value", " "],
  ])("is refused: %s", (_name, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });
});

describe("a traversal", () => {
  it.each(["/../evil.example", "/..//evil.example", "/documents/../..", "/.."])(
    "is refused: %s",
    (value) => {
      expect(safeReturnTo(value)).toBeNull();
    },
  );
});

describe("anything that is not a path at all", () => {
  it.each([
    ["empty", ""],
    ["a bare word", "documents"],
    ["a relative path", "./documents"],
    ["a parent path", "../documents"],
    ["a query on its own", "?shelf=styrelsen"],
    ["a fragment on its own", "#arsredovisning"],
  ])("is refused: %s", (_name, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number, as the router parses a numeric value", 1],
    ["a boolean", true],
    ["an array, as the router parses a repeated parameter", ["/documents"]],
    ["an object", { pathname: "/documents" }],
  ])("is refused when it is not a string: %s", (_name, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });
});
