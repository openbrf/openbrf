/**
 * Deciding what an import would do, before it does any of it.
 *
 * The preview a board approves and the writes that follow come from this one
 * function, run twice: once to show, once to apply. That is the point of
 * keeping it pure. A preview produced by different code from the apply is a
 * preview that can be wrong, and this import writes rows into a register the
 * database will not let anyone delete.
 *
 * The match-key precedence is fixed by the plan and is not negotiable per file:
 *
 *   1. personal identity number, through its blind index
 *   2. email address, through its blind index
 *   3. the apartment plus an exact name
 *   4. otherwise a new person
 *
 * Anything that matches more than one person is not resolved by guessing. It
 * comes back as ambiguous and waits for a human, because the two candidates are
 * usually a parent and a child with the same name in the same apartment, and
 * picking one silently puts a stranger's phone number in someone's record.
 */

import {
  isValidPersonalIdentityNumber,
  normalizePersonalIdentityNumber,
} from "../crypto/personal-data";
import {
  type ImportField,
  type ImportMapping,
  parseImportDate,
  parseRole,
  splitFullName,
} from "./import-columns";

export type ImportRole = "MEMBER" | "RESIDENT";

export type ImportOutcome = "create" | "update" | "ambiguous" | "error";

export type ImportMatchKey =
  "personalIdentityNumber" | "email" | "apartmentAndName" | "earlierRow";

/** One thing wrong with one row. The screen supplies the wording. */
export interface ImportProblem {
  field: ImportField | null;
  reason: string;
}

export interface RegisterApartment {
  id: string;
  number: string;
  addressId: string;
  /** Street and number, e.g. "Storgatan 12". */
  addressLabel: string;
}

/** A residency the register holds, with its dates as calendar dates. */
export interface RegisterResidency {
  apartmentId: string;
  role: ImportRole;
  movedInOn: string;
  /** The first day it is no longer held, or null while it is. */
  movedOutOn: string | null;
}

/**
 * What the register holds right now, in the shapes matching needs.
 *
 * Passed in rather than queried here so the decision stays pure and can be
 * exercised against every awkward register a housing cooperative can have.
 */
export interface RegisterSnapshot {
  apartments: readonly RegisterApartment[];
  personsByIdentityNumber: ReadonlyMap<string, readonly string[]>;
  personsByEmail: ReadonlyMap<string, readonly string[]>;
  /** Key from {@link apartmentNameKey}, over current residencies. */
  personsByApartmentAndName: ReadonlyMap<string, readonly string[]>;
  /** The same key over every residency, ended ones included. */
  personsByApartmentAndNameEver: ReadonlyMap<string, readonly string[]>;
  /** Every residency of every person, ended ones included. */
  residenciesByPerson: ReadonlyMap<string, readonly RegisterResidency[]>;
  personNames: ReadonlyMap<string, string>;
}

/** A row after the mapping has been read, with its blind indexes computed. */
export interface PreparedRow {
  /** 1-based, counting data rows only: the header is not row 1. */
  rowNumber: number;
  values: Partial<Record<ImportField, string>>;
  /**
   * Blind index of the row's identity number, when one was computed. Null when
   * the row states none, states an unusable one, or when the register holds no
   * identity number for it to be matched against.
   */
  identityNumberIndex: string | null;
  /** Blind index of the row's email address, when it has a usable one. */
  emailIndex: string | null;
}

export interface ImportDefaults {
  /** Applied to rows with no role column. Never guessed. */
  defaultRole: ImportRole | null;
  /** Applied to rows with no move-in column. */
  defaultMovedInOn: string | null;
}

export interface PlannedPerson {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** Never sent to a client: a preview is not a register view. */
  personalIdentityNumber: string | null;
  postalStreet: string | null;
  postalCode: string | null;
  postalCity: string | null;
}

export interface PlannedRow {
  rowNumber: number;
  outcome: ImportOutcome;
  person: PlannedPerson;
  apartment: { id: string; number: string; addressLabel: string } | null;
  role: ImportRole | null;
  movedInOn: string | null;
  /** False when `movedInOn` is the file's default rather than the row's own. */
  movedInStated: boolean;
  movedOutOn: string | null;
  /** The existing person this row will be written against. */
  matchedPersonId: string | null;
  matchedBy: ImportMatchKey | null;
  /** The row this one shares a person with, when that person is new. */
  sameAsRowNumber: number | null;
  /** Persons the row could equally well be, when the match was ambiguous. */
  candidates: { personId: string; name: string }[];
  problems: ImportProblem[];
}

export interface ImportPlan {
  rows: PlannedRow[];
  summary: Record<ImportOutcome, number>;
}

/**
 * The key persons are indexed under for apartment-and-name matching.
 *
 * The separator is written as an escape rather than as the byte itself: a
 * literal NUL in a source file makes the whole file binary to git, to grep and
 * to every review tool, and this one is worth reading.
 */
export function apartmentNameKey(
  apartmentId: string,
  firstName: string,
  lastName: string,
): string {
  return `${apartmentId}\u0000${normalizeName(`${firstName} ${lastName}`)}`;
}

/** Reads the cells of one data row through the mapping. */
export function readRow(
  cells: readonly string[],
  mapping: ImportMapping,
): Partial<Record<ImportField, string>> {
  const values: Partial<Record<ImportField, string>> = {};
  for (const [index, field] of mapping.entries()) {
    if (field === null) {
      continue;
    }
    const value = (cells[index] ?? "").trim();
    if (value !== "") {
      values[field] = value;
    }
  }
  return values;
}

/** Whether a row states a valid personal identity number worth indexing. */
export function hasIndexableIdentityNumber(
  values: Partial<Record<ImportField, string>>,
): boolean {
  const value = values.personalIdentityNumber;
  return value !== undefined && isValidPersonalIdentityNumber(value);
}

/**
 * A row of the file planned and written before the rows being planned now.
 *
 * The apply plans one chunk at a time, and the rows of earlier chunks are not
 * planned again. What it carries over from them is which person each row was
 * written to, so a row further down the file that the preview showed as the
 * same person as an earlier one reaches that person rather than a second copy.
 */
export interface EarlierRow {
  row: PreparedRow;
  personId: string;
}

export function planImport(
  rows: readonly PreparedRow[],
  snapshot: RegisterSnapshot,
  defaults: ImportDefaults,
  earlier: readonly EarlierRow[] = [],
): ImportPlan {
  /** Persons already seen, so one person spread over two rows stays one. */
  const seen = new SeenPersons();
  for (const { row, personId } of earlier) {
    const scratch: ImportProblem[] = [];
    const name = readName(row.values, scratch);
    const apartment = resolveApartment(row.values, snapshot, scratch);
    seen.record(fileIdentity(row, name, apartment), {
      rowNumber: row.rowNumber,
      personId,
      residencies: [],
    });
  }

  const planned = rows.map((row) => planRow(row, snapshot, defaults, seen));

  const summary: Record<ImportOutcome, number> = {
    create: 0,
    update: 0,
    ambiguous: 0,
    error: 0,
  };
  for (const row of planned) {
    summary[row.outcome]++;
  }

  return { rows: planned, summary };
}

function planRow(
  row: PreparedRow,
  snapshot: RegisterSnapshot,
  defaults: ImportDefaults,
  seen: SeenPersons,
): PlannedRow {
  const problems: ImportProblem[] = [];
  const values = row.values;

  const name = readName(values, problems);
  const apartment = resolveApartment(values, snapshot, problems);
  const role = readRole(values, defaults, problems);
  const movedInOn = readMovedIn(values, defaults, problems);
  const movedOutOn = readMovedOut(values, movedInOn, problems);
  const identityNumber = readIdentityNumber(values, problems);
  const email = readEmail(values, row, problems);

  const person: PlannedPerson = {
    firstName: name?.firstName ?? "",
    lastName: name?.lastName ?? "",
    email,
    phone: values.phone ?? null,
    personalIdentityNumber: identityNumber,
    postalStreet: values.postalStreet ?? null,
    postalCode: values.postalCode ?? null,
    postalCity: values.postalCity ?? null,
  };

  const base: PlannedRow = {
    rowNumber: row.rowNumber,
    outcome: "error",
    person,
    apartment:
      apartment === null
        ? null
        : {
            id: apartment.id,
            number: apartment.number,
            addressLabel: apartment.addressLabel,
          },
    role,
    movedInOn,
    movedInStated: values.movedInOn !== undefined,
    movedOutOn,
    matchedPersonId: null,
    matchedBy: null,
    sameAsRowNumber: null,
    candidates: [],
    problems,
  };

  if (problems.length > 0) {
    return base;
  }

  const match = matchPerson(row, person, apartment, snapshot, {
    // A row that states its own move-in date can be about a residency that has
    // since ended, so it is matched against ended residencies as well. One
    // that only carries the file's default is matched against current ones:
    // the default says nothing about when this person lived here.
    includeEnded: values.movedInOn !== undefined,
  });
  if (match.candidates.length > 1) {
    return {
      ...base,
      outcome: "ambiguous",
      matchedBy: match.key,
      candidates: match.candidates.map((personId) => ({
        personId,
        name: snapshot.personNames.get(personId) ?? personId,
      })),
    };
  }

  const matchedPersonId = match.candidates[0] ?? null;

  // A file may list one person twice - two apartments, or one apartment for
  // two periods of time. The second occurrence has to reach the same person,
  // not a duplicate of them, whether that person already existed or was
  // created by the earlier row. A person the register matched outright is not overruled
  // by a weaker key shared with a row that the register said was someone else.
  const identity = fileIdentity(row, name, apartment);
  const found = seen.find(identity);
  const earlier =
    found !== undefined &&
    (matchedPersonId === null || found.personId === matchedPersonId)
      ? found
      : undefined;

  const resolved: PlannedRow =
    earlier === undefined
      ? {
          ...base,
          outcome: matchedPersonId === null ? "create" : "update",
          matchedPersonId,
          matchedBy: matchedPersonId === null ? null : match.key,
        }
      : {
          ...base,
          outcome: "update",
          matchedPersonId: earlier.personId,
          matchedBy:
            earlier.personId === null || match.key === null
              ? "earlierRow"
              : match.key,
          sameAsRowNumber: earlier.personId === null ? earlier.rowNumber : null,
        };

  // A residency already held as the row states it is not written again, which
  // is also what lets a chunk be attempted twice. Any other residency of this
  // person on this apartment that shares a day with the row's would be a
  // second one held at the same time, which a move-in refuses: the board
  // decides which is right rather than the import writing both, or dropping
  // the row without a word.
  const entry = earlier ?? {
    rowNumber: row.rowNumber,
    personId: matchedPersonId,
    residencies: [],
  };
  const residency = rowResidency(base);
  if (residency !== null) {
    const held = [
      ...(entry.personId === null
        ? []
        : (snapshot.residenciesByPerson.get(entry.personId) ?? [])),
      ...entry.residencies,
    ];
    if (conflictsWith(residency, held)) {
      problems.push({ field: "movedInOn", reason: "residency-conflict" });
      return { ...base, problems };
    }
    if (heldAlready(residency, held) === undefined) {
      entry.residencies.push(residency);
    }
  }
  seen.record(identity, entry);

  return resolved;
}

/** A residency as a row states it. */
export interface RowResidency extends RegisterResidency {
  /** False when the move-in date is the file's default rather than the row's. */
  movedInStated: boolean;
}

/** The residency a planned row would write, if it names one. */
export function rowResidency(row: PlannedRow): RowResidency | null {
  return row.apartment === null || row.role === null || row.movedInOn === null
    ? null
    : {
        apartmentId: row.apartment.id,
        role: row.role,
        movedInOn: row.movedInOn,
        movedInStated: row.movedInStated,
        movedOutOn: row.movedOutOn,
      };
}

/**
 * The residency already held that the row's residency is, if there is one.
 *
 * The same role on the same apartment from the same day is the same residency:
 * it is what a row already written, or a row listed twice, looks like. A row
 * that does not state its own move-in date says only that the person lives
 * here in that role, so a residency in that role that it shares a day with is
 * the same one too. Read as a residency of its own from the default date, a
 * register imported again without its move-in column would refuse every
 * resident it already holds.
 */
export function heldAlready(
  residency: RowResidency,
  held: readonly RegisterResidency[],
): RegisterResidency | undefined {
  return held.find(
    (other) =>
      other.apartmentId === residency.apartmentId &&
      other.role === residency.role &&
      (other.movedInOn === residency.movedInOn ||
        (!residency.movedInStated && overlaps(residency, other))),
  );
}

/**
 * Whether a residency would be held twice: whether, not being one the person
 * already holds, it shares a day with another on the same apartment. A
 * residency is held up to, and not including, the day it ends - the same rule
 * a move-in follows.
 */
export function conflictsWith(
  residency: RowResidency,
  held: readonly RegisterResidency[],
): boolean {
  if (heldAlready(residency, held) !== undefined) {
    return false;
  }
  return held.some(
    (other) =>
      other.apartmentId === residency.apartmentId && overlaps(residency, other),
  );
}

function overlaps(one: RegisterResidency, other: RegisterResidency): boolean {
  return (
    (other.movedOutOn === null || one.movedInOn < other.movedOutOn) &&
    (one.movedOutOn === null || other.movedInOn < one.movedOutOn)
  );
}

function matchPerson(
  row: PreparedRow,
  person: PlannedPerson,
  apartment: RegisterApartment | null,
  snapshot: RegisterSnapshot,
  options: { includeEnded: boolean },
): { key: ImportMatchKey | null; candidates: readonly string[] } {
  if (row.identityNumberIndex !== null) {
    const found = snapshot.personsByIdentityNumber.get(row.identityNumberIndex);
    if (found !== undefined && found.length > 0) {
      return { key: "personalIdentityNumber", candidates: found };
    }
  }
  if (row.emailIndex !== null) {
    const found = snapshot.personsByEmail.get(row.emailIndex);
    if (found !== undefined && found.length > 0) {
      return { key: "email", candidates: found };
    }
  }
  if (apartment !== null) {
    const key = apartmentNameKey(
      apartment.id,
      person.firstName,
      person.lastName,
    );
    const found = (
      options.includeEnded
        ? snapshot.personsByApartmentAndNameEver
        : snapshot.personsByApartmentAndName
    ).get(key);
    if (found !== undefined && found.length > 0) {
      return { key: "apartmentAndName", candidates: found };
    }
  }
  return { key: null, candidates: [] };
}

/** What identifies the person a row is about, within one file. */
interface FileIdentity {
  /** Normalized, when the row states a valid one. */
  identityNumber: string | null;
  emailIndex: string | null;
  /** Every key the row can be found under, strongest first. */
  keys: string[];
}

/** A person the file has already reached, and what they were planned to hold. */
interface SeenPerson {
  rowNumber: number;
  /** Null for a person the file creates. */
  personId: string | null;
  residencies: RegisterResidency[];
}

/**
 * The persons one file has reached so far, under every key their rows carry.
 *
 * Every key a row has is recorded, not only its strongest. A row with an
 * identity number and an address followed by a row with only the address is
 * one person, and keyed on the first identifier alone the second row would
 * become a second person.
 *
 * A weaker key is not allowed to override a stronger one, though: two rows of
 * the same name in the same apartment with different identity numbers are a
 * parent and a child, not one person.
 */
class SeenPersons {
  private readonly byKey = new Map<
    string,
    {
      person: SeenPerson;
      identityNumber: string | null;
      emailIndex: string | null;
    }
  >();

  find(identity: FileIdentity): SeenPerson | undefined {
    for (const key of identity.keys) {
      const found = this.byKey.get(key);
      if (found === undefined) {
        continue;
      }
      const viaIdentityNumber = key.startsWith("pin:");
      const viaEmail = key.startsWith("email:");
      const contradicts =
        (!viaIdentityNumber &&
          differ(found.identityNumber, identity.identityNumber)) ||
        (!viaIdentityNumber &&
          !viaEmail &&
          differ(found.emailIndex, identity.emailIndex));
      if (!contradicts) {
        return found.person;
      }
    }
    return undefined;
  }

  record(identity: FileIdentity, person: SeenPerson): void {
    for (const key of identity.keys) {
      const existing = this.byKey.get(key);
      if (existing === undefined) {
        this.byKey.set(key, {
          person,
          identityNumber: identity.identityNumber,
          emailIndex: identity.emailIndex,
        });
      } else if (existing.person === person) {
        existing.identityNumber ??= identity.identityNumber;
        existing.emailIndex ??= identity.emailIndex;
      }
    }
  }
}

function differ(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b;
}

/**
 * The keys that say two rows of one file describe the same person.
 *
 * The identity number is keyed by its normalized value rather than by its blind
 * index. The key never leaves this pass, so the index buys nothing here - and
 * the index is a truncated hash, so two different numbers colliding in it would
 * fold two people into one. The row's own number is also the only key available
 * when nothing indexed it, which is the case whenever the register holds no
 * identity number to match against.
 */
function fileIdentity(
  row: PreparedRow,
  name: { firstName: string; lastName: string } | null,
  apartment: RegisterApartment | null,
): FileIdentity {
  const identityNumber = hasIndexableIdentityNumber(row.values)
    ? normalizePersonalIdentityNumber(row.values.personalIdentityNumber ?? "")
    : null;
  const keys: string[] = [];
  if (identityNumber !== null) {
    keys.push(`pin:${identityNumber}`);
  }
  if (row.emailIndex !== null) {
    keys.push(`email:${row.emailIndex}`);
  }
  if (apartment !== null && name !== null) {
    keys.push(
      `name:${apartmentNameKey(apartment.id, name.firstName, name.lastName)}`,
    );
  }
  return { identityNumber, emailIndex: row.emailIndex, keys };
}

function readName(
  values: Partial<Record<ImportField, string>>,
  problems: ImportProblem[],
): { firstName: string; lastName: string } | null {
  const first = values.firstName;
  const last = values.lastName;
  if (first !== undefined && last !== undefined) {
    return { firstName: first, lastName: last };
  }

  const full = values.fullName;
  if (full !== undefined) {
    const split = splitFullName(full);
    if (split !== null) {
      return split;
    }
    problems.push({ field: "fullName", reason: "name-not-splittable" });
    return null;
  }

  problems.push({ field: null, reason: "name-missing" });
  return null;
}

function resolveApartment(
  values: Partial<Record<ImportField, string>>,
  snapshot: RegisterSnapshot,
  problems: ImportProblem[],
): RegisterApartment | null {
  const number = values.apartmentNumber;
  if (number === undefined) {
    problems.push({ field: "apartmentNumber", reason: "apartment-missing" });
    return null;
  }

  const byNumber = snapshot.apartments.filter(
    (apartment) => apartment.number === number.trim(),
  );

  const label = values.addressLabel;
  if (label === undefined) {
    if (byNumber.length === 1) {
      return byNumber[0] ?? null;
    }
    problems.push({
      field: "apartmentNumber",
      reason:
        byNumber.length === 0 ? "apartment-not-found" : "apartment-ambiguous",
    });
    return null;
  }

  const wanted = normalizeAddress(label);
  const matches = byNumber.filter(
    (apartment) => normalizeAddress(apartment.addressLabel) === wanted,
  );
  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  problems.push({
    field: matches.length === 0 ? "addressLabel" : "apartmentNumber",
    reason:
      matches.length === 0 ? "apartment-not-found" : "apartment-ambiguous",
  });
  return null;
}

function readRole(
  values: Partial<Record<ImportField, string>>,
  defaults: ImportDefaults,
  problems: ImportProblem[],
): ImportRole | null {
  const raw = values.role;
  if (raw === undefined) {
    if (defaults.defaultRole !== null) {
      return defaults.defaultRole;
    }
    problems.push({ field: "role", reason: "role-missing" });
    return null;
  }

  const parsed = parseRole(raw);
  if (parsed === null) {
    problems.push({ field: "role", reason: "role-unrecognised" });
  }
  return parsed;
}

function readMovedIn(
  values: Partial<Record<ImportField, string>>,
  defaults: ImportDefaults,
  problems: ImportProblem[],
): string | null {
  // The default is read by the same parser as a cell. It is stated once and
  // lands on every row without a date of its own, so a default the calendar
  // does not have would be the same wrong day on every one of them.
  const raw = values.movedInOn ?? defaults.defaultMovedInOn ?? undefined;
  if (raw === undefined) {
    problems.push({ field: "movedInOn", reason: "moved-in-missing" });
    return null;
  }

  const parsed = parseImportDate(raw);
  if (parsed === null) {
    problems.push({ field: "movedInOn", reason: "date-not-iso" });
  }
  return parsed;
}

function readMovedOut(
  values: Partial<Record<ImportField, string>>,
  movedInOn: string | null,
  problems: ImportProblem[],
): string | null {
  const raw = values.movedOutOn;
  if (raw === undefined) {
    return null;
  }

  const parsed = parseImportDate(raw);
  if (parsed === null) {
    problems.push({ field: "movedOutOn", reason: "date-not-iso" });
    return null;
  }
  if (movedInOn !== null && parsed < movedInOn) {
    problems.push({
      field: "movedOutOn",
      reason: "moved-out-before-moved-in",
    });
    return null;
  }
  return parsed;
}

function readIdentityNumber(
  values: Partial<Record<ImportField, string>>,
  problems: ImportProblem[],
): string | null {
  const raw = values.personalIdentityNumber;
  if (raw === undefined) {
    return null;
  }
  if (!isValidPersonalIdentityNumber(raw)) {
    // Refused rather than stored: a number that fails its own checksum is a
    // typing mistake, and the apartment register would carry it as a fact about
    // a person who does not exist.
    problems.push({
      field: "personalIdentityNumber",
      reason: "invalid-personal-identity-number",
    });
    return null;
  }
  return raw;
}

function readEmail(
  values: Partial<Record<ImportField, string>>,
  row: PreparedRow,
  problems: ImportProblem[],
): string | null {
  const raw = values.email;
  if (raw === undefined) {
    return null;
  }
  // Shape only. The blind index is what decides whether the address is usable,
  // and an address that cannot be indexed is stored unreachable rather than
  // stored badly.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || row.emailIndex === null) {
    problems.push({ field: "email", reason: "invalid-email" });
    return null;
  }
  return raw;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** "Storgatan 12", "storgatan  12" and "Storgatan12" are one address. */
function normalizeAddress(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}
