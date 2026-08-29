import { describe, expect, it } from "vitest";

import {
  droppedSubmissionId,
  HONEYPOT_FIELD,
  isHoneypotFilled,
} from "./honeypot";

/**
 * What the decoy field counts as filled in, and what a dropped submission
 * answers with.
 *
 * The first is a question about false positives, and a false positive here is a
 * resident whose request to the board silently never arrived. A browser that
 * submits the empty field it was rendered with, or a form encoding that turns
 * an untouched field into a space, has not fallen for anything.
 */

describe("the decoy field", () => {
  it("is filled when something typed into it", () => {
    expect(
      isHoneypotFilled({ [HONEYPOT_FIELD]: "https://example.invalid" }),
    ).toBe(true);
  });

  it("is not filled by the empty value it is rendered with", () => {
    expect(isHoneypotFilled({ [HONEYPOT_FIELD]: "" })).toBe(false);
    expect(isHoneypotFilled({ [HONEYPOT_FIELD]: "   " })).toBe(false);
    expect(isHoneypotFilled({})).toBe(false);
  });

  it("is not filled by a body that is not one", () => {
    // Validation is the schema's job and runs after this; a body that is a
    // string, a number or nothing at all must not be read as a script.
    expect(isHoneypotFilled(null)).toBe(false);
    expect(isHoneypotFilled(undefined)).toBe(false);
    expect(isHoneypotFilled("website=x")).toBe(false);
    expect(isHoneypotFilled({ [HONEYPOT_FIELD]: 7 })).toBe(false);
  });
});

describe("the identifier a dropped submission answers with", () => {
  it("has the shape the stored ones have", () => {
    // A cuid: the database's own default, so the answer to a dropped
    // submission is not told apart from the answer to a stored one by its
    // shape.
    expect(droppedSubmissionId()).toMatch(/^c[0-9a-z]{24}$/);
  });

  it("is a different one every time", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => droppedSubmissionId()),
    );
    // A constant would tell a script that submitted twice exactly which of its
    // two submissions was dropped - which is to say, both of them.
    expect(ids.size).toBe(50);
  });
});
