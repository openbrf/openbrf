import {
  parseLocalDay,
  scanForPersonalIdentityNumberCandidates,
} from "@openbrf/shared";
import { z } from "zod";

/**
 * The fields an import can fill, and the guess that saves the board from
 * mapping every column by hand.
 *
 * The guess is a convenience and never a decision: the mapping screen shows
 * what was guessed and the board confirms or changes it before anything is
 * previewed. A silent guess on a column that turned out to be something else
 * would put one resident's phone number in another's row, in a register that is
 * meant to be evidence.
 */

/** Every field a column can be mapped to. */
export const IMPORT_FIELDS = [
  /** Street and number together, e.g. "Storgatan 12". */
  "addressLabel",
  "apartmentNumber",
  "firstName",
  "lastName",
  /** Used when the file has one name column instead of two. */
  "fullName",
  "role",
  "email",
  "phone",
  "personalIdentityNumber",
  "postalStreet",
  "postalCode",
  "postalCity",
  "movedInOn",
  "movedOutOn",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * A mapping, one entry per column of the uploaded file in file order. Null
 * leaves that column out of the import.
 */
export type ImportMapping = readonly (ImportField | null)[];

/**
 * Header titles that identify a field, in Swedish and English.
 *
 * Compared after {@link normalizeHeader}, so "E-postadress", "e post adress"
 * and "EPOSTADRESS" are one entry rather than three.
 */
const HEADER_SYNONYMS: Record<ImportField, readonly string[]> = {
  addressLabel: ["adress", "gatuadress", "gata", "address", "street address"],
  apartmentNumber: [
    "lagenhet",
    "lagenhetsnummer",
    "lgh",
    "lgh nr",
    "lghnr",
    "apartment",
    "apartment number",
    "apt",
  ],
  firstName: ["fornamn", "first name", "given name", "tilltalsnamn"],
  lastName: ["efternamn", "last name", "surname", "family name"],
  fullName: ["namn", "name", "medlem", "person", "full name", "namn pa medlem"],
  role: ["roll", "role", "typ", "kategori", "medlemstyp"],
  email: [
    "epost",
    "e post",
    "epostadress",
    "e postadress",
    "mail",
    "email",
    "e mail",
    "email address",
  ],
  phone: [
    "telefon",
    "telefonnummer",
    "tel",
    "mobil",
    "mobilnummer",
    "phone",
    "phone number",
    "mobile",
  ],
  personalIdentityNumber: [
    "personnummer",
    "personnr",
    "pnr",
    "personal identity number",
    "personal number",
  ],
  postalStreet: [
    "postadress",
    "utdelningsadress",
    "postal address",
    "mailing address",
  ],
  postalCode: ["postnummer", "postnr", "postal code", "zip", "zip code"],
  postalCity: ["postort", "ort", "stad", "city", "town"],
  movedInOn: [
    "inflyttning",
    "inflytt",
    "inflyttningsdatum",
    "medlem sedan",
    "moved in",
    "move in",
    "moved in on",
  ],
  movedOutOn: [
    "utflyttning",
    "utflytt",
    "utflyttningsdatum",
    "moved out",
    "move out",
    "moved out on",
  ],
};

/**
 * Reduces a column title to something comparable: lower case, without
 * diacritics, and with every run of punctuation or space collapsed to one
 * space. "E-postadress" and "e postadress" are the same title written twice.
 */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Whether the row the upload takes as the column titles is a member's row:
 * whether a cell of it holds a personal identity number, an email address, a
 * phone number or a date.
 *
 * No column title is any of those, and a file saved without its header row
 * starts with a member's row that usually holds one. Taken as the titles, that
 * row would be shown on the mapping screen and stored as the session's columns,
 * so the upload refuses the file before it keeps anything of it. A first row
 * holding only a name and an apartment is not caught, which is why the source
 * a file's titles name is still found by a keyed digest of them.
 *
 * A cell holding an identity number anywhere in it counts, mistyped or not, as
 * the sample's masking counts one. The other three count only as the whole
 * cell: a title may well mention a date or an address. A date counts in any
 * of the shapes a spreadsheet writes one, 03/04/2026 or 3.4.26 as well as ISO,
 * although the import itself reads only ISO dates (`parseImportDate`): the
 * question here is only whether the cell is a member's value. Invisible formatting
 * characters, a zero-width space pasted along with a value or a stray byte
 * order mark, are taken out first, as they would hide a value from the
 * patterns without hiding it from the screen.
 */
export function readsAsMemberRow(titles: readonly string[]): boolean {
  return titles.some((title) => {
    const cell = title.replace(/\p{Cf}/gu, "").trim();
    return (
      scanForPersonalIdentityNumberCandidates(cell).length > 0 ||
      EMAIL_ADDRESS.safeParse(cell).success ||
      isPhoneNumber(cell) ||
      isDateShaped(cell)
    );
  });
}

/**
 * A day written year first or year last, with a dash, a slash or a dot between
 * its parts, and a time of day after it as some exports add, with fractions of
 * a second and a time zone as in 2019-06-01T00:00:00.000Z. Whether the day
 * exists does not matter: 2026-02-30 is a member's mistyped date, not a title.
 */
function isDateShaped(text: string): boolean {
  return /^(?:\d{4}([-/.])\d{1,2}\1\d{1,2}|\d{1,2}([-/.])\d{1,2}\2(?:\d{2}|\d{4}))(?:[ T]\d{1,2}[:.]\d{2}(?:[:.]\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
    text,
  );
}

/** The same check as the API's other email fields. */
const EMAIL_ADDRESS = z.email();

/**
 * Digits written the ways a phone number is, and enough of them for one: seven
 * at the least, as in a Swedish local number without its area code. An
 * apartment number or a postal code has fewer.
 */
function isPhoneNumber(text: string): boolean {
  return (
    /^\+?[\d\s().\p{Pd}]+$/u.test(text) && text.replace(/\D/g, "").length >= 7
  );
}

/**
 * Guesses a mapping from the header row.
 *
 * A field is claimed by the first column that names it, so a file with both
 * "Namn" and "Förnamn" gives fullName to the first and firstName to the second
 * rather than letting the later column silently win.
 */
export function suggestMapping(
  headers: readonly string[],
): (ImportField | null)[] {
  const taken = new Set<ImportField>();

  return headers.map((header) => {
    const normalized = normalizeHeader(header);
    if (normalized === "") {
      return null;
    }

    for (const field of IMPORT_FIELDS) {
      if (taken.has(field)) {
        continue;
      }
      if (HEADER_SYNONYMS[field].includes(normalized)) {
        taken.add(field);
        return field;
      }
    }
    return null;
  });
}

/**
 * A mapping as the session stores it, read back. An empty entry, or one naming
 * no field, is a column not imported.
 */
export function readMapping(stored: readonly string[]): ImportMapping {
  return stored.map((field) =>
    (IMPORT_FIELDS as readonly string[]).includes(field)
      ? (field as ImportField)
      : null,
  );
}

/**
 * Whether a mapping can be applied at all.
 *
 * Returns the problems rather than throwing, because the mapping screen has to
 * show all of them at once: fixing one and being told about the next is how a
 * board gives up on an import.
 */
export function validateMapping(input: {
  mapping: ImportMapping;
  columnCount: number;
  /** Used for rows with no role column of their own. */
  defaultRole: "MEMBER" | "RESIDENT" | null;
  /** Used for rows with no move-in column of their own. */
  defaultMovedInOn: string | null;
}): string[] {
  const problems: string[] = [];

  if (input.mapping.length !== input.columnCount) {
    problems.push("mapping-length-mismatch");
  }

  const seen = new Set<ImportField>();
  for (const field of input.mapping) {
    if (field === null) {
      continue;
    }
    if (seen.has(field)) {
      problems.push(`duplicate-field:${field}`);
    }
    seen.add(field);
  }

  const hasName =
    seen.has("fullName") || (seen.has("firstName") && seen.has("lastName"));
  if (!hasName) {
    problems.push("name-column-missing");
  }
  if (!seen.has("apartmentNumber")) {
    problems.push("apartment-column-missing");
  }
  if (!seen.has("role") && input.defaultRole === null) {
    // Nothing may guess this. A blank cell read as "member" writes a statutory
    // register entry that cannot be deleted afterwards.
    problems.push("role-missing");
  }
  if (!seen.has("movedInOn") && input.defaultMovedInOn === null) {
    problems.push("moved-in-missing");
  }
  // A default is for a file without the column, and is never a blank cell's
  // value: a role guessed for one is a register entry nobody chose, and a
  // date for one makes the same person's rows disagree with each other
  // depending on which of them the file lists first.
  if (seen.has("role") && input.defaultRole !== null) {
    problems.push("default-role-with-column");
  }
  if (seen.has("movedInOn") && input.defaultMovedInOn !== null) {
    problems.push("default-moved-in-with-column");
  }

  return problems;
}

/** Splits a single name column into a first and a last name. */
export function splitFullName(value: string): {
  firstName: string;
  lastName: string;
} | null {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace <= 0) {
    return null;
  }
  return {
    firstName: trimmed.slice(0, lastSpace),
    lastName: trimmed.slice(lastSpace + 1),
  };
}

/**
 * Reads the role a row states.
 *
 * The Swedish words a board writes in a spreadsheet are not the enum's, and the
 * distinction is the one that decides whether a statutory member register entry
 * is written, so an unrecognised word is refused rather than defaulted.
 */
export function parseRole(value: string): "MEMBER" | "RESIDENT" | null {
  const normalized = normalizeHeader(value);
  if (normalized === "") {
    return null;
  }
  if (
    [
      "medlem",
      "member",
      "bostadsrattshavare",
      "agare",
      "owner",
      "tenant owner",
    ].includes(normalized)
  ) {
    return "MEMBER";
  }
  if (
    [
      "boende",
      "resident",
      "hyresgast",
      "sambo",
      "partner",
      "barn",
      "child",
      "tenant",
    ].includes(normalized)
  ) {
    return "RESIDENT";
  }
  return null;
}

/**
 * Reads a calendar date.
 *
 * ISO only, and deliberately so: 03/04/2026 is two different days depending on
 * which side of the Atlantic wrote it, and a member register entry dated six
 * months wrong is not correctable by editing. Excel date cells arrive already
 * converted, so a board that formats the column as a date never meets this.
 */
export function parseImportDate(value: string): string | null {
  const trimmed = value.trim();
  // Strict about the date being real, so 2026-02-30 is refused rather than
  // rolling into March.
  return parseLocalDay(trimmed) === null ? null : trimmed;
}
