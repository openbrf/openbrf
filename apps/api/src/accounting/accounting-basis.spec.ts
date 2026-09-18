import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCsv } from "../import/csv";
import {
  type AccountingBasis,
  ACCOUNTING_BASIS_COLUMNS,
  accountingBasisFileName,
  type AccountingBasisRow,
  totalsOf,
  writeAccountingBasis,
} from "./accounting-basis";

/**
 * The file whoever keeps the association's books reads.
 *
 * Four properties matter here and nothing else does. A protected person's
 * apartment does not reach the file, and the file says that the emptiness is
 * deliberate rather than leaving a blank cell somebody would ring the board
 * about. The fee half names nobody at all, which is what keeps this file from
 * saying of one apartment that its holders are withheld and of one person that
 * their apartment is - two rows a reader could put back together. The two
 * halves are totalled apart, because they are posted to different accounts. And
 * the header and the cells stay in step: a row is read by position once the
 * file has left this process, so a column added on one side and not the other
 * puts every value one field to the left with nothing to notice it.
 */

function feeRow(
  overrides: Partial<AccountingBasisRow> = {},
): AccountingBasisRow {
  return {
    kind: "FEE_NOTICE",
    rowId: "notice-1",
    from: "2026-01-01",
    to: "2026-03-31",
    apartment: { state: "visible", label: "Storgatan 12 1001" },
    name: null,
    amount: "10351.50",
    vatTreatment: null,
    vatRatePercent: null,
    reason: null,
    paymentReference: "260100018",
    ...overrides,
  };
}

function chargeRow(
  overrides: Partial<AccountingBasisRow> = {},
): AccountingBasisRow {
  return {
    kind: "MEMBER_CHARGE",
    rowId: "charge-1",
    from: "2026-02-14",
    to: "2026-02-14",
    apartment: { state: "visible", label: "Storgatan 12 1001" },
    name: "Astrid Vallin",
    amount: "450.00",
    vatTreatment: "EXEMPT",
    vatRatePercent: null,
    reason: "Nyckel till cykelrummet",
    paymentReference: null,
    ...overrides,
  };
}

function basis(rows: AccountingBasisRow[]): AccountingBasis {
  return {
    housingCooperative: {
      name: "Brf Talgoxen",
      organizationNumber: "769600-1234",
    },
    from: "2026-01-01",
    to: "2026-12-31",
    generatedOn: "2027-01-02",
    rows,
    ...totalsOf(rows),
  };
}

/** The written file back as cells, so the header and the rows line up by index. */
function cellsOf(written: string): string[][] {
  return parseCsv(written, ";").rows;
}

/** One row's cells by column name, which is how the contract is read. */
function cellsByColumn(written: string, index: number): Record<string, string> {
  const rows = cellsOf(written);
  const header = rows[0] ?? [];
  const values = rows[index] ?? [];
  return Object.fromEntries(
    header.map((column, position) => [column, values[position] ?? ""]),
  );
}

describe("the columns", () => {
  it("writes the header and every row in one order", () => {
    const written = writeAccountingBasis(basis([feeRow(), chargeRow()]));
    const rows = cellsOf(written);

    expect(rows[0]).toEqual([...ACCOUNTING_BASIS_COLUMNS]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toHaveLength(ACCOUNTING_BASIS_COLUMNS.length);
    }
  });

  it("says which half of the money each row came from", () => {
    const written = writeAccountingBasis(basis([feeRow(), chargeRow()]));

    expect(cellsByColumn(written, 1).kind).toBe("FEE_NOTICE");
    expect(cellsByColumn(written, 2).kind).toBe("MEMBER_CHARGE");
  });

  it("states a charge's own day as both ends of its period", () => {
    const written = writeAccountingBasis(basis([chargeRow()]));
    const cells = cellsByColumn(written, 1);

    expect(cells.periodFrom).toBe("2026-02-14");
    expect(cells.periodTo).toBe("2026-02-14");
  });

  it("carries the run's whole period on a fee row", () => {
    const written = writeAccountingBasis(basis([feeRow()]));
    const cells = cellsByColumn(written, 1);

    expect(cells.periodFrom).toBe("2026-01-01");
    expect(cells.periodTo).toBe("2026-03-31");
  });

  it("carries no total row", () => {
    // A trailing row that is not a record is what breaks a mapping written
    // against the header, so the totals stay on the shape the screen reads.
    const written = writeAccountingBasis(basis([feeRow(), chargeRow()]));

    expect(cellsOf(written)).toHaveLength(3);
  });
});

describe("what a protected person's row says", () => {
  it("leaves the apartment empty and says that it is withheld", () => {
    const written = writeAccountingBasis(
      basis([chargeRow({ apartment: { state: "withheld" } })]),
    );
    const cells = cellsByColumn(written, 1);

    expect(cells.apartment).toBe("");
    expect(cells.apartmentWithheld).toBe("protected");
    // The name is not withheld: what protection removes is the link from the
    // name to the door, and a bookkeeper who cannot be told who was charged has
    // been handed a file they cannot use.
    expect(cells.name).toBe("Astrid Vallin");
  });

  it("says nothing about withholding on a row that carries the apartment", () => {
    const written = writeAccountingBasis(basis([chargeRow()]));

    expect(cellsByColumn(written, 1).apartmentWithheld).toBe("");
  });

  it("names nobody on a fee row", () => {
    /*
     * The property this file rests on. A fee row that named its holders would
     * withhold them where one is protected, and the file would then say of one
     * apartment that its holders are withheld and of one person that their
     * apartment is - which a reader holding both rows could put back together.
     */
    const written = writeAccountingBasis(
      basis([feeRow(), chargeRow({ apartment: { state: "withheld" } })]),
    );

    expect(cellsByColumn(written, 1).name).toBe("");
    expect(cellsByColumn(written, 1).apartmentWithheld).toBe("");
    expect(cellsByColumn(written, 1).apartment).toBe("Storgatan 12 1001");
  });
});

describe("the totals", () => {
  it("adds the two halves apart and together", () => {
    const totals = totalsOf([
      feeRow({ amount: "10351.50" }),
      feeRow({ rowId: "notice-2", amount: "0.55" }),
      chargeRow({ amount: "450.00" }),
    ]);

    expect(totals.feeTotal).toBe("10352.05");
    expect(totals.chargeTotal).toBe("450.00");
    expect(totals.total).toBe("10802.05");
  });

  it("answers zero for a period with nothing in it", () => {
    expect(totalsOf([])).toEqual({
      feeTotal: "0.00",
      chargeTotal: "0.00",
      total: "0.00",
    });
  });

  it("refuses an amount a decimal column cannot hold", () => {
    // Refused rather than rounded, per `fees/fee-period.ts`: a total that had
    // silently dropped a row would be worse than no total.
    expect(() => totalsOf([feeRow({ amount: "1234.5" })])).toThrow(RangeError);
  });
});

describe("the file name", () => {
  it("carries the period, so two exports do not collide", () => {
    expect(accountingBasisFileName("2026-01-01", "2026-12-31")).toBe(
      "bokforingsunderlag-2026-01-01-2026-12-31.csv",
    );
  });
});

describe("the documented contract", () => {
  it("describes every column the file has, and no column it does not", () => {
    /*
     * The document is the contract a reader finds, and the columns are the
     * contract the code writes; a column added to one alone is the failure this
     * catches. Read out of the document rather than restated here, on
     * `registers/initial-supply-file.spec.ts`'s own reading: a column dropped
     * from the document has no row to find.
     *
     * The document names each column in the leading cell of a table row of its
     * own, which is what this matches, allowing for the padding the formatter
     * puts inside an aligned cell. The pattern requires a lower-case first
     * letter, so a table beside it whose leading cells are FEE_NOTICE and
     * MEMBER_CHARGE is not read as a column list, and prose mentioning a column
     * elsewhere in the file is not a row at all.
     */
    const document = readFileSync(
      join(process.cwd(), "..", "..", "docs", "accounting-basis-contract.md"),
      "utf8",
    );

    const documented = [...document.matchAll(/^\|\s*`([a-z][a-zA-Z]*)`\s*\|/gm)]
      .map((match) => match[1])
      .filter((column): column is string => column !== undefined);

    const alphabetical = (first: string, second: string): number =>
      first.localeCompare(second);
    expect([...documented].sort(alphabetical)).toEqual(
      [...ACCOUNTING_BASIS_COLUMNS].sort(alphabetical),
    );
  });
});
