import { describe, expect, it } from "vitest";

import { findingsOf } from "./theme-failures";

/**
 * What a refusal's findings are read from.
 *
 * The server sends them as the failure's detail, and the findings list draws
 * each one's own detail fields. Anything that reaches the renderer therefore
 * has to carry a detail object: an entry without one would throw while the
 * refusal was being drawn, which turns a message the board could act on into
 * a blank screen at exactly the wrong moment.
 */
describe("findingsOf", () => {
  it("keeps a finding that carries a rule and a detail", () => {
    const findings = findingsOf({
      status: 422,
      reason: "lint-failed",
      detail: [
        {
          rule: "contrast",
          severity: "error",
          detail: { mode: "dark", ratio: 1.9, statutory: true },
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("contrast");
  });

  it("drops an entry with no detail rather than letting the renderer throw", () => {
    const findings = findingsOf({
      status: 422,
      reason: "lint-failed",
      detail: [{ rule: "contrast", severity: "error" }],
    });

    expect(findings).toEqual([]);
  });

  it("drops an entry whose detail is null", () => {
    const findings = findingsOf({
      status: 422,
      reason: "lint-failed",
      detail: [{ rule: "contrast", severity: "error", detail: null }],
    });

    expect(findings).toEqual([]);
  });

  it("answers with nothing when the refusal carried no findings at all", () => {
    expect(findingsOf({ status: 503, reason: "mail-not-configured" })).toEqual(
      [],
    );
  });
});
