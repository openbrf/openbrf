import { describe, expect, it } from "vitest";

import { boardSeatHeldOn } from "../registers/held-on";
import {
  activeBoardRecipientsWhere,
  activeBoardSeatWhere,
} from "./board-recipients";

/** 00:30 on the 22nd of June in Stockholm, and still the 21st in UTC. */
const NOW = new Date("2026-06-21T22:30:00.000Z");
const TODAY = { year: 2026, month: 6, day: 22 };

describe("activeBoardSeatWhere", () => {
  it("asks for a seat held today and says nothing about an address", () => {
    /*
     * The absence is the whole point of the helper existing separately. A
     * membership question that picked up the recipient list's address condition
     * would drop a board member the association holds no address for out of a
     * room they hold a seat in.
     */
    expect(activeBoardSeatWhere(NOW)).toEqual({
      boardPositions: { some: boardSeatHeldOn(TODAY) },
    });
  });

  it("reads today on the association's calendar", () => {
    // Half past midnight here is the 22nd, so a seat elected on the 22nd is
    // held and one ending on the 22nd is not. The UTC day would say the 21st.
    const positions = activeBoardSeatWhere(NOW).boardPositions as {
      some: {
        electedOn: unknown;
        OR: Array<{ endedOn: unknown }>;
      };
    };

    expect(positions.some.electedOn).toEqual({
      lte: new Date("2026-06-22T00:00:00.000Z"),
    });
    expect(positions.some.OR[1]?.endedOn).toEqual({
      gt: new Date("2026-06-22T00:00:00.000Z"),
    });
  });
});

describe("activeBoardRecipientsWhere", () => {
  it("is the seat clause with an address added to it", () => {
    // Asserted against the helper rather than against a second copy of the
    // clause, so the two cannot drift apart on the part they share.
    expect(activeBoardRecipientsWhere(NOW)).toMatchObject(
      activeBoardSeatWhere(NOW),
    );
  });

  it("asks for a seat held today, with an address", () => {
    /*
     * A seat whose end date is in the future is held until the date arrives,
     * and one whose election date is in the future is not held until that date
     * arrives - a board can minute either ahead of time.
     */
    expect(activeBoardRecipientsWhere(NOW)).toEqual({
      boardPositions: { some: boardSeatHeldOn(TODAY) },
      emailCipher: { not: null },
    });
  });

  it("requires an address, because the list is for mail", () => {
    const where = activeBoardRecipientsWhere(NOW);

    expect(where.emailCipher).toEqual({ not: null });
  });

  it("moves the day with the clock it is given", () => {
    const later = new Date("2027-01-01T12:00:00.000Z");

    const where = activeBoardRecipientsWhere(later);

    expect(where.boardPositions).toEqual({
      some: boardSeatHeldOn({ year: 2027, month: 1, day: 1 }),
    });
  });
});
