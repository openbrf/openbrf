import { describe, expect, it } from "vitest";

import { parseCsv } from "../import/csv";
import {
  type FeeNoticeDocument,
  FEE_NOTICE_COLUMNS,
  feeNoticeListFileName,
  type FeeNoticeRow,
  totalOf,
  writeFeeNoticeList,
} from "./fee-notice";

/**
 * The document the board takes away.
 *
 * Three properties matter here and nothing else does. A protected holder's name
 * does not reach the file, and the file says that the emptiness is deliberate.
 * The apartment always does, because it is the party the fee is fixed on and a
 * notice that could not say which flat it was for would not be a notice. And the
 * header and the cells stay in step - a row is read by position once the file has
 * left this process, so a column added on one side and not the other puts every
 * value one field to the left with nothing to notice it.
 */

function row(overrides: Partial<FeeNoticeRow> = {}): FeeNoticeRow {
  return {
    noticeId: "notice-1",
    apartment: "Storgatan 12 1001",
    apartmentNumber: "1001",
    holders: { state: "visible", names: ["Astrid Vallin"] },
    amount: "3450.50",
    paymentReference: "260100018",
    ...overrides,
  };
}

/** The written file back as cells, so the header and the rows line up by index. */
function cellsOf(written: string): string[][] {
  return parseCsv(written, ";").rows;
}

function document(rows: FeeNoticeRow[]): FeeNoticeDocument {
  return {
    housingCooperative: {
      name: "Brf Talgoxen",
      organizationNumber: "769600-1234",
      bankgiro: "123-4567",
      plusgiro: null,
    },
    notificationId: "run-1",
    from: "2026-01-01",
    to: "2026-03-31",
    dueOn: "2026-01-31",
    issuedOn: "2026-01-02",
    generatedOn: "2026-01-02",
    rows,
    total: totalOf(rows),
  };
}

describe("writeFeeNoticeList", () => {
  it("writes the header and the cells in one order", () => {
    const cells = cellsOf(writeFeeNoticeList(document([row()])));

    expect(cells[0]).toEqual([...FEE_NOTICE_COLUMNS]);
    expect(cells[1]).toEqual([
      "Storgatan 12 1001",
      "1001",
      "Astrid Vallin",
      "",
      "3450.50",
      "260100018",
      "2026-01-31",
    ]);
  });

  it("withholds a protected holder's name and says that it did", () => {
    /*
     * The other end of the debiting list's rule. There the person is the charged
     * party and their apartment is withheld; here the apartment is the party and
     * cannot be, so it is the name that goes. What protection withholds either
     * way is the link between a name and a door.
     */
    const csv = writeFeeNoticeList(
      document([row({ holders: { state: "withheld" } })]),
    );
    expect(csv).not.toContain("Astrid Vallin");
    expect(csv).toContain("protected");
    // And the flat is still on the row, because withholding it would empty the
    // notice of the thing it is about.
    expect(csv).toContain("Storgatan 12 1001");
  });

  it("names every holder of a household", () => {
    const csv = writeFeeNoticeList(
      document([
        row({
          holders: {
            state: "visible",
            names: ["Astrid Vallin", "Nils Vallin"],
          },
        }),
      ]),
    );
    expect(csv).toContain("Astrid Vallin, Nils Vallin");
  });

  it("carries the due date on every row", () => {
    // A row read out of the file into another system has to carry the date the
    // money is due with it, so it is a column rather than a heading.
    const cells = cellsOf(
      writeFeeNoticeList(document([row(), row({ noticeId: "notice-2" })])),
    );

    for (const written of cells.slice(1)) {
      expect(written.at(-1)).toBe("2026-01-31");
    }
  });

  it("carries no payment, balance or status of any kind", () => {
    // The rule the charges module states three times, held here. Asserted over
    // the column list rather than over one file, so a column added later is
    // caught whatever a row happens to hold.
    for (const column of FEE_NOTICE_COLUMNS) {
      expect(column.toLowerCase()).not.toContain("paid");
      expect(column.toLowerCase()).not.toContain("balance");
      expect(column.toLowerCase()).not.toContain("status");
      expect(column.toLowerCase()).not.toContain("outstanding");
    }
  });
});

describe("totalOf", () => {
  it("adds the rows in ore", () => {
    expect(
      totalOf([
        row({ amount: "3450.50" }),
        row({ noticeId: "notice-2", amount: "1200.25" }),
        row({ noticeId: "notice-3", amount: "899.25" }),
      ]),
    ).toBe("5550.00");
  });

  it("is zero over an empty period", () => {
    expect(totalOf([])).toBe("0.00");
  });
});

describe("feeNoticeListFileName", () => {
  it("names the period, so two exports do not collide", () => {
    expect(feeNoticeListFileName("2026-01-01", "2026-03-31")).toBe(
      "avier-2026-01-01-2026-03-31.csv",
    );
  });
});
