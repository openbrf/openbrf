import { describe, expect, it } from "vitest";

import {
  isCurrentMembership,
  type MemberRegisterArchiveRow,
  membershipPeriods,
  recordedAt,
  resolveRegisterEvents,
} from "./membership-periods";

/**
 * Reading the member register archive.
 *
 * The archive cannot be updated or deleted, so every mistake in it is permanent
 * and every mistake in reading it is a statutory document that says something
 * untrue. These cases are the ones a real cooperative produces: a correction, a
 * member who bought a second apartment, a member who left and came back, and an
 * archive that is missing a row it should have.
 */

let sequence = 0;

function row(
  overrides: Omit<Partial<MemberRegisterArchiveRow>, "eventOn"> & {
    eventType: MemberRegisterArchiveRow["eventType"];
    /** Written as an ISO date; turned into the stored Date below. */
    eventOn: string;
  },
): MemberRegisterArchiveRow {
  sequence += 1;
  return {
    id: overrides.id ?? `entry-${String(sequence)}`,
    personId: "person-1",
    apartmentId: "apartment-1101",
    recordedFirstName: "Anna",
    recordedLastName: "Lindqvist",
    recordedPostalStreet: "Storgatan 12",
    recordedPostalCode: "11122",
    recordedPostalCity: "Stockholm",
    correctsEntryId: null,
    createdAt: new Date(
      `2020-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    ),
    ...overrides,
    eventOn: new Date(`${overrides.eventOn}T00:00:00.000Z`),
  };
}

describe("resolving corrections", () => {
  it("keeps a plain entry as it stands", () => {
    const events = resolveRegisterEvents([
      row({ id: "a", eventType: "ENTRY", eventOn: "2019-06-01" }),
    ]);

    expect(events.map((event) => event.eventType)).toEqual(["ENTRY"]);
    expect(events[0]?.corrected).toBe(false);
  });

  it("replaces a corrected row with its correction, keeping the event type", () => {
    // A correction is not a third kind of membership event: it stands in the
    // place of the row it replaces, which is what makes the date on it the
    // date the extract prints.
    const events = resolveRegisterEvents([
      row({ id: "a", eventType: "ENTRY", eventOn: "2019-06-01" }),
      row({
        id: "b",
        eventType: "CORRECTION",
        eventOn: "2019-07-01",
        correctsEntryId: "a",
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("ENTRY");
    expect(events[0]?.eventOn.toISOString().slice(0, 10)).toBe("2019-07-01");
    expect(events[0]?.corrected).toBe(true);
  });

  it("follows a chain of corrections to the original event type", () => {
    const events = resolveRegisterEvents([
      row({ id: "a", eventType: "EXIT", eventOn: "2022-01-01" }),
      row({
        id: "b",
        eventType: "CORRECTION",
        eventOn: "2022-02-01",
        correctsEntryId: "a",
      }),
      row({
        id: "c",
        eventType: "CORRECTION",
        eventOn: "2022-03-01",
        correctsEntryId: "b",
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("c");
    expect(events[0]?.eventType).toBe("EXIT");
  });

  it("drops a correction of a row that is not in the archive", () => {
    // It says nothing about when a membership began or ended, so it cannot
    // become a line in the extract. The row itself stays in the archive, which
    // is where the evidence lives.
    const events = resolveRegisterEvents([
      row({
        id: "b",
        eventType: "CORRECTION",
        eventOn: "2022-02-01",
        correctsEntryId: "missing",
      }),
    ]);

    expect(events).toEqual([]);
  });

  it("does not hang on a correction that points at itself", () => {
    const events = resolveRegisterEvents([
      row({
        id: "a",
        eventType: "CORRECTION",
        eventOn: "2022-02-01",
        correctsEntryId: "a",
      }),
    ]);

    expect(events).toEqual([]);
  });
});

describe("pairing memberships", () => {
  it("reads an entry with no exit as a current membership", () => {
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({ eventType: "ENTRY", eventOn: "2019-06-01" }),
      ]),
    );

    expect(periods).toHaveLength(1);
    expect(periods[0]?.exit).toBeNull();
    expect(isCurrentMembership(periods[0]!, new Date("2026-08-28"))).toBe(true);
  });

  it("pairs an entry with the exit that follows it", () => {
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({ eventType: "ENTRY", eventOn: "2015-02-01" }),
        row({ eventType: "EXIT", eventOn: "2020-01-01" }),
      ]),
    );

    expect(periods).toHaveLength(1);
    expect(periods[0]?.entry?.eventOn.toISOString().slice(0, 10)).toBe(
      "2015-02-01",
    );
    expect(periods[0]?.exit?.eventOn.toISOString().slice(0, 10)).toBe(
      "2020-01-01",
    );
  });

  it("reads a second entry while a membership is open as the same membership", () => {
    // Taking over a second apartment does not make someone a member twice, and
    // two open lines for one person would misdescribe the register.
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({ eventType: "ENTRY", eventOn: "2015-02-01" }),
        row({
          eventType: "ENTRY",
          eventOn: "2018-05-01",
          apartmentId: "apartment-1201",
        }),
      ]),
    );

    expect(periods).toHaveLength(1);
    expect(periods[0]?.entry?.eventOn.toISOString().slice(0, 10)).toBe(
      "2015-02-01",
    );
  });

  it("reads a re-joining member as two memberships", () => {
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({ eventType: "ENTRY", eventOn: "2010-01-01" }),
        row({ eventType: "EXIT", eventOn: "2014-01-01" }),
        row({ eventType: "ENTRY", eventOn: "2019-06-01" }),
      ]),
    );

    expect(periods).toHaveLength(2);
    expect(periods[1]?.exit).toBeNull();
  });

  it("still shows an exit that has no entry before it", () => {
    // An archive missing its entry row is a defect in the register, and an
    // extract that silently hides the exit would make it invisible.
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({ eventType: "EXIT", eventOn: "2020-01-01" }),
      ]),
    );

    expect(periods).toHaveLength(1);
    expect(periods[0]?.entry).toBeNull();
    expect(periods[0]?.exit).not.toBeNull();
  });

  it("keeps two people's memberships apart", () => {
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({
          personId: "person-1",
          eventType: "ENTRY",
          eventOn: "2015-02-01",
        }),
        row({
          personId: "person-2",
          eventType: "ENTRY",
          eventOn: "2016-03-01",
        }),
        row({ personId: "person-1", eventType: "EXIT", eventOn: "2020-01-01" }),
      ]),
    );

    const byPerson = new Map(
      periods.map((period) => [period.personId, period]),
    );
    expect(byPerson.get("person-1")?.exit).not.toBeNull();
    expect(byPerson.get("person-2")?.exit).toBeNull();
  });

  it("orders an entry and an exit written on the same day by when they were written", () => {
    const entry = row({ eventType: "ENTRY", eventOn: "2020-01-01" });
    const exit = row({ eventType: "EXIT", eventOn: "2020-01-01" });
    const periods = membershipPeriods(resolveRegisterEvents([exit, entry]));

    expect(periods).toHaveLength(1);
    expect(periods[0]?.entry?.id).toBe(entry.id);
    expect(periods[0]?.exit?.id).toBe(exit.id);
  });
});

describe("which row describes an ended membership", () => {
  it("takes the exit when there is one", () => {
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({ eventType: "ENTRY", eventOn: "2015-02-01" }),
        row({
          eventType: "EXIT",
          eventOn: "2020-01-01",
          recordedPostalStreet: "Nygatan 3",
        }),
      ]),
    );

    // Name and address as they stood when the membership ended, so the archive
    // stays truthful about a person who has since moved.
    expect(recordedAt(periods[0]!)?.recordedPostalStreet).toBe("Nygatan 3");
  });

  it("falls back to the entry for a current membership", () => {
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({ eventType: "ENTRY", eventOn: "2015-02-01" }),
      ]),
    );

    expect(recordedAt(periods[0]!)?.eventType).toBe("ENTRY");
  });
});

describe("whether a membership is current", () => {
  it("counts an exit dated in the future as still current", () => {
    // A scheduled exit has not happened yet, exactly as a scheduled move-out
    // does not end a residency.
    const periods = membershipPeriods(
      resolveRegisterEvents([
        row({ eventType: "ENTRY", eventOn: "2015-02-01" }),
        row({ eventType: "EXIT", eventOn: "2030-01-01" }),
      ]),
    );

    expect(isCurrentMembership(periods[0]!, new Date("2026-08-28"))).toBe(true);
  });
});
