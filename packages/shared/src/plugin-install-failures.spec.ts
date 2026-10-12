import { describe, expect, it } from "vitest";

import {
  pluginInstallFailureReason,
  pluginInstallFailureValues,
} from "./plugin-install-failures.ts";

describe("pluginInstallFailureValues", () => {
  it("reads the budget in whole seconds, and counts by them", () => {
    expect(pluginInstallFailureValues({ budgetMs: 480_000 })).toEqual({
      budgetMs: 480_000,
      budgetSeconds: 480,
      count: 480,
    });
  });

  it("reads a deadline in whole seconds, and counts by them", () => {
    expect(pluginInstallFailureValues({ timeoutMs: 180_001 })).toEqual({
      timeoutMs: 180_001,
      // Rounded up: a deadline a fraction past a second is not that second.
      timeoutSeconds: 181,
      count: 181,
    });
  });

  it("never reads a deadline cut short as no time at all", () => {
    expect(pluginInstallFailureValues({ timeoutMs: 1 })).toMatchObject({
      timeoutSeconds: 1,
      count: 1,
    });
  });

  it("reads the size cap in whole MiB", () => {
    expect(
      pluginInstallFailureValues({ maxBytes: 64 * 1024 * 1024 }),
    ).toMatchObject({ maxMebibytes: 64 });
  });

  it("passes identifiers through as they are", () => {
    expect(
      pluginInstallFailureValues({ packageName: "openbrf-plugin-occupancy" }),
    ).toEqual({ packageName: "openbrf-plugin-occupancy" });
  });
});

describe("pluginInstallFailureReason", () => {
  it("narrows a known code", () => {
    expect(pluginInstallFailureReason("checksum-mismatch")).toBe(
      "checksum-mismatch",
    );
  });

  it("answers null for a code this version does not know, and for none", () => {
    expect(pluginInstallFailureReason("registry-on-fire")).toBeNull();
    expect(pluginInstallFailureReason(null)).toBeNull();
  });
});
