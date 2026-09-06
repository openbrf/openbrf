import { describe, expect, it } from "vitest";

import { activeBoardRecipientsWhere } from "./board-recipients";

const NOW = new Date("2026-09-06T08:00:00.000Z");

describe("activeBoardRecipientsWhere", () => {
  it("asks for a seat that has not ended or ends in the future", () => {
    /*
     * The second half is the one worth pinning. A board can minute in April
     * that a term runs to the annual meeting, and that person is on the board
     * until the date arrives - a clause testing only for a null end date would
     * drop them from every reminder in the meantime.
     */
    expect(activeBoardRecipientsWhere(NOW)).toEqual({
      boardPositions: {
        some: { OR: [{ endedOn: null }, { endedOn: { gt: NOW } }] },
      },
      emailCipher: { not: null },
    });
  });

  it("requires an address, because the list is for mail", () => {
    const where = activeBoardRecipientsWhere(NOW);

    expect(where.emailCipher).toEqual({ not: null });
  });

  it("moves the comparison with the clock it is given", () => {
    const later = new Date("2027-01-01T00:00:00.000Z");

    const where = activeBoardRecipientsWhere(later);
    const positions = where.boardPositions as {
      some: { OR: Array<{ endedOn: unknown }> };
    };

    expect(positions.some.OR[1]?.endedOn).toEqual({ gt: later });
  });
});
