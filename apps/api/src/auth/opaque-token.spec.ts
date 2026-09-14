import { describe, expect, it } from "vitest";

import { hashOpaqueToken } from "./opaque-token";

/**
 * The digest is pinned to a literal on purpose.
 *
 * Every access and refresh token in an instance is stored under this value. If
 * the construction ever changes, every one of them stops resolving at once,
 * and it does so silently: a lookup miss is indistinguishable from a token
 * that was revoked, so the interface would report that every member had
 * disconnected every connected app rather than reporting a fault. A literal is
 * what turns that into a failing test.
 */
describe("hashOpaqueToken", () => {
  it("is sha256, base64url, unpadded", () => {
    // The sha256 of "openbrf" as base64url. Padding would end it with "=".
    expect(hashOpaqueToken("openbrf")).toBe(
      "Dw2IjKhXMqZmAQPb-7sHzcTMAl5w-M6-vjgoiaP5WP8",
    );
  });

  it("does not pad", () => {
    for (const token of ["", "a", "ab", "abc", "abcd"]) {
      expect(hashOpaqueToken(token)).not.toContain("=");
    }
  });

  it("uses the URL-safe alphabet", () => {
    // Over a spread of inputs, plain base64's "+" and "/" must never appear:
    // the value is used as a database key and read out of log lines.
    for (let index = 0; index < 200; index += 1) {
      const digest = hashOpaqueToken(`token-${String(index)}`);
      expect(digest).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("is stable across calls", () => {
    expect(hashOpaqueToken("same")).toBe(hashOpaqueToken("same"));
  });

  it("separates tokens that differ by one character", () => {
    expect(hashOpaqueToken("token-a")).not.toBe(hashOpaqueToken("token-b"));
  });

  it("does not contain the token", () => {
    const token = "a-secret-bearer-value";
    expect(hashOpaqueToken(token)).not.toContain(token);
  });
});
