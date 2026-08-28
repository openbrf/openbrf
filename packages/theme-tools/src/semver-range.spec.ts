import { describe, expect, it } from "vitest";

import {
  compareVersions,
  isRange,
  isVersion,
  parseVersion,
  satisfiesRange,
} from "./semver-range.ts";

/**
 * The contract range decides whether a theme may be installed at all, so the
 * cases that matter are the ones where a wrong answer installs a theme against
 * a contract nobody checked.
 */

describe("parseVersion", () => {
  it("reads a release version", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("refuses a pre-release, which a published theme never is", () => {
    expect(parseVersion("1.0.0-beta.1")).toBeNull();
    expect(isVersion("1.0.0-beta.1")).toBe(false);
  });

  it("refuses a partial version", () => {
    expect(parseVersion("1.0")).toBeNull();
    expect(parseVersion("1")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    const older = { major: 1, minor: 2, patch: 9 };
    const newer = { major: 1, minor: 3, patch: 0 };
    expect(compareVersions(older, newer)).toBeLessThan(0);
    expect(compareVersions(newer, older)).toBeGreaterThan(0);
    expect(compareVersions(older, older)).toBe(0);
  });
});

describe("satisfiesRange", () => {
  it("accepts a later minor within a caret range", () => {
    expect(satisfiesRange("1.4.0", "^1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", "^1.0.0")).toBe(true);
  });

  it("refuses a later major within a caret range", () => {
    expect(satisfiesRange("2.0.0", "^1.0.0")).toBe(false);
  });

  it("refuses an earlier version than the caret floor", () => {
    expect(satisfiesRange("1.0.0", "^1.1.0")).toBe(false);
  });

  it("pins the minor for a caret on a 0.x version", () => {
    expect(satisfiesRange("0.4.9", "^0.4.0")).toBe(true);
    expect(satisfiesRange("0.5.0", "^0.4.0")).toBe(false);
  });

  it("pins the minor for a tilde range", () => {
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
  });

  it("combines comparators on one line with AND", () => {
    expect(satisfiesRange("1.5.0", ">=1.2.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.2.0 <2.0.0")).toBe(false);
  });

  it("combines alternatives with OR", () => {
    expect(satisfiesRange("2.1.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfiesRange("3.0.0", "^1.0.0 || ^2.0.0")).toBe(false);
  });

  it("matches everything for a star", () => {
    expect(satisfiesRange("9.9.9", "*")).toBe(true);
  });

  /*
   * The safe direction. A range written in syntax this subset does not read is
   * a range that cannot be honoured, and answering "matches" would install the
   * theme against a contract that was never verified.
   */
  it("refuses a range it cannot read rather than assuming a match", () => {
    expect(isRange("1.x")).toBe(false);
    expect(satisfiesRange("1.0.0", "1.x")).toBe(false);
    expect(satisfiesRange("1.0.0", "latest")).toBe(false);
    expect(satisfiesRange("1.0.0", "")).toBe(false);
  });
});
