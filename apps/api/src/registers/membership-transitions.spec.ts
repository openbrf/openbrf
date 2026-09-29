import { describe, expect, it } from "vitest";

import {
  type MemberResidencySpan,
  owedMembershipEvents,
} from "./membership-transitions";
import {
  type MemberRegisterEvent,
  membershipPeriods,
  resolveRegisterEvents,
} from "./membership-periods";

/**
 * What the member register owes a change to a person's tenant-ownerships.
 *
 * The cases are the ones the order of recording used to decide: a back-dated
 * move-in entered after a later one, two move-outs entered against their date
 * order, an apartment bought for later while another is still held, and a
 * file's rows in either order. Each is checked the way the register is read -
 * the rows written, paired into memberships by `membershipPeriods` - because a
 * row that is right on its own and wrong beside the others is still wrong.
 */

function column(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`);
}

function span(
  apartmentId: string,
  movedInOn: string,
  movedOutOn: string | null = null,
): MemberResidencySpan {
  return {
    apartmentId,
    movedInOn: column(movedInOn),
    movedOutOn: movedOutOn === null ? null : column(movedOutOn),
  };
}

/**
 * Plays a sequence of residency states through, in the order they were
 * recorded, and returns what the register holds afterwards: every row, and the
 * memberships it reads as.
 */
function record(states: readonly (readonly MemberResidencySpan[])[]) {
  const rows: MemberRegisterEvent[] = [];
  let before: readonly MemberResidencySpan[] = [];
  for (const after of states) {
    for (const event of owedMembershipEvents(before, after)) {
      rows.push({
        id: `row-${String(rows.length)}`,
        personId: "p",
        eventType: event.eventType,
        eventOn: event.eventOn,
        correctsEntryId: null,
        // Written in order, so a later row sorts after an earlier one on the
        // same day, as the database's clock would put it.
        createdAt: new Date(rows.length),
      });
    }
    before = after;
  }

  const periods = membershipPeriods(resolveRegisterEvents(rows)).map(
    (period) => ({
      from: period.entry?.eventOn.toISOString().slice(0, 10) ?? null,
      to: period.exit?.eventOn.toISOString().slice(0, 10) ?? null,
    }),
  );
  return {
    rows: rows.map(
      (row) => `${row.eventType} ${row.eventOn.toISOString().slice(0, 10)}`,
    ),
    periods,
  };
}

describe("owedMembershipEvents", () => {
  it("enters a first tenant-ownership and leaves a second one alone", () => {
    const a = span("a", "2020-01-01");
    const b = span("b", "2023-01-01");

    expect(owedMembershipEvents([], [a])).toEqual([
      { eventType: "ENTRY", eventOn: column("2020-01-01"), apartmentId: "a" },
    ]);
    expect(owedMembershipEvents([a], [a, b])).toEqual([]);
  });

  it("dates the membership from a back-dated move-in entered after a later one", () => {
    // Before the fix the later purchase counted as "not ended" on the earlier
    // day, so the back-dated move-in wrote no ENTRY and the register dated the
    // membership from 2027.
    const b = span("b", "2027-01-01");
    const a = span("a", "2026-10-01");

    expect(owedMembershipEvents([b], [b, a])).toEqual([
      { eventType: "ENTRY", eventOn: column("2026-10-01"), apartmentId: "a" },
    ]);
    expect(record([[b], [b, a]]).periods).toEqual([
      { from: "2026-10-01", to: null },
    ]);
  });

  it("closes the membership when two move-outs are entered against their date order", () => {
    // Each move-out used to see the other apartment as not yet ended and so
    // still held, and neither wrote the EXIT.
    const a = span("a", "2020-01-01");
    const b = span("b", "2021-01-01");
    const aOut = span("a", "2020-01-01", "2026-12-01");
    const bOut = span("b", "2021-01-01", "2026-11-01");

    expect(owedMembershipEvents([a, b], [aOut, b])).toEqual([]);
    expect(owedMembershipEvents([aOut, b], [aOut, bOut])).toEqual([
      { eventType: "EXIT", eventOn: column("2026-12-01"), apartmentId: "a" },
    ]);
    expect(record([[a], [a, b], [aOut, b], [aOut, bOut]]).periods).toEqual([
      { from: "2020-01-01", to: "2026-12-01" },
    ]);
  });

  it("shows the gap before an apartment bought for later", () => {
    const a = span("a", "2020-01-01");
    const b = span("b", "2026-12-01");
    const aOut = span("a", "2020-01-01", "2026-09-30");

    expect(owedMembershipEvents([a, b], [aOut, b])).toEqual([
      { eventType: "EXIT", eventOn: column("2026-09-30"), apartmentId: "a" },
      { eventType: "ENTRY", eventOn: column("2026-12-01"), apartmentId: "b" },
    ]);
    expect(record([[a], [a, b], [aOut, b]]).periods).toEqual([
      { from: "2020-01-01", to: "2026-09-30" },
      { from: "2026-12-01", to: null },
    ]);
  });

  it("writes no gap between a move-out and a move-in on the same day", () => {
    const a = span("a", "2020-01-01");
    const aOut = span("a", "2020-01-01", "2024-06-01");
    const b = span("b", "2024-06-01");

    expect(record([[a], [a, b], [aOut, b]])).toEqual({
      rows: ["ENTRY 2020-01-01"],
      periods: [{ from: "2020-01-01", to: null }],
    });
  });

  it("reads the same whichever order a file lists a person's rows in", () => {
    const early = span("a", "2010-01-01", "2015-01-01");
    const late = span("b", "2022-01-01");
    const expected = [
      { from: "2010-01-01", to: "2015-01-01" },
      { from: "2022-01-01", to: null },
    ];

    const inDateOrder = record([[early], [early, late]]);
    const latestFirst = record([[late], [late, early]]);

    expect(inDateOrder.periods).toEqual(expected);
    expect(latestFirst.periods).toEqual(expected);
    expect(inDateOrder.rows).toEqual([
      "ENTRY 2010-01-01",
      "EXIT 2015-01-01",
      "ENTRY 2022-01-01",
    ]);
  });

  it("answers an EXIT a back-dated move-in bridges with an ENTRY on its day", () => {
    // The EXIT cannot be taken back, so the register shows two memberships
    // meeting on 2022-01-01, which is true of every day in them.
    const x = span("x", "2021-01-01", "2022-01-01");
    const a = span("a", "2020-01-01");

    expect(owedMembershipEvents([x], [x, a])).toEqual([
      { eventType: "ENTRY", eventOn: column("2020-01-01"), apartmentId: "a" },
      { eventType: "ENTRY", eventOn: column("2022-01-01"), apartmentId: "a" },
    ]);
    expect(record([[x], [x, a]]).periods).toEqual([
      { from: "2020-01-01", to: "2022-01-01" },
      { from: "2022-01-01", to: null },
    ]);
  });

  it("closes a membership moved out of on the day it began", () => {
    const a = span("a", "2024-01-01");
    const aOut = span("a", "2024-01-01", "2024-01-01");

    expect(owedMembershipEvents([a], [aOut])).toEqual([
      { eventType: "EXIT", eventOn: column("2024-01-01"), apartmentId: "a" },
    ]);
  });

  it("owes nothing for residencies that did not change", () => {
    const a = span("a", "2020-01-01", "2021-01-01");
    const b = span("b", "2022-01-01");

    expect(owedMembershipEvents([a, b], [b, a])).toEqual([]);
  });
});
