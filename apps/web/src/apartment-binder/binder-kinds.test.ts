import { describe, expect, it } from "vitest";

import { BINDER_KINDS, type BinderEntry } from "./apartment-binder-api";
import {
  AUDIENCE_HINT,
  AUDIENCE_LABEL,
  carriesItsDay,
  defaultAudienceFor,
  fileSizeOf,
  groupByKind,
  KIND_LABEL,
  kindsFiledBy,
} from "./binder-kinds";

/**
 * What each kind of entry is, and what the form does with it.
 *
 * Three of these rules are the server's and are restated in the interface so a
 * household is not offered a form that could only be refused. A restatement
 * that drifts is worse than no restatement at all - it offers an option the
 * server throws away - so each of them is asserted here against the rule it
 * copies.
 */

function entry(id: string, kind: BinderEntry["kind"]): BinderEntry {
  return {
    id,
    kind,
    audience: "HOUSEHOLD",
    title: id,
    datedOn: null,
    filedAs: "TENANT_OWNER",
    filedByYou: false,
    fileName: `${id}.pdf`,
    contentType: "application/pdf",
    byteSize: 1024,
    url: `/api/media/${id}`,
    filedAt: "2026-09-21T09:00:00.000Z",
  };
}

describe("every kind", () => {
  it("has a word, a default audience and a filing rule", () => {
    // Written out per kind rather than composed, so a kind added to the enum
    // has to be decided about. This is what makes that true rather than
    // hoped for.
    for (const kind of BINDER_KINDS) {
      expect(KIND_LABEL[kind]).toBeTruthy();
      expect(AUDIENCE_LABEL[defaultAudienceFor(kind)]).toBeTruthy();
      expect(AUDIENCE_HINT[defaultAudienceFor(kind)]).toBeTruthy();
    }
  });

  it("is offered to the board", () => {
    expect(kindsFiledBy("BOARD")).toEqual([...BINDER_KINDS]);
  });
});

describe("the board's alteration permission", () => {
  it("is not offered to a tenant-owner", () => {
    /*
     * BRL 7 kap. 7 § gives the permission to the tenant-owner and the decision
     * to the board. What the binder is worth to the next household is that
     * "tillstand" means the board said so, so a tenant-owner filing one would
     * put two things on the screen that look alike and mean different things.
     * The service refuses it too; this is what keeps it off the form.
     */
    expect(kindsFiledBy("TENANT_OWNER")).not.toContain("ALTERATION_PERMISSION");
    expect(kindsFiledBy("TENANT_OWNER")).toContain("DRAWING");
  });

  it("carries the day the board decided it", () => {
    // A decision has the day it was taken: without it the entry cannot be read
    // against an alteration the association later has to judge under 7 kap.
    // 12 a § or 18 § 9.
    expect(carriesItsDay("ALTERATION_PERMISSION")).toBe(true);
    for (const kind of BINDER_KINDS.filter(
      (candidate) => candidate !== "ALTERATION_PERMISSION",
    )) {
      expect(carriesItsDay(kind)).toBe(false);
    }
  });

  it("is for the tenant-owners unless the board says otherwise", () => {
    // The permission is granted to the bostadsrattshavare and carries the
    // conditions they answer for; a second-hand tenant living there has no part
    // in it. Everything else describes the home and is the household's.
    expect(defaultAudienceFor("ALTERATION_PERMISSION")).toBe("TENANT_OWNERS");
    expect(defaultAudienceFor("DRAWING")).toBe("HOUSEHOLD");
    expect(defaultAudienceFor("INSTRUCTIONS")).toBe("HOUSEHOLD");
  });
});

describe("grouping a binder", () => {
  it("reads in the enum's order and never in the order it was filed", () => {
    const grouped = groupByKind([
      entry("manual", "INSTRUCTIONS"),
      entry("drawing", "DRAWING"),
      entry("permission", "ALTERATION_PERMISSION"),
    ]);

    expect(grouped.map((group) => group.kind)).toEqual([
      "DRAWING",
      "ALTERATION_PERMISSION",
      "INSTRUCTIONS",
    ]);
  });

  it("keeps the server's order inside a kind", () => {
    // The service sorts by kind, then newest first, then by filing time. A
    // second opinion here would disagree with it the day either changes.
    const grouped = groupByKind([
      entry("newer", "DRAWING"),
      entry("older", "DRAWING"),
    ]);

    expect(grouped[0]?.entries.map((each) => each.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("leaves out a kind nothing was filed under", () => {
    // A binder is a binder and not a form: six empty headings would say the
    // household had six things to do.
    expect(groupByKind([entry("drawing", "DRAWING")])).toHaveLength(1);
    expect(groupByKind([])).toEqual([]);
  });
});

describe("a file size", () => {
  it("is read in the unit that says the most about it", () => {
    expect(fileSizeOf(512)).toEqual({ unit: "bytes", size: "512" });
    expect(fileSizeOf(41_500)).toEqual({ unit: "kilobytes", size: "41" });
    expect(fileSizeOf(3_500_000)).toEqual({ unit: "megabytes", size: "3.3" });
  });
});
