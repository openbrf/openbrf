import { writeCsv } from "../import/csv";
import { sumAmounts } from "../fees/fee-period";

/**
 * The accounting basis (bokforingsunderlag): a period's fee notices and member
 * charges in one file, for whoever keeps the association's books.
 *
 * A module of its own, and pure, on `charges/debiting-list.ts`'s precedent: the
 * same rows are shown on screen and serialised, and the two must not be able to
 * disagree. What is new here is that the rows come from both halves of the
 * association's money, which is why this module is neither the fees module's
 * nor the charges module's - it is the one place allowed to know both
 * vocabularies, and it keeps them apart by saying on every row which of the two
 * it came from.
 *
 * ## A documented file rather than an accounting format
 *
 * There is no SIE file here and none is planned. `docs/accounting-basis-contract.md`
 * states the columns, the record of what an SIE 4I transactions file would have
 * cost, and why a mapped CSV was taken instead. The file is the debiting list's
 * own dialect, written by the repository's one CSV writer.
 *
 * ## Open BRF holds the basis and not the ledger
 *
 * No account numbers, no verification series, no debit and credit, no balance.
 * The platform holds no chart of accounts and cannot invent one: which numbers
 * an association posts to is its own bookkeeper's question. What this file
 * carries is what was billed and what was charged, and the posting is the
 * bookkeeper's own act.
 *
 * Nothing here says whether anything was paid, on the rule both source modules
 * already state: the accounting system settles the debt, and a second answer to
 * whether something has been paid is worse than none.
 *
 * ## The fee half names no person
 *
 * A fee row carries the apartment and no name at all. The apartment is the
 * party a fee is fixed on under BRL 9 kap. 13 §, who holds it is on the notice
 * document, and the omission is what keeps one masking rule in this file rather
 * than two opposite ones.
 *
 * That is the point worth stating plainly. The debiting list withholds a
 * protected person's apartment and prints their name; the notice document
 * withholds the holders' names and prints the apartment. A file carrying both
 * would say of one apartment that its holders are withheld and of one person
 * that their apartment is withheld, and a reader holding both rows could put
 * the name back against the door - which is the one thing protection exists to
 * prevent. So this file withholds in one direction only: a protected person's
 * apartment, on the charge row that names them.
 */

/** Which half of the association's money a row came from. */
export type AccountingBasisRowKind = "FEE_NOTICE" | "MEMBER_CHARGE";

/** The apartment on a row, or the statement that it is withheld. */
export type AccountingBasisApartment =
  | {
      state: "visible";
      /** "<street> <number> <apartment number>", or null where none is held. */
      label: string | null;
    }
  | { state: "withheld" };

export interface AccountingBasisRow {
  kind: AccountingBasisRowKind;
  /** The notice's or the charge's own id, which is what a screen keys on. */
  rowId: string;
  /**
   * The period the row covers, inclusive at both ends. "YYYY-MM-DD".
   *
   * A charge falls on one day and states it as both ends, so every row answers
   * the same question in the same two columns. A notice covers its whole run,
   * which is why the two columns exist at all: the amount is for the period and
   * this product will not apportion one.
   */
  from: string;
  to: string;
  apartment: AccountingBasisApartment;
  /** The person charged. Null on a fee row and on a charge on an apartment. */
  name: string | null;
  /** Kronor, as the decimal column holds it: "3450.50". */
  amount: string;
  /** Null on a fee row, where the notice holds no treatment of its own. */
  vatTreatment: "EXEMPT" | "RATE" | null;
  /** Whole percent, and set exactly when the treatment is RATE. */
  vatRatePercent: number | null;
  /** The board's own words for what is being charged. Null on a fee row. */
  reason: string | null;
  /** The reference the payment of the notice is made under. Null on a charge row. */
  paymentReference: string | null;
}

export interface AccountingBasis {
  housingCooperative: { name: string; organizationNumber: string | null };
  /** The period asked for, inclusive at both ends. "YYYY-MM-DD". */
  from: string;
  to: string;
  /** The day the basis was produced, for the document stamp. */
  generatedOn: string;
  rows: AccountingBasisRow[];
  /**
   * The three sums, as decimal strings.
   *
   * Three rather than one because the two halves are posted to different
   * accounts, and reading the split off the file by hand is the first thing a
   * bookkeeper would otherwise do. Sums of what was billed and charged, never
   * balances: nothing here has been reduced by a payment.
   */
  feeTotal: string;
  chargeTotal: string;
  total: string;
}

/**
 * The columns of the file, in file order.
 *
 * English, like every identifier in this repository and like the debiting
 * list's and the notice document's own columns. The file is read by whoever
 * keeps the association's books, either by eye or by a mapping into their
 * system, and a header row is the part of it a mapping is written against - so
 * it is stable and documented rather than translated.
 * `docs/accounting-basis-contract.md` is the contract, and a spec beside this
 * file asserts that the document names exactly these columns and no others.
 *
 * `kind` says which half of the money the row came from, so a reader does not
 * have to infer it from which of the later columns are empty. `apartmentWithheld`
 * is what tells the reader that an empty `apartment` cell is deliberate rather
 * than a gap, on the debiting list's own argument: somebody reading a blank cell
 * would otherwise ring the board about a file they would be told is correct.
 */
export const ACCOUNTING_BASIS_COLUMNS = [
  "kind",
  "periodFrom",
  "periodTo",
  "apartment",
  "apartmentWithheld",
  "name",
  "amount",
  "vatTreatment",
  "vatRatePercent",
  "reason",
  "paymentReference",
] as const;

/** The name the file is offered under. The period, so two exports do not collide. */
export function accountingBasisFileName(from: string, to: string): string {
  return `bokforingsunderlag-${from}-${to}.csv`;
}

/**
 * The three totals, from the rows themselves.
 *
 * Here rather than at the call site so that the screen, the file and the
 * service cannot each arrive at a different figure. Summed in ore as integers
 * by `fees/fee-period.ts`, which is the arithmetic both source documents
 * already state: a few hundred amounts added in binary floating point produce a
 * total ending in a cent that is not there, and an amount that is not what a
 * `DECIMAL(14, 2)` renders is refused rather than rounded.
 */
export function totalsOf(rows: readonly AccountingBasisRow[]): {
  feeTotal: string;
  chargeTotal: string;
  total: string;
} {
  const amountsOf = (kind: AccountingBasisRowKind): string[] =>
    rows.filter((row) => row.kind === kind).map((row) => row.amount);

  return {
    feeTotal: sumAmounts(amountsOf("FEE_NOTICE")),
    chargeTotal: sumAmounts(amountsOf("MEMBER_CHARGE")),
    total: sumAmounts(rows.map((row) => row.amount)),
  };
}

/**
 * Serialises the basis.
 *
 * Through `writeCsv`, which is the repository's one CSV writer: semicolons and
 * a byte order mark, because the file is opened in the spreadsheet whoever
 * keeps the books already has and Excel reads an unmarked UTF-8 file as the
 * local code page. That is the same reason the debiting list, the notice
 * document and the register supply file go out that way, and one writer means
 * all four are the same dialect.
 *
 * Every row is emitted in `ACCOUNTING_BASIS_COLUMNS` order, so a column added
 * to that list appears in the file and in the header together. A row is read by
 * position once it has left this process, and a header that disagreed with the
 * order of the cells beneath it would put every value one field to the left.
 *
 * No total row. The totals are on the shape the screen reads and never in the
 * file: a trailing row that is not a record is what breaks a mapping written
 * against the header, and a bookkeeper importing this file would have to strip
 * it before every read.
 */
export function writeAccountingBasis(basis: AccountingBasis): string {
  return writeCsv([
    [...ACCOUNTING_BASIS_COLUMNS],
    ...basis.rows.map((row) => [
      row.kind,
      row.from,
      row.to,
      row.apartment.state === "visible" ? (row.apartment.label ?? "") : "",
      // Stated as a word rather than left to the empty cell beside it, per the
      // column list's comment.
      row.apartment.state === "withheld" ? "protected" : "",
      row.name ?? "",
      row.amount,
      row.vatTreatment ?? "",
      row.vatRatePercent === null ? "" : String(row.vatRatePercent),
      row.reason ?? "",
      row.paymentReference ?? "",
    ]),
  ]);
}
