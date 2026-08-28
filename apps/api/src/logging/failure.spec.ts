import { describe, expect, it } from "vitest";

import { failureFrames, failureName } from "./failure";

/**
 * What a failure is allowed to put in the log.
 *
 * An exception message is composed where it is thrown, out of whatever the
 * code was handling. On this platform that is a resident's address, an email,
 * a personal identity number - masked server-side and audit-logged on every
 * reveal, neither of which reaches an unstructured container log. So the
 * message never goes there, and what does has to still be enough to diagnose
 * with: "log nothing" turns a plugin that will not load into one that cannot
 * be fixed.
 */

const REVEALING = "no apartment for anna.andersson@exempel.se (19850101-1234)";

describe("failureName", () => {
  it("names the class without repeating what was said", () => {
    expect(failureName(new TypeError(REVEALING))).toBe("TypeError");
  });

  it("keeps the runtime's code, which is what places a failed load", () => {
    // ERR_MODULE_NOT_FOUND against ERR_REQUIRE_ESM is the whole difference
    // between a missing dependency and a bundle built the wrong way.
    const cause = Object.assign(new Error(REVEALING), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    expect(failureName(cause)).toBe("Error (ERR_MODULE_NOT_FOUND)");
  });

  it("says nothing twice when the code is the name", () => {
    const cause = Object.assign(new Error("x"), { code: "Error" });

    expect(failureName(cause)).toBe("Error");
  });

  it("ignores a code that is not a string", () => {
    const cause = Object.assign(new Error("x"), {
      code: { toString: () => 1 },
    });

    expect(failureName(cause)).toBe("Error");
  });

  /**
   * A name is a string the throwing code owns. Reducing it to one bounded
   * token is what stops a name with newlines in it from writing log entries of
   * its own and a long one from flooding them.
   */
  it("reduces a name that is not an identifier to one bounded token", () => {
    const forged = new Error("x");
    forged.name = `Bad\n[Nest] 1 - WARN [Auth] granted to ${REVEALING}`;

    const named = failureName(forged);

    expect(named).not.toContain("\n");
    expect(named).not.toContain("anna.andersson@exempel.se");
    expect(named).not.toContain(" ");
    expect(named.length).toBeLessThanOrEqual(60);
  });

  it("falls back to a name when the thrown value has none", () => {
    const nameless = new Error("x");
    nameless.name = "";

    expect(failureName(nameless)).toBe("Error");
  });

  it("says what kind of value was thrown when it is not an Error", () => {
    expect(failureName(REVEALING)).toBe("string");
    expect(failureName({ message: REVEALING })).toBe("object");
    expect(failureName(undefined)).toBe("undefined");
  });
});

describe("failureFrames", () => {
  it("keeps only the call frames", () => {
    const frames = failureFrames(new Error(REVEALING)) ?? "";

    expect(frames).not.toBe("");
    expect(frames).not.toContain(REVEALING);
    expect(
      frames.split("\n").every((line) => line.trimStart().startsWith("at ")),
    ).toBe(true);
  });

  /**
   * A V8 stack begins with `Name: message` and a multi-line message runs on
   * over the lines below it, so the frames are selected rather than the first
   * line dropped.
   */
  it("drops every line of a message that spans several", () => {
    const cause = new Error(`first line\nsecond line with ${REVEALING}`);

    const frames = failureFrames(cause) ?? "";

    expect(frames).not.toContain("second line");
    expect(frames).not.toContain("19850101-1234");
    expect(frames).toContain("at ");
  });

  it("has nothing to say about a value with no stack", () => {
    expect(failureFrames(REVEALING)).toBeUndefined();
    expect(failureFrames(Object.assign(new Error("x"), { stack: 7 }))).toBe(
      undefined,
    );
  });

  it("keeps a runaway stack to one log entry", () => {
    const deep = new Error("x");
    deep.stack = [
      "Error: x",
      ...Array.from({ length: 500 }, () => "    at f"),
    ].join("\n");

    expect((failureFrames(deep) ?? "").split("\n")).toHaveLength(20);
  });
});
