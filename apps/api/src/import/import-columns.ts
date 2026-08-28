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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // Round-tripped so 2026-02-30 is refused rather than rolling into March.
  return parsed.toISOString().slice(0, 10) === trimmed ? trimmed : null;
}
