import { describe, expect, it } from "vitest";

import type { ResolvedRegisterEvent } from "../registers/membership-periods";
import {
  type DatedLienNote,
  type DatedTermination,
  holdingPeriods,
  lienNotesDuringHolding,
  terminationsDuringHolding,
} from "./holding-periods";

/**
 * The rule that decides whose pledge appears on a data subject access report.
 *
 * Exercised without a database because the question is a pure one and because
 * getting it wrong in the permissive direction puts a third party's finances on
 * a document the association hands to somebody else - GDPR art. 15(4). The
 * transfer-day cases below are the ones that matter: a pledge redeemed as a
 * sale completes and a pledge taken out as one completes both fall on a day two
 * people can claim.
 */

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

function event(input: {
  eventType: "ENTRY" | "EXIT";
  eventOn: string;
  apartmentId?: string | null;
  createdAt?: string;
}): ResolvedRegisterEvent {
  return {
    id: `${input.eventType}-${input.eventOn}`,
    personId: "person-1",
    apartmentId:
      input.apartmentId === undefined ? "apartment-1" : input.apartmentId,
    eventType: input.eventType,
    eventOn: day(input.eventOn),
    recordedFirstName: "Siv",
    recordedLastName: "Utdrag",
    recordedPostalStreet: null,
    recordedPostalCode: null,
    recordedPostalCity: null,
    correctsEntryId: null,
    createdAt: day(input.createdAt ?? input.eventOn),
    corrected: false,
  };
}

function note(input: {
  notedOn: string;
  releasedOn?: string;
  apartmentId?: string;
}): DatedLienNote {
  return {
    apartmentId: input.apartmentId ?? "apartment-1",
    notedOn: day(input.notedOn),
    releasedOn: input.releasedOn === undefined ? null : day(input.releasedOn),
  };
}

function ceased(input: {
  tookEffectOn: string;
  apartmentId?: string;
}): DatedTermination {
  return {
    apartmentId: input.apartmentId ?? "apartment-1",
    tookEffectOn: day(input.tookEffectOn),
  };
}

describe("holdingPeriods", () => {
  it("pairs an entry with the exit on the same apartment", () => {
    const periods = holdingPeriods([
      event({ eventType: "ENTRY", eventOn: "2015-03-01" }),
      event({ eventType: "EXIT", eventOn: "2020-06-30" }),
    ]);

    expect(periods).toEqual([
      {
        apartmentId: "apartment-1",
        from: day("2015-03-01"),
        until: day("2020-06-30"),
      },
    ]);
  });

  it("keeps a holding open when there is no exit", () => {
    const [period] = holdingPeriods([
      event({ eventType: "ENTRY", eventOn: "2015-03-01" }),
    ]);

    expect(period?.until).toBeNull();
  });

  it("pairs each apartment separately for somebody holding two", () => {
    // membershipPeriods would drop the second entry, because taking a second
    // apartment does not make somebody a member twice. Here it is the point.
    const periods = holdingPeriods([
      event({ eventType: "ENTRY", eventOn: "2015-03-01" }),
      event({
        eventType: "ENTRY",
        eventOn: "2017-01-01",
        apartmentId: "apartment-2",
      }),
    ]);

    expect(periods).toHaveLength(2);
    expect(periods.map((period) => period.apartmentId).sort()).toEqual([
      "apartment-1",
      "apartment-2",
    ]);
  });

  it("drops an event with no apartment", () => {
    expect(
      holdingPeriods([
        event({ eventType: "ENTRY", eventOn: "2015-03-01", apartmentId: null }),
      ]),
    ).toEqual([]);
  });

  it("drops an exit with no entry, rather than leaving the start unbounded", () => {
    // The register extract shows such a row on purpose. Here it would mean
    // every note before the exit qualifies, the previous holder's included.
    expect(
      holdingPeriods([event({ eventType: "EXIT", eventOn: "2020-06-30" })]),
    ).toEqual([]);
  });

  it("treats a second entry on an apartment already held as the same holding", () => {
    const periods = holdingPeriods([
      event({ eventType: "ENTRY", eventOn: "2015-03-01" }),
      event({ eventType: "ENTRY", eventOn: "2016-01-01" }),
      event({ eventType: "EXIT", eventOn: "2020-06-30" }),
    ]);

    expect(periods).toEqual([
      {
        apartmentId: "apartment-1",
        from: day("2015-03-01"),
        until: day("2020-06-30"),
      },
    ]);
  });
});

describe("lienNotesDuringHolding", () => {
  const periods = holdingPeriods([
    event({ eventType: "ENTRY", eventOn: "2015-03-01" }),
    event({ eventType: "EXIT", eventOn: "2020-06-30" }),
  ]);

  const selected = (notes: DatedLienNote[]): string[] =>
    lienNotesDuringHolding(notes, periods).map((found) =>
      found.notedOn.toISOString().slice(0, 10),
    );

  it("includes a note taken out and released inside the holding", () => {
    expect(
      selected([note({ notedOn: "2016-05-01", releasedOn: "2018-09-01" })]),
    ).toEqual(["2016-05-01"]);
  });

  it("includes a note still open at the end of the holding", () => {
    expect(selected([note({ notedOn: "2016-05-01" })])).toEqual(["2016-05-01"]);
  });

  it("includes a note that predates the holding but survived the transfer", () => {
    // A pledge that outlived the sale encumbered the tenant-ownership this
    // person then owned, whoever first recorded it.
    expect(
      selected([note({ notedOn: "2011-01-01", releasedOn: "2016-04-01" })]),
    ).toEqual(["2011-01-01"]);
  });

  it("excludes the previous holder's pledge, redeemed on the day the holding began", () => {
    // The ordinary shape of a completed transfer, and the case art. 15(4) is
    // about: the creditor on it belongs to somebody else's report.
    expect(
      selected([note({ notedOn: "2011-01-01", releasedOn: "2015-03-01" })]),
    ).toEqual([]);
  });

  it("excludes a pledge fully released before the holding began", () => {
    expect(
      selected([note({ notedOn: "2011-01-01", releasedOn: "2013-01-01" })]),
    ).toEqual([]);
  });

  it("excludes the next holder's pledge, recorded on the day the holding ended", () => {
    expect(selected([note({ notedOn: "2020-06-30" })])).toEqual([]);
  });

  it("excludes a pledge recorded after the holding ended", () => {
    expect(selected([note({ notedOn: "2021-01-01" })])).toEqual([]);
  });

  it("excludes a note on an apartment this person never held", () => {
    expect(
      selected([note({ notedOn: "2016-05-01", apartmentId: "apartment-9" })]),
    ).toEqual([]);
  });

  it("includes a note open today when the holding has not ended", () => {
    const open = holdingPeriods([
      event({ eventType: "ENTRY", eventOn: "2015-03-01" }),
    ]);
    expect(
      lienNotesDuringHolding([note({ notedOn: "2024-01-01" })], open),
    ).toHaveLength(1);
  });

  it("reports nothing when the person held nothing", () => {
    expect(
      lienNotesDuringHolding([note({ notedOn: "2016-05-01" })], []),
    ).toEqual([]);
  });
});

/**
 * The mirror rule, and it points the other way.
 *
 * A lien note is dropped on either boundary day because it would be a third
 * party's financial position. A termination is kept on both, and the reason the
 * closing boundary matters is that the termination is normally what ended the
 * holding: the half-open rule would drop the event from the report of exactly
 * the person it happened to.
 */
describe("terminationsDuringHolding", () => {
  const periods = holdingPeriods([
    event({ eventType: "ENTRY", eventOn: "2015-03-01" }),
    event({ eventType: "EXIT", eventOn: "2020-06-30" }),
  ]);

  const selected = (terminations: DatedTermination[]): string[] =>
    terminationsDuringHolding(terminations, periods).map((found) =>
      found.tookEffectOn.toISOString().slice(0, 10),
    );

  it("includes a termination inside the holding", () => {
    expect(selected([ceased({ tookEffectOn: "2018-09-01" })])).toEqual([
      "2018-09-01",
    ]);
  });

  it("includes a termination on the day the holding ended, which is the usual case", () => {
    // A tenant-ownership that has ceased cannot go on being held, so the exit
    // and the termination land on one day. This is the assertion the lien rule
    // would have failed.
    expect(selected([ceased({ tookEffectOn: "2020-06-30" })])).toEqual([
      "2020-06-30",
    ]);
  });

  it("includes a termination on the day the holding began", () => {
    // BRL 7 kap. 33 § ends every tenant-ownership in a disposed building at
    // once, however recently somebody took the apartment.
    expect(selected([ceased({ tookEffectOn: "2015-03-01" })])).toEqual([
      "2015-03-01",
    ]);
  });

  it("excludes a termination before the holding began", () => {
    expect(selected([ceased({ tookEffectOn: "2015-02-28" })])).toEqual([]);
  });

  it("excludes a termination after the holding ended", () => {
    expect(selected([ceased({ tookEffectOn: "2020-07-01" })])).toEqual([]);
  });

  it("excludes a termination on an apartment this person never held", () => {
    expect(
      selected([
        ceased({ tookEffectOn: "2018-09-01", apartmentId: "apartment-9" }),
      ]),
    ).toEqual([]);
  });

  it("includes a termination on an open holding", () => {
    const open = holdingPeriods([
      event({ eventType: "ENTRY", eventOn: "2015-03-01" }),
    ]);
    expect(
      terminationsDuringHolding([ceased({ tookEffectOn: "2026-01-15" })], open),
    ).toHaveLength(1);
  });

  it("reports nothing when the person held nothing", () => {
    expect(
      terminationsDuringHolding([ceased({ tookEffectOn: "2018-09-01" })], []),
    ).toEqual([]);
  });
});
