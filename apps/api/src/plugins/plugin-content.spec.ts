import { describe, expect, it } from "vite-plus/test";

import {
  contentAudience,
  readInstant,
  readWindow,
  visibilityOf,
} from "./plugin-content";

/**
 * How the content services read what a plugin passes them.
 *
 * A plugin passes plain strings, typed or not, so each of these has to refuse
 * what is not what the contract says rather than read it leniently - and has
 * to leave what was passed out of the message, which ends up in the log.
 */

describe("readInstant", () => {
  it.each([
    "2026-11-01T00:00:00Z",
    "2026-11-01T00:00Z",
    "2026-11-01T09:30:00.123+01:00",
  ])("reads %s", (value) => {
    expect(readInstant(value, "from").getTime()).toBe(
      new Date(value).getTime(),
    );
  });

  it.each([
    ["a bare date, which Date reads as UTC midnight", "2026-11-01"],
    [
      "a time with no offset, which Date reads on the server's clock",
      "2026-11-01T09:30:00",
    ],
    ["a date that does not exist", "2026-13-45T00:00:00Z"],
    ["something else", "next tuesday"],
    ["a number", 1_793_491_200_000],
    ["nothing", undefined],
  ])("refuses %s", (_what, value) => {
    expect(() => readInstant(value, "from")).toThrow(RangeError);
  });

  it("leaves the value out of the message", () => {
    expect(() => readInstant("anna@example.test", "since")).toThrow(
      /^"since" is not an ISO 8601 instant/,
    );
    expect(() => readInstant("anna@example.test", "since")).not.toThrow(/anna/);
  });
});

describe("readWindow", () => {
  it("reads a window inside the bound", () => {
    expect(
      readWindow(
        { from: "2026-11-01T00:00:00Z", to: "2026-12-02T00:00:00Z" },
        31,
      ),
    ).toEqual({
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-12-02T00:00:00Z"),
    });
  });

  it("refuses a window longer than the bound", () => {
    expect(() =>
      readWindow(
        { from: "2026-11-01T00:00:00Z", to: "2026-12-02T00:00:01Z" },
        31,
      ),
    ).toThrow(/at most 31 days apart/);
  });

  it.each([
    ["an empty window", "2026-11-01T00:00:00Z"],
    ["a window that runs backwards", "2026-10-31T00:00:00Z"],
  ])("refuses %s", (_what, to) => {
    expect(() => readWindow({ from: "2026-11-01T00:00:00Z", to }, 31)).toThrow(
      RangeError,
    );
  });

  it("refuses no window at all", () => {
    expect(() => readWindow(undefined, 31)).toThrow(RangeError);
  });
});

describe("the audience", () => {
  it("names the stored visibility in the contract's words, both ways", () => {
    expect(contentAudience("PUBLIC")).toBe("anyone");
    expect(contentAudience("MEMBER")).toBe("members");
    expect(visibilityOf("anyone")).toBe("PUBLIC");
    expect(visibilityOf("members")).toBe("MEMBER");
  });

  it("refuses an audience the contract does not name", () => {
    // The stored value is not the contract's, and a plugin passing it is
    // relying on something it was never promised.
    expect(() => visibilityOf("PUBLIC")).toThrow(RangeError);
  });
});
