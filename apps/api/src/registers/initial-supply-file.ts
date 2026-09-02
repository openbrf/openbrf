import { writeCsv } from "../import/csv";

/**
 * The file the initial supply to the cooperative housing register is made from.
 *
 * Lag (2026:485) 3 § makes an association supply, by 31 December 2027, the data
 * the register is to hold about the bostadsrattslagenhet, the
 * bostadsrattsforening, the bostadsrattshavare, pantsattningar and anteckningar.
 * Forordning (2026:898) 2 kap. 3-7 §§ is the field list, and that forordning's
 * overgangsbestammelse 2 narrows that supply duty (uppgiftsskyldighet) to a
 * named subset of it.
 *
 * ## This is Open BRF's own shape, and not Lantmateriet's
 *
 * Stated first because everything else depends on it. Lantmateriet's technical
 * interface is not published: Forordning (2026:898) 2 kap. 2 § permits an
 * anmalan to be transferred electronically "enligt foreskrifter som
 * Lantmateriet far meddela", and 5 kap. 1 and 2 §§ and overgangsbestammelse 3
 * leave the form of it to foreskrifter that do not exist yet. Nothing here
 * guesses at one.
 *
 * What is fixed is the content, because the forordning enumerates it. So the
 * columns below are named for the fields that enumeration names, one column per
 * field, and the file is a plain delimited one. When the interface is published,
 * transforming this into it is a mapping against a stable contract rather than a
 * second reading of the statute. `docs/register-supply-contract.md` is the
 * contract as a reader finds it, including the fields an instance does not hold
 * and why.
 *
 * ## Why the rows are typed rather than one row per apartment
 *
 * The duty covers five kinds of thing at once, and they do not have one shape.
 * An apartment has one holder or several, each with a personal identity number
 * of their own; a lien note belongs to an apartment and not to a holder; the
 * association's own fields are stated once for the whole file. A single flat row
 * per apartment would have to either repeat a holder's columns a fixed number of
 * times - which silently drops the third co-holder - or leave the lien notes out.
 *
 * So every row names its own kind in the first column and fills the columns
 * belonging to that kind. HOLDER and LIEN rows point at their apartment
 * through `apartmentKey`, which is this file's own key and not a field the
 * forordning asks for.
 *
 * ## Anteckningar
 *
 * There are no NOTE rows and the type carries none. Forordning (2026:898) 2 kap.
 * 7 § lists ten decisions and measures - utmatning, kvarstad, betalningssakring,
 * tvangsforsaljning, exekutiv forsaljning, forvar, a suit about havning or
 * battre ratt, a refused membership referred to hyresnamnden, unpaid fees under
 * BRL 7 kap. 31 §, and a decision under BRL 9 kap. 16 § forsta stycket 4 - and
 * an instance records none of them. Overgangsbestammelse 2 b) limits the initial
 * duty to data the association "ar skyldig att ha antecknade eller har tillgang
 * till", and none of those ten is a record bostadsrattslagen requires the
 * association to keep, so their absence is the duty being met rather than a gap.
 */

/**
 * What one row of the file is about.
 *
 * ASSOCIATION appears once. APARTMENT appears once per bostadsratt. HOLDER
 * appears once per current bostadsrattshavare of each, so two co-holders are two
 * rows. LIEN appears once per pantsattning the association still has noted.
 */
export type SupplyRecordType = "ASSOCIATION" | "APARTMENT" | "HOLDER" | "LIEN";

/**
 * The columns, in file order.
 *
 * One flat list rather than a list per record type, because a delimited file has
 * one header. A row fills the columns its kind owns and leaves the rest empty;
 * which columns those are is the table in `docs/register-supply-contract.md`.
 *
 * The names are English, like every other identifier in this repository, and the
 * statutory reference for each is in that document rather than in the column
 * name: a header carrying a paragraph number would go stale the day the chapter
 * is renumbered, and the file would then state a citation that is wrong.
 *
 * Exported so the audit entry can name every column the file carried. Naming the
 * fields is what makes that entry say how much was disclosed rather than merely
 * that something was, which is the reading the data subject access report takes
 * of its own sections.
 */
export const SUPPLY_COLUMNS = [
  /** Which kind of thing this row is about. Open BRF's own, not a field. */
  "recordType",
  /**
   * The apartment a row belongs to, as `<street> <number> <apartment number>`.
   *
   * This file's own key rather than a field the forordning asks for, and named
   * so it cannot be mistaken for one. It exists because HOLDER and LIEN rows
   * have to point at their APARTMENT row, and it is composed the way the
   * apartment register extract composes a designation - address unique on street
   * and number, apartment unique on address and number - so it is unique within
   * an association and stable across two reads.
   */
  "apartmentKey",
  // The bostadsrattsforening (2 kap. 4 §), on the ASSOCIATION row.
  "associationName",
  "associationOrganizationNumber",
  "associationPropertyDesignation",
  // The bostadsrattslagenhet (2 kap. 3 §), on an APARTMENT row.
  "apartmentNumber",
  "apartmentAddressStreet",
  "apartmentAddressNumber",
  "apartmentPostalCode",
  "apartmentPostalCity",
  // The bostadsrattshavare (2 kap. 5 §), on a HOLDER row.
  "holderName",
  "holderPersonalIdentityNumber",
  "holderPostalStreet",
  "holderPostalCode",
  "holderPostalCity",
  /**
   * Whether this holder has protected personal data (skyddade personuppgifter).
   *
   * Not a field the forordning asks for. It is here because the three postal
   * columns above are deliberately empty for such a holder, and an empty address
   * with nothing saying why reads as a register that lost one. See the document
   * for the reasoning; the short of it is that an address the association may
   * not pass on is not one it passes on under a supply duty either, and the
   * receiving authority holds it through Skatteverket, where the protection is
   * administered.
   */
  "holderProtectedPersonalData",
  "holderHeldFrom",
  "holderMembershipDecidedOn",
  // Pantsattningar (2 kap. 6 §), on a LIEN row.
  "lienCreditor",
  "lienNotedOn",
] as const;

export type SupplyColumn = (typeof SUPPLY_COLUMNS)[number];

/**
 * One row, as the columns it fills.
 *
 * A partial record rather than a union of four row shapes. The file has one
 * header and a row leaves the columns of the other kinds empty, so a partial
 * record is what a row is; four shapes would be four spellings of the same
 * thing, and the serialiser would still have to flatten them to one order.
 */
export type SupplyRow = { recordType: SupplyRecordType } & Partial<
  Record<Exclude<SupplyColumn, "recordType">, string>
>;

/** The name the file is offered under. Dated, so two supplies do not collide. */
export function supplyFileName(generatedOn: string): string {
  return `bostadsrattsregister-uppgifter-${generatedOn}.csv`;
}

/**
 * Serialises the rows.
 *
 * Through `writeCsv`, which is the repository's one CSV writer: semicolons and a
 * byte order mark, because the file is opened in the spreadsheet the board
 * already has and Excel reads an unmarked UTF-8 file as the local code page.
 * That is the same reason the import template goes out that way, and one writer
 * means a file this produces and a file that produces are the same dialect.
 *
 * The header is `SUPPLY_COLUMNS` verbatim and every row is emitted in that
 * order, so a column added to the list appears in the file and in the header
 * together. A row is read by position once it has left this process, and a
 * header that disagreed with the order of the cells beneath it would put every
 * value one field to the left.
 */
export function writeSupplyFile(rows: readonly SupplyRow[]): string {
  return writeCsv([
    [...SUPPLY_COLUMNS],
    ...rows.map((row) =>
      SUPPLY_COLUMNS.map((column) =>
        column === "recordType" ? row.recordType : (row[column] ?? ""),
      ),
    ),
  ]);
}
