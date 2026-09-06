import { writeCsv } from "../import/csv";

/**
 * The debiting list (debiteringslangd): the charges for a period, as the board
 * reads them and as the file it hands over states them.
 *
 * A module of its own, and pure, because the same rows are printed and
 * serialised and the two must not be able to disagree. The screen prints what
 * this shape says and {@link writeDebitingList} writes what this shape says, so
 * a column withheld from one is withheld from the other by construction rather
 * than by two people remembering.
 *
 * ## Masking
 *
 * The list is the one thing this module produces that leaves the association: it
 * goes to the economic manager, who has no account here. A row therefore carries
 * a protected person's apartment the way the member register extract carries a
 * protected member's address - which is to say not at all, with the document
 * saying that it is withheld rather than leaving the cell blank. The member
 * register's own comment is the argument: the postal address is precisely what
 * protection exists to withhold, and an extract handed over on paper is the one
 * mistake that cannot be taken back.
 *
 * The name is not withheld, on the same precedent. The register extract prints a
 * protected member's name and withholds where they are, and a bookkeeper who
 * cannot be told who to invoice has been handed a list they cannot use. What the
 * masking removes is the link from the name to the door.
 *
 * A charge recorded against the apartment itself names no person and is not
 * masked. The apartment is the charged party there, so withholding it would
 * empty the row, and the association's own apartment numbers are on every
 * document it produces - what protection withholds is which person is behind
 * one, which such a row does not say.
 *
 * ## No payment, anywhere in this shape
 *
 * There is no paid column, no outstanding column and no status. The accounting
 * system settles the debt; `handedToManagerOn` says when the basis left the
 * association and nothing about what happened to it afterwards.
 */

/** An apartment on the list, or the statement that it is withheld. */
export type DebitingListApartment =
  | {
      state: "visible";
      /** "<street> <number> <apartment number>", or null where none is held. */
      label: string | null;
    }
  | { state: "masked" };

/**
 * Who the charge is on.
 *
 * A discriminated union rather than two nullable columns, because the two are
 * different rows to read: one names a person and says where they live, the other
 * names a flat and says nothing about who is in it.
 */
export type DebitingListParty =
  | {
      kind: "person";
      personId: string;
      name: string;
      protectedPersonalData: boolean;
      apartment: DebitingListApartment;
    }
  | {
      kind: "apartment";
      /** Null once the apartment has been corrected out of the register. */
      apartmentId: string | null;
      apartment: DebitingListApartment;
    };

export interface DebitingListRow {
  chargeId: string;
  /** "YYYY-MM-DD" on the association's own calendar. */
  chargedOn: string;
  chargedTo: DebitingListParty;
  /** Kronor, as the decimal column holds it: "450.00". */
  amount: string;
  vatTreatment: "EXEMPT" | "RATE";
  /** Whole percent, and null exactly when the treatment is EXEMPT. */
  vatRatePercent: number | null;
  /** The board's own words for what is being charged. */
  reason: string;
  /** "YYYY-MM-DD", or null while the basis has not gone to the manager. */
  handedToManagerOn: string | null;
}

export interface DebitingList {
  housingCooperative: { name: string; organizationNumber: string | null };
  /** The period read, inclusive at both ends. "YYYY-MM-DD". */
  from: string;
  to: string;
  /** The day the list was produced, for the document stamp. */
  generatedOn: string;
  rows: DebitingListRow[];
  /**
   * The sum of the rows' amounts, as a decimal string.
   *
   * Stated because it is the first thing whoever keeps the books checks the file
   * against, and computing it on the screen and again in the file would be two
   * chances to get it wrong. It is a sum of what was charged and never a balance:
   * nothing here has been reduced by a payment.
   */
  total: string;
}

/**
 * The columns of the file, in file order.
 *
 * English, like every identifier in this repository and like the register supply
 * file's own columns. The file is read by whoever keeps the association's books,
 * either by eye or by a mapping into their system, and a header row is the part
 * of it that a mapping is written against - so it is stable and documented
 * rather than translated.
 *
 * `party` says which kind of row this is, so a reader does not have to infer it
 * from which of the two name columns is empty. `apartment` is empty on a
 * protected person's row, and `apartmentWithheld` is what tells the reader that
 * the emptiness is deliberate: a bookkeeper looking at a blank cell would
 * otherwise ring the board about a list they would be told is correct.
 */
export const DEBITING_LIST_COLUMNS = [
  "chargedOn",
  "party",
  "name",
  "apartment",
  "apartmentWithheld",
  "amount",
  "vatTreatment",
  "vatRatePercent",
  "reason",
  "handedToManagerOn",
] as const;

/** The name the file is offered under. The period, so two exports do not collide. */
export function debitingListFileName(from: string, to: string): string {
  return `debiteringslangd-${from}-${to}.csv`;
}

/**
 * Serialises the list.
 *
 * Through `writeCsv`, which is the repository's one CSV writer: semicolons and a
 * byte order mark, because the file is opened in the spreadsheet the bookkeeper
 * already has and Excel reads an unmarked UTF-8 file as the local code page.
 * That is the same reason the register supply file goes out that way, and one
 * writer means the two are the same dialect.
 *
 * Every row is emitted in `DEBITING_LIST_COLUMNS` order, so a column added to
 * that list appears in the file and in the header together. A row is read by
 * position once it has left this process, and a header that disagreed with the
 * order of the cells beneath it would put every value one field to the left.
 */
export function writeDebitingList(list: DebitingList): string {
  return writeCsv([
    [...DEBITING_LIST_COLUMNS],
    ...list.rows.map((row) => [
      row.chargedOn,
      row.chargedTo.kind,
      row.chargedTo.kind === "person" ? row.chargedTo.name : "",
      row.chargedTo.apartment.state === "visible"
        ? (row.chargedTo.apartment.label ?? "")
        : "",
      // Stated as a word rather than left to the empty cell above, per the
      // column list's comment.
      row.chargedTo.apartment.state === "masked" ? "protected" : "",
      row.amount,
      row.vatTreatment,
      row.vatRatePercent === null ? "" : String(row.vatRatePercent),
      row.reason,
      row.handedToManagerOn ?? "",
    ]),
  ]);
}

/**
 * The sum of a list's amounts, as a decimal string with two places.
 *
 * Summed in ore as integers rather than as numbers with a decimal point. A list
 * of a few hundred charges added up in binary floating point produces a total
 * ending in a cent that is not there, and this figure is the one the bookkeeper
 * reconciles their own against.
 *
 * The amounts arrive as the decimal column's own rendering, which is always
 * `<digits>.<two digits>` for a `DECIMAL(14, 2)`; anything else is a value this
 * table cannot hold and is refused rather than rounded, because a total that
 * silently dropped a row would be worse than no total.
 */
export function sumChargeAmounts(amounts: readonly string[]): string {
  let ore = 0n;
  for (const amount of amounts) {
    const match = /^(\d+)\.(\d{2})$/.exec(amount);
    const kronor = match?.[1];
    const ren = match?.[2];
    if (kronor === undefined || ren === undefined) {
      throw new RangeError(`A charge amount is not a decimal sum: ${amount}`);
    }
    ore += BigInt(kronor) * 100n + BigInt(ren);
  }
  return `${String(ore / 100n)}.${String(ore % 100n).padStart(2, "0")}`;
}
