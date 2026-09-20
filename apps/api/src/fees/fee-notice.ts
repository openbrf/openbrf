import { writeCsv } from "../import/csv";
import { sumAmounts } from "./fee-period";

/**
 * The fee notices for one period, as the board reads them and as the file it
 * takes away states them (avier).
 *
 * A module of its own, and pure, on `charges/debiting-list.ts`'s precedent: the
 * same rows are printed and serialised and the two must not be able to
 * disagree. The screen prints what this shape says and {@link writeFeeNoticeList}
 * writes what this shape says, so a column withheld from one is withheld from
 * the other by construction rather than by two people remembering.
 *
 * ## Produced, not sent
 *
 * Open BRF makes the document and the board takes it away. Nothing here emails
 * anybody, and there is no delivery state on a row to say whether anything went
 * out - sending is its own act and lands later. What is recorded is the run and
 * its rows, which is what lets the board say afterwards what it billed.
 *
 * ## Masking, from the other end than the debiting list
 *
 * The debiting list names a person and withholds a protected person's
 * apartment, because there the person is the charged party and the apartment is
 * the detail. A notice is the other shape: the arsavgift is owed for the
 * bostadsratt (BRL 7 kap. 14 §) and how it falls between the apartments is the
 * stadgar's question (BRL 9 kap. 5 § forsta stycket 5), so the apartment is the
 * party and withholding it would empty the row. What protection exists to
 * withhold is the link between a name and a door, so on this document it is the
 * name that goes.
 *
 * The row says so rather than leaving the cell blank, for the reason the
 * debiting list's own comment gives: somebody reading a blank cell would
 * otherwise ring the board about a document they would be told is correct. The
 * association's own apartment numbers are on every document it produces, and a
 * notice that could not say which flat it was for would not be a notice.
 *
 * ## No payment, anywhere in this shape
 *
 * There is no paid column, no outstanding column and no status. The accounting
 * system settles the debt; this document says what was billed and when the
 * board stated it was due, and nothing about what happened afterwards.
 *
 * ## What it is not
 *
 * Not a faktura. An arsavgift is exempt under mervardesskattelagen (2023:200)
 * 10 kap. 35 §, and a supply to a private member engages no faktura duty in the
 * first place. The document is built to bokforingslagen (1999:1078) 5 kap. 7 §'s
 * field list - when it was compiled, when the affarshandelse occurred, what it
 * concerns, the amount, the motpart and an identifying reference - and a line
 * that is taxable under 10 kap. 36 § does need a faktura, which this is not and
 * `docs/fee-notice-contract.md` says plainly rather than pretending.
 */

/** Who holds the apartment, or the statement that the holders are withheld. */
export type FeeNoticeHolders =
  | {
      state: "visible";
      /** The holders' names, in the register's own order. */
      names: string[];
    }
  | { state: "withheld" };

export interface FeeNoticeRow {
  noticeId: string;
  /** "<street> <number> <apartment number>". Never withheld: it is the party. */
  apartment: string;
  /** The apartment's own number, which is what a board sorts and searches by. */
  apartmentNumber: string;
  holders: FeeNoticeHolders;
  /** Kronor, as the decimal column holds it: "3450.50". */
  amount: string;
  /** The reference this notice is paid under. */
  paymentReference: string;
}

export interface FeeNoticeDocument {
  housingCooperative: {
    name: string;
    organizationNumber: string | null;
    /**
     * Where the money goes. Both, because an association may hold either or
     * both, and a notice that named neither would leave the member to ring and
     * ask.
     */
    bankgiro: string | null;
    plusgiro: string | null;
  };
  notificationId: string;
  /** The period billed, inclusive at both ends. "YYYY-MM-DD". */
  from: string;
  to: string;
  /** The day the board stated the money is due. Nothing computes from it. */
  dueOn: string;
  /** The day the run was made. */
  issuedOn: string;
  /** The day the document was produced, for the stamp. */
  generatedOn: string;
  rows: FeeNoticeRow[];
  /**
   * The sum of the rows' amounts, as a decimal string.
   *
   * Stated because it is the first thing the board checks the document
   * against, and computing it on the screen and again in the file would be two
   * chances to get it wrong. It is a sum of what was billed and never a
   * balance: nothing here has been reduced by a payment.
   */
  total: string;
}

/**
 * The columns of the file, in file order.
 *
 * English, like every identifier in this repository and like the debiting
 * list's own columns. The file is read by the board and by whoever keeps the
 * association's books, either by eye or by a mapping into their system, and a
 * header row is the part of it a mapping is written against - so it is stable
 * and documented rather than translated. `docs/fee-notice-contract.md` is the
 * contract.
 *
 * `holdersWithheld` is what tells the reader that an empty `holders` cell is
 * deliberate rather than a gap, on the debiting list's own argument.
 */
export const FEE_NOTICE_COLUMNS = [
  "apartment",
  "apartmentNumber",
  "holders",
  "holdersWithheld",
  "amount",
  "paymentReference",
  "dueOn",
] as const;

/** The name the file is offered under. The period, so two exports do not collide. */
export function feeNoticeListFileName(from: string, to: string): string {
  return `avier-${from}-${to}.csv`;
}

/**
 * The document's total, from its own rows.
 *
 * Here rather than at the call site so that the screen, the file and the
 * service cannot each arrive at a different figure. Summed in ore as integers,
 * per `fee-period.ts`.
 */
export function totalOf(rows: readonly FeeNoticeRow[]): string {
  return sumAmounts(rows.map((row) => row.amount));
}

/**
 * Serialises the document.
 *
 * Through `writeCsv`, which is the repository's one CSV writer: semicolons and
 * a byte order mark, because the file is opened in the spreadsheet the board
 * already has and Excel reads an unmarked UTF-8 file as the local code page.
 * That is the same reason the debiting list and the register supply file go out
 * that way, and one writer means all three are the same dialect.
 *
 * Every row is emitted in `FEE_NOTICE_COLUMNS` order, so a column added to that
 * list appears in the file and in the header together. A row is read by
 * position once it has left this process, and a header that disagreed with the
 * order of the cells beneath it would put every value one field to the left.
 */
export function writeFeeNoticeList(document: FeeNoticeDocument): string {
  return writeCsv([
    [...FEE_NOTICE_COLUMNS],
    ...document.rows.map((row) => [
      row.apartment,
      row.apartmentNumber,
      row.holders.state === "visible" ? row.holders.names.join(", ") : "",
      // Stated as a word rather than left to the empty cell beside it, per the
      // column list's comment.
      row.holders.state === "withheld" ? "protected" : "",
      row.amount,
      row.paymentReference,
      // On every row rather than in a header, because a row read out of the
      // file into another system has to carry the date the money is due with
      // it.
      document.dueOn,
    ]),
  ]);
}
