import { describe, expect, it } from "vitest";

import { parseCsv } from "../import/csv";
import {
  type DebitingList,
  DEBITING_LIST_COLUMNS,
  debitingListFileName,
  type DebitingListRow,
  sumChargeAmounts,
  writeDebitingList,
} from "./debiting-list";

/**
 * The file the board hands to whoever keeps its books.
 *
 * Two properties matter here and nothing else does. The first is that a
 * protected person's apartment does not reach the file: this is the one artefact
 * the module produces that leaves the association, and the register extracts'
 * masking rule is what it has to hold. The second is that the header and the
 * cells stay in step - a row is read by position once the file has left this
 * process, so a column added on one side and not the other puts every value one
 * field to the left with nothing to notice it.
 */

function row(overrides: Partial<DebitingListRow> = {}): DebitingListRow {
  return {
    chargeId: "charge-1",
    chargedOn: "2026-03-05",
    chargedTo: {
      kind: "person",
      personId: "person-1",
      name: "Astrid Vallin",
      protectedPersonalData: false,
      apartment: { state: "visible", label: "Storgatan 12 1001" },
    },
    amount: "450.00",
    vatTreatment: "EXEMPT",
    vatRatePercent: null,
    reason: "Nyckel till cykelrummet",
    handedToManagerOn: null,
    ...overrides,
  };
}

function list(rows: DebitingListRow[]): DebitingList {
  return {
    housingCooperative: { name: "Brf Eksemplet", organizationNumber: null },
    from: "2026-01-01",
    to: "2026-12-31",
    generatedOn: "2027-01-08",
    rows,
    total: sumChargeAmounts(rows.map((entry) => entry.amount)),
  };
}

/** The file's rows as cells, header included. */
function cellsOf(written: string): string[][] {
  return parseCsv(written, ";").rows;
}

describe("writeDebitingList", () => {
  it("writes the header and the cells in one order", () => {
    const cells = cellsOf(writeDebitingList(list([row()])));

    expect(cells[0]).toEqual([...DEBITING_LIST_COLUMNS]);
    expect(cells[1]).toEqual([
      "2026-03-05",
      "person",
      "Astrid Vallin",
      "Storgatan 12 1001",
      "",
      "450.00",
      "EXEMPT",
      "",
      "Nyckel till cykelrummet",
      "",
    ]);
  });

  it("withholds a protected person's apartment and says that it did", () => {
    /*
     * The rule the member register extract holds, on the document that leaves
     * the association. The name stays - a bookkeeper who cannot be told who to
     * invoice has been handed a list they cannot use - and the link from the
     * name to the door does not.
     *
     * The word in the next column is what makes the empty cell readable: a blank
     * one on its own is indistinguishable from a household the register has no
     * apartment for.
     */
    const cells = cellsOf(
      writeDebitingList(
        list([
          row({
            chargedTo: {
              kind: "person",
              personId: "person-2",
              name: "Signe Skyddad",
              protectedPersonalData: true,
              apartment: { state: "masked" },
            },
          }),
        ]),
      ),
    );

    expect(cells[1]?.[2]).toBe("Signe Skyddad");
    expect(cells[1]?.[3]).toBe("");
    expect(cells[1]?.[4]).toBe("protected");
    expect(
      writeDebitingList(
        list([
          row({
            chargedTo: {
              kind: "person",
              personId: "person-2",
              name: "Signe Skyddad",
              protectedPersonalData: true,
              apartment: { state: "masked" },
            },
          }),
        ]),
      ),
    ).not.toContain("Storgatan");
  });

  it("names the flat on a charge put on the apartment itself", () => {
    // Not masked, and there is nobody to mask: the apartment is the charged
    // party and the row says nothing about who is behind the door.
    const cells = cellsOf(
      writeDebitingList(
        list([
          row({
            chargedTo: {
              kind: "apartment",
              apartmentId: "apartment-1",
              apartment: { state: "visible", label: "Storgatan 12 1002" },
            },
          }),
        ]),
      ),
    );

    expect(cells[1]?.[1]).toBe("apartment");
    expect(cells[1]?.[2]).toBe("");
    expect(cells[1]?.[3]).toBe("Storgatan 12 1002");
    expect(cells[1]?.[4]).toBe("");
  });

  it("carries the VAT rate only where the treatment has one", () => {
    const cells = cellsOf(
      writeDebitingList(
        list([row({ vatTreatment: "RATE", vatRatePercent: 25 })]),
      ),
    );

    expect(cells[1]?.[6]).toBe("RATE");
    expect(cells[1]?.[7]).toBe("25");
  });

  it("survives a reason carrying the delimiter", () => {
    // Swedish Excel writes semicolons, so a reason containing one is the case
    // that would silently split a row into two columns without the writer's
    // quoting.
    const cells = cellsOf(
      writeDebitingList(list([row({ reason: "Reparation; vidaredebiterad" })])),
    );

    expect(cells[1]).toHaveLength(DEBITING_LIST_COLUMNS.length);
    expect(cells[1]?.[8]).toBe("Reparation; vidaredebiterad");
  });
});

describe("sumChargeAmounts", () => {
  it("adds in ore rather than in binary floating point", () => {
    // 0.1 + 0.2 is the case: added as numbers these three come to 4712.999...
    // and the bookkeeper reconciles against a figure one ore short.
    expect(sumChargeAmounts(["1570.10", "1570.20", "1572.70"])).toBe("4713.00");
  });

  it("answers zero for an empty period", () => {
    expect(sumChargeAmounts([])).toBe("0.00");
  });

  it("refuses a value the column could not hold", () => {
    expect(() => sumChargeAmounts(["450"])).toThrow(RangeError);
    expect(() => sumChargeAmounts(["450,00"])).toThrow(RangeError);
  });
});

describe("debitingListFileName", () => {
  it("names the period, so two exports do not collide", () => {
    expect(debitingListFileName("2026-01-01", "2026-12-31")).toBe(
      "debiteringslangd-2026-01-01-2026-12-31.csv",
    );
  });
});
