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
 *
 * A single match on the weaker keys waits for a human too when the row
 * contradicts the person it reached: a different identity number, or, for an
 * email match, a different name. An email address is shared within a household
 * and handed on when someone moves out, and a name repeats across generations,
 * so neither is evidence that the row is about the person the register holds.
 *
 * The persons the earlier rows of the same file create or fill in count as the
 * register, by the same keys and the same rules. The apply plans the file a
 * chunk at a time against the register the previous chunk left, and a preview
 * that treated those persons any differently would show a row as an update the
 * apply then stops at. That includes what the board decided for an ambiguous
 * row: the person chosen for it, or created by it, is written like any other.
 *
 * A residency the person already holds as the row states it is not written
 * again. One that shares a day with another residency of theirs on the same
 * apartment is refused as a problem with the row, for the board to settle,
 * rather than written as a second one or dropped without a word.
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

/** The keys a row is matched under, in the order the plan tries them. */
export const IMPORT_SEARCH_KEYS = [
  "personalIdentityNumber",
  "email",
  "apartmentAndName",
] as const satisfies readonly ImportMatchKey[];

export type ImportSearchKey = (typeof IMPORT_SEARCH_KEYS)[number];

/** What a row states differently from the one person it matched. */
export type ImportMismatch = "personalIdentityNumber" | "name";

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
  /**
   * Key from {@link apartmentNameKey}. Only residencies that have not ended on
   * the day the snapshot was taken: a household recorded as moving in later
   * counts, and one whose move-out date has arrived does not.
   */
  personsByApartmentAndName: ReadonlyMap<string, readonly string[]>;
  /** The same key over every residency, ended ones included. */
  personsByApartmentAndNameEver: ReadonlyMap<string, readonly string[]>;
  personNames: ReadonlyMap<string, string>;
  /** Blind index of each person's identity number, for those that have one. */
  identityNumberIndexByPerson: ReadonlyMap<string, string>;
  /** Persons with an email address stored, indexed or not. */
  personsWithEmail: ReadonlySet<string>;
  /** Every residency of every person, ended ones included. */
  residenciesByPerson: ReadonlyMap<string, readonly RegisterResidency[]>;
  /**
   * The day the snapshot was read, as the date column holds it (ADR 0013): a
   * residency ending after it is current.
   */
  takenAt: Date;
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
  /**
   * Their name as the register holds it, so the board can see who it is. For a
   * person an earlier row creates, the name that row gives them, while
   * `matchedPersonId` is still null.
   */
  matchedPersonName: string | null;
  matchedBy: ImportMatchKey | null;
  /**
   * The key the row's candidates were found under, also when `matchedBy` names
   * the row after an earlier one. The plan stops at the first key that finds
   * anybody, so the keys after it were not looked under. Null when no key found
   * anybody, and on a row with problems. Not sent to the preview.
   */
  foundUnder: ImportSearchKey | null;
  /**
   * Why a row that matched one person still waits for a decision. Null when it
   * is ambiguous because it matched several, and on every other outcome.
   */
  mismatch: ImportMismatch | null;
  /**
   * The row this one shares a person with, when that person is new. For a
   * person the register holds, the earlier row whose identity number this row
   * reached them through.
   */
  sameAsRowNumber: number | null;
  /** Persons the row could equally well be, when the match was ambiguous. */
  candidates: { personId: string; name: string }[];
  problems: ImportProblem[];
}

export interface ImportPlan {
  rows: PlannedRow[];
  summary: Record<ImportOutcome, number>;
}

/** What the board answered for a row the plan could not resolve. */
export type ImportDecision =
  | { action: "use-person"; personId: string }
  | { action: "create" }
  | { action: "skip" };

/** Keyed by the row's number in the file, as a string. */
export type ImportDecisions = Record<string, ImportDecision>;

/**
 * An identity number a row of an earlier chunk stated, and the person the apply
 * wrote that row to without writing the number: the row reached them by
 * another key. Without it, a later row with the same number would find nobody
 * in the register and create the person a second time.
 */
export interface UnwrittenIdentityNumber {
  rowNumber: number;
  /** Normalized. */
  identityNumber: string;
  personId: string;
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
  return apartmentFullNameKey(apartmentId, `${firstName} ${lastName}`);
}

function apartmentFullNameKey(apartmentId: string, name: string): string {
  return `${apartmentId}\u0000${normalizeName(name)}`;
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
 * Plans the rows in file order.
 *
 * The decisions do not change any row's outcome: a row that needs one stays
 * ambiguous, so the board can still see and change what it chose. They decide
 * what that row writes, which later rows are matched against.
 *
 * The apply passes the identity numbers the rows of its earlier chunks stated
 * without them being written, which only the rows themselves know.
 */
export function planImport(
  rows: readonly PreparedRow[],
  snapshot: RegisterSnapshot,
  defaults: ImportDefaults,
  decisions: ImportDecisions = {},
  unwritten: readonly UnwrittenIdentityNumber[] = [],
): ImportPlan {
  const written: FileWrites = {
    byIdentityNumber: new Map(),
    byEmail: new Map(),
    byApartmentAndName: new Map(),
    byApartmentAndNameEver: new Map(),
    registered: new Map(),
  };

  for (const earlier of unwritten) {
    if (snapshot.personNames.has(earlier.personId)) {
      recordIdentityNumber(
        written,
        registeredPerson(earlier.personId, snapshot, written),
        earlier.identityNumber,
        earlier.rowNumber,
        snapshot,
      );
    }
  }

  const planned = rows.map((row) =>
    planRow(row, snapshot, defaults, decisions, written),
  );

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

/**
 * A person as the register will hold them once the earlier rows of the file
 * are written.
 */
interface FilePerson {
  /** The register's id, or null for a person an earlier row creates. */
  personId: string | null;
  /** The row that creates them, when they are new. */
  createdByRow: number | null;
  name: string;
  /**
   * The normalized number of a person the file creates, or one an earlier row
   * stated for a person who has none. A number the register holds is compared
   * through its blind index instead.
   */
  identityNumber: string | null;
  /**
   * The row that stated `identityNumber` when the apply does not write it: the
   * row reached the person by another key, and an import never gives anyone a
   * number on the strength of an email address or a name.
   */
  identityNumberFromRow: number | null;
  hasEmail: boolean;
  /** Every residency they hold, ended ones included, and those rows add. */
  residencies: RegisterResidency[];
}

/**
 * What the rows planned so far will have written, keyed the way the register
 * snapshot is.
 *
 * The apply plans one chunk at a time against the register as the chunks
 * before it left it, so a row far down the file meets the persons earlier rows
 * wrote as register persons. The preview plans the whole file against the
 * register as it is now. For the two to agree, every row is matched against the
 * register and these writes together, by the same keys, the same precedence and
 * the same contradiction rules - which is also what makes one person listed
 * twice in a file one person rather than two.
 *
 * The identity numbers of new persons are keyed by their normalized value
 * rather than by the blind index. These keys never leave this pass, the preview
 * does not compute the index when the register holds no number to match, and
 * the index is a truncated hash, so two different numbers colliding in it would
 * fold two people into one.
 *
 * A row that reaches a person with no number by email or by name does not give
 * them its number, but it does say whose number it is. A later row stating it
 * reaches that person through the earlier row, and does not give it to them
 * either - otherwise a member listed for two apartments, matched by email the
 * first time and by number alone the second, would be created a second time.
 *
 * An ambiguous row writes what the board decided for it, and nothing while it
 * has no decision: the apply will not run until it has one.
 */
interface FileWrites {
  byIdentityNumber: Map<string, FilePerson[]>;
  byEmail: Map<string, FilePerson[]>;
  byApartmentAndName: Map<string, FilePerson[]>;
  /** The same key over every residency written, ended ones included. */
  byApartmentAndNameEver: Map<string, FilePerson[]>;
  /** The register's persons, once looked at, carrying what rows added. */
  registered: Map<string, FilePerson>;
}

interface PersonMatch {
  key: ImportSearchKey | null;
  candidates: readonly FilePerson[];
}

function planRow(
  row: PreparedRow,
  snapshot: RegisterSnapshot,
  defaults: ImportDefaults,
  decisions: ImportDecisions,
  written: FileWrites,
): PlannedRow {
  const values = row.values;
  // First, and alone on its field: a value whose letters are gone also fails
  // the check it was meant for, and saying so twice hides the reason.
  const garbled = refuseGarbledText(values);
  const read: ImportProblem[] = [];

  const name = readName(values, read);
  const apartment = resolveApartment(values, snapshot, read);
  const role = readRole(values, defaults, read);
  const movedInOn = readMovedIn(values, defaults, read);
  const movedOutOn = readMovedOut(values, movedInOn, read);
  const identityNumber = readIdentityNumber(values, read);
  const email = readEmail(values, row, read);
  const garbledFields = new Set(garbled.map(({ field }) => field));
  const problems = [
    ...garbled,
    ...read.filter(({ field }) => !garbledFields.has(field)),
  ];

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
    matchedPersonName: null,
    matchedBy: null,
    foundUnder: null,
    mismatch: null,
    sameAsRowNumber: null,
    candidates: [],
    problems,
  };

  const residency = rowResidency(base);
  if (problems.length > 0 || apartment === null || residency === null) {
    return base;
  }

  const normalizedNumber =
    identityNumber === null
      ? null
      : normalizePersonalIdentityNumber(identityNumber);
  const match = matchPerson(
    row,
    normalizedNumber,
    person,
    apartment,
    snapshot,
    {
      written,
      // A row that states its own move-in date can be about a residency that has
      // since ended, so it is matched against ended residencies as well. One
      // that only carries the file's default is matched against current ones:
      // the default says nothing about when this person lived here.
      includeEnded: residency.movedInStated,
    },
  );
  const mismatch = findMismatch(match, row, normalizedNumber, person, snapshot);
  const [only] = match.candidates;

  if (match.candidates.length > 1 || mismatch !== null) {
    const decision = decisions[String(row.rowNumber)];
    // Named after the person the board chose, as an update is. Reached through
    // a number only an earlier row stated, they are not that number's holder in
    // the register, and the apply must not write it onto them.
    let throughUnwrittenNumber = false;
    if (decision?.action === "create") {
      recordCreated(
        written,
        row,
        person,
        normalizedNumber,
        residency,
        snapshot,
      );
    } else if (decision?.action === "use-person") {
      // A person the row did not match is not recorded: the apply refuses that
      // decision rather than writing it. Nor is one whose residencies the
      // row's would overlap, which the apply refuses as a problem with the row.
      const chosen = match.candidates.find(
        (candidate) => candidate.personId === decision.personId,
      );
      if (chosen !== undefined) {
        throughUnwrittenNumber =
          match.key === "personalIdentityNumber" &&
          chosen.identityNumberFromRow !== null;
        if (!conflictsWith(residency, chosen.residencies)) {
          recordWrites(
            written,
            chosen,
            row,
            normalizedNumber,
            residency,
            snapshot,
          );
        }
      }
    }

    const earlier =
      match.candidates.length === 1 ? (only?.createdByRow ?? null) : null;
    return {
      ...base,
      outcome: "ambiguous",
      matchedBy:
        earlier === null && !throughUnwrittenNumber ? match.key : "earlierRow",
      foundUnder: match.key,
      mismatch,
      sameAsRowNumber: earlier,
      // A person an earlier row creates has no id yet to be chosen by. The
      // board can still make the row a person of its own or leave it out, and
      // either decision holds when the apply meets that person in the register.
      candidates: match.candidates.flatMap((candidate) =>
        candidate.personId === null
          ? []
          : [{ personId: candidate.personId, name: candidate.name }],
      ),
    };
  }

  if (only === undefined) {
    recordCreated(written, row, person, normalizedNumber, residency, snapshot);
    return { ...base, outcome: "create" };
  }

  // A residency already held as the row states it is not written again, which
  // is also what lets a chunk be attempted twice. Any other residency of this
  // person on this apartment that shares a day with the row's would be a
  // second one held at the same time, which a move-in refuses: the board
  // decides which is right rather than the import writing both, or dropping
  // the row without a word.
  if (conflictsWith(residency, only.residencies)) {
    return {
      ...base,
      problems: [{ field: "movedInOn", reason: "residency-conflict" }],
    };
  }

  // A file may list one person twice - two apartments, or one apartment for
  // two periods of time. The second occurrence reaches the same person through
  // what the first one wrote, whether that person already existed or was
  // created by the earlier row.
  recordWrites(written, only, row, normalizedNumber, residency, snapshot);
  // An identity number only an earlier row stated is not the person's in the
  // register, so the row is named after that row and the apply does not write
  // the number now either.
  const throughUnwrittenNumber =
    match.key === "personalIdentityNumber" &&
    only.identityNumberFromRow !== null;
  return {
    ...base,
    outcome: "update",
    matchedPersonId: only.personId,
    matchedPersonName: only.name,
    // Named by the key when it was the identity number, which the person an
    // earlier row creates carries: the row then adds nothing they lack.
    matchedBy:
      throughUnwrittenNumber ||
      (only.personId === null && match.key !== "personalIdentityNumber")
        ? "earlierRow"
        : match.key,
    foundUnder: match.key,
    sameAsRowNumber:
      only.createdByRow ??
      (throughUnwrittenNumber ? only.identityNumberFromRow : null),
  };
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
 * the same one too, as long as it ends when the row says. Read as a residency
 * of its own from the default date, a register imported again without its
 * move-in column would refuse every resident it already holds. A row that
 * ends a residency still open, or keeps one open that has ended, is not that
 * residency: taken as it, the row's end would be dropped without a word.
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
        (!residency.movedInStated &&
          other.movedOutOn === residency.movedOutOn &&
          overlaps(residency, other))),
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

/**
 * The persons a row could be, under the first key in {@link IMPORT_SEARCH_KEYS}
 * that finds anybody. The keys after it are not looked under.
 */
function matchPerson(
  row: PreparedRow,
  identityNumber: string | null,
  person: PlannedPerson,
  apartment: RegisterApartment,
  snapshot: RegisterSnapshot,
  options: { written: FileWrites; includeEnded: boolean },
): PersonMatch {
  const { written } = options;
  const nameKey = apartmentNameKey(
    apartment.id,
    person.firstName,
    person.lastName,
  );
  // Looked up one key at a time, in the constant's order, and stopped at the
  // first that finds anybody: `foundUnder` records which, so the apply can tell
  // a row its locked plan reaches under another key from one it reaches the
  // same way.
  const lookUp: Record<ImportSearchKey, () => FilePerson[]> = {
    personalIdentityNumber: () =>
      candidatesUnder(
        snapshot.personsByIdentityNumber,
        row.identityNumberIndex,
        written.byIdentityNumber,
        identityNumber,
        snapshot,
        written,
      ),
    email: () =>
      candidatesUnder(
        snapshot.personsByEmail,
        row.emailIndex,
        written.byEmail,
        row.emailIndex,
        snapshot,
        written,
      ),
    apartmentAndName: () =>
      candidatesUnder(
        options.includeEnded
          ? snapshot.personsByApartmentAndNameEver
          : snapshot.personsByApartmentAndName,
        nameKey,
        options.includeEnded
          ? written.byApartmentAndNameEver
          : written.byApartmentAndName,
        nameKey,
        snapshot,
        written,
      ),
  };

  for (const key of IMPORT_SEARCH_KEYS) {
    const candidates = lookUp[key]();
    if (candidates.length > 0) {
      return { key, candidates };
    }
  }
  return { key: null, candidates: [] };
}

function candidatesUnder(
  inRegister: ReadonlyMap<string, readonly string[]>,
  registerKey: string | null,
  inFile: ReadonlyMap<string, readonly FilePerson[]>,
  fileKey: string | null,
  snapshot: RegisterSnapshot,
  written: FileWrites,
): FilePerson[] {
  const registered = (
    registerKey === null ? [] : (inRegister.get(registerKey) ?? [])
  ).map((personId) => registeredPerson(personId, snapshot, written));
  const fromFile = fileKey === null ? [] : (inFile.get(fileKey) ?? []);
  return [...new Set([...registered, ...fromFile])];
}

/** One register person, the same object every time it is reached. */
function registeredPerson(
  personId: string,
  snapshot: RegisterSnapshot,
  written: FileWrites,
): FilePerson {
  const known = written.registered.get(personId);
  if (known !== undefined) {
    return known;
  }
  const person: FilePerson = {
    personId,
    createdByRow: null,
    name: snapshot.personNames.get(personId) ?? "",
    identityNumber: null,
    identityNumberFromRow: null,
    hasEmail: snapshot.personsWithEmail.has(personId),
    residencies: [...(snapshot.residenciesByPerson.get(personId) ?? [])],
  };
  written.registered.set(personId, person);
  return person;
}

/** Records the person a row creates, for the rows after it to reach. */
function recordCreated(
  written: FileWrites,
  row: PreparedRow,
  person: PlannedPerson,
  identityNumber: string | null,
  residency: RowResidency,
  snapshot: RegisterSnapshot,
): void {
  const created: FilePerson = {
    personId: null,
    createdByRow: row.rowNumber,
    name: `${person.firstName} ${person.lastName}`,
    identityNumber,
    identityNumberFromRow: null,
    hasEmail: false,
    residencies: [],
  };
  if (identityNumber !== null) {
    push(written.byIdentityNumber, identityNumber, created);
  }
  recordWrites(written, created, row, identityNumber, residency, snapshot);
}

/**
 * Records what the apply will write for a row that reaches this person.
 *
 * The same fields the apply's own rules write: an email address only onto a
 * person who has none, a residency only when the person does not hold it
 * already (see {@link heldAlready}), and no identity number onto anyone who
 * already exists. A residency makes the person findable by apartment and name
 * when it is their first on that apartment, and among current residents when
 * it is current and they held none there that was, as the register snapshot
 * reads them. The row's identity number is recorded too, although it is not
 * written, for the rows after it that state it.
 */
function recordWrites(
  written: FileWrites,
  target: FilePerson,
  row: PreparedRow,
  identityNumber: string | null,
  residency: RowResidency,
  snapshot: RegisterSnapshot,
): void {
  recordIdentityNumber(
    written,
    target,
    identityNumber,
    row.rowNumber,
    snapshot,
  );
  if (!target.hasEmail && row.emailIndex !== null) {
    target.hasEmail = true;
    push(written.byEmail, row.emailIndex, target);
  }
  if (heldAlready(residency, target.residencies) !== undefined) {
    return;
  }
  const onApartment = target.residencies.filter(
    (other) => other.apartmentId === residency.apartmentId,
  );
  target.residencies.push({
    apartmentId: residency.apartmentId,
    role: residency.role,
    movedInOn: residency.movedInOn,
    movedOutOn: residency.movedOutOn,
  });
  const key = apartmentFullNameKey(residency.apartmentId, target.name);
  if (onApartment.length === 0) {
    push(written.byApartmentAndNameEver, key, target);
  }
  if (
    current(residency, snapshot.takenAt) &&
    !onApartment.some((other) => current(other, snapshot.takenAt))
  ) {
    push(written.byApartmentAndName, key, target);
  }
}

/** Whether a residency is still held on the day the snapshot was read. */
function current(residency: RegisterResidency, today: Date): boolean {
  return (
    residency.movedOutOn === null ||
    new Date(`${residency.movedOutOn}T00:00:00.000Z`) > today
  );
}

/**
 * Records the identity number a row states for a person who has none, so a
 * later row stating it reaches them.
 *
 * Only the first number stated for a person counts, as it does for one the
 * file creates: a later row stating another one contradicts them. A person who
 * already has a number keeps it, and a row matched to them by another key with
 * a different one waited for the board.
 */
function recordIdentityNumber(
  written: FileWrites,
  target: FilePerson,
  identityNumber: string | null,
  rowNumber: number,
  snapshot: RegisterSnapshot,
): void {
  if (
    identityNumber === null ||
    target.identityNumber !== null ||
    (target.personId !== null &&
      snapshot.identityNumberIndexByPerson.has(target.personId))
  ) {
    return;
  }
  target.identityNumber = identityNumber;
  target.identityNumberFromRow = rowNumber;
  push(written.byIdentityNumber, identityNumber, target);
}

/**
 * What the row states that contradicts the one person it matched, if anything.
 *
 * An identity-number match is not second-guessed on the name: a person's name
 * changes over a lifetime and their identity number does not. The weaker keys
 * are checked against the identity number whenever both sides have one, and an
 * email match against the name as well, which an apartment-and-name match
 * already agrees on by construction.
 *
 * A register person's number is compared through its blind index. That index is
 * null on the row when the register holds no identity number at all, and then
 * there is nothing for the row to contradict. A person an earlier row creates,
 * or states a number for, is compared by the number that row carries.
 */
function findMismatch(
  match: PersonMatch,
  row: PreparedRow,
  identityNumber: string | null,
  person: PlannedPerson,
  snapshot: RegisterSnapshot,
): ImportMismatch | null {
  const [candidate] = match.candidates;
  if (
    match.candidates.length !== 1 ||
    candidate === undefined ||
    match.key === "personalIdentityNumber"
  ) {
    return null;
  }

  const contradicted =
    (identityNumber !== null &&
      candidate.identityNumber !== null &&
      candidate.identityNumber !== identityNumber) ||
    (candidate.personId !== null &&
      differs(
        row.identityNumberIndex,
        snapshot.identityNumberIndexByPerson.get(candidate.personId),
      ));
  if (contradicted) {
    return "personalIdentityNumber";
  }

  if (
    match.key === "email" &&
    normalizeName(candidate.name) !==
      normalizeName(`${person.firstName} ${person.lastName}`)
  ) {
    return "name";
  }
  return null;
}

/**
 * The first reason the plan cannot be applied with these decisions, if any: a
 * decision for a row that does not need one, an ambiguous row the board has not
 * answered for, or one answered with a person it did not match.
 *
 * A decision is an answer to a row that asks for one, and to nothing else. The
 * apply writes a row that is not ambiguous to whoever it matches, whatever was
 * decided for it, so a row the board chose to skip or to make a new person would
 * update somebody nobody chose. The register can take a row's ambiguity away
 * after the board answered it - a name corrected, a candidate removed - between
 * the preview and the apply, and between two chunks of one apply.
 *
 * A plan of one chunk answers only for its own rows: a decision for a row of
 * another chunk is judged by the plan of that chunk. One for a row the file
 * does not have, of its `rowCount` data rows, is judged by every plan.
 */
export function findUndecided(
  plan: ImportPlan,
  decisions: ImportDecisions,
  rowCount: number,
):
  | "decision-not-needed"
  | "ambiguous-rows-undecided"
  | "decision-not-a-candidate"
  | null {
  const planned = new Map(plan.rows.map((row) => [String(row.rowNumber), row]));
  for (const key of Object.keys(decisions)) {
    const row = planned.get(key);
    const rowNumber = Number(key);
    if (
      row === undefined
        ? !(
            Number.isInteger(rowNumber) &&
            rowNumber >= 1 &&
            rowNumber <= rowCount
          )
        : row.outcome !== "ambiguous"
    ) {
      return "decision-not-needed";
    }
  }

  for (const row of plan.rows) {
    if (row.outcome !== "ambiguous") {
      continue;
    }
    const decision = decisions[String(row.rowNumber)];
    if (decision === undefined) {
      return "ambiguous-rows-undecided";
    }
    if (
      decision.action === "use-person" &&
      !row.candidates.some(
        (candidate) => candidate.personId === decision.personId,
      )
    ) {
      return "decision-not-a-candidate";
    }
  }
  return null;
}

/**
 * The persons the preview listed for each row it asked the board about, as row
 * number to their ids. A person an earlier row of the file creates has no id
 * yet, and is not listed.
 */
export type PreviewedCandidates = Readonly<Record<string, readonly string[]>>;

/**
 * Whether a row the preview asked the board about no longer needs a decision,
 * or now matches other people than the preview listed.
 *
 * The board answered each of those rows by the persons it was shown, and its
 * answer fits that question only. A row it made a new person, planned again
 * after somebody with the row's address was added, matches a person it never
 * chose against, and writing the row would enter that human being a second
 * time. A candidate who has left the register takes away a choice it weighed.
 * Asked when the apply is requested, of the whole file, and again by every
 * chunk of its own rows, because the register keeps changing for as long as
 * the apply runs.
 *
 * @param createdByApply The persons earlier chunks of this apply created. The
 *   preview could list none of them, having no id for a person the file has
 *   not written yet, and a later chunk finds them in the register: they are set
 *   aside rather than taken for somebody new.
 */
export function changedSincePreview(
  plan: ImportPlan,
  previewed: PreviewedCandidates,
  createdByApply: ReadonlySet<string> = new Set(),
): boolean {
  return plan.rows.some((row) => {
    const listed = previewed[String(row.rowNumber)];
    if (listed === undefined) {
      return false;
    }
    if (row.outcome !== "ambiguous") {
      return true;
    }
    const found = row.candidates.flatMap(({ personId }) =>
      createdByApply.has(personId) ? [] : [personId],
    );
    return !samePeople(listed, found);
  });
}

/** The rows the preview asked about, read back from the session. */
export function readPreviewedCandidates(value: unknown): PreviewedCandidates {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const rows: Record<string, string[]> = {};
  for (const [rowNumber, candidates] of Object.entries(value)) {
    if (Array.isArray(candidates)) {
      rows[rowNumber] = candidates.filter(
        (candidate): candidate is string => typeof candidate === "string",
      );
    }
  }
  return rows;
}

/** Whether two lists of person ids name the same people. */
function samePeople(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((personId) => b.includes(personId));
}

function differs(row: string | null, registered: string | undefined): boolean {
  return row !== null && registered !== undefined && registered !== row;
}

/** Adds a value to the list a key holds, starting the list if need be. */
export function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

/**
 * U+FFFD, the character a decoder writes where it could not read a byte.
 *
 * Written as an escape: the character itself is invisible in some editors and
 * indistinguishable from a question mark in others.
 */
const REPLACEMENT_CHARACTER = "\uFFFD";

/**
 * Refuses a value that has already lost characters.
 *
 * The upload decodes Windows-1252 as well as UTF-8, so this is no longer what a
 * Swedish Excel file produces. It is what a file produces that went through a
 * wrong decode before it reached this instance - exported from another system,
 * opened and saved again - and the letters are gone from the bytes themselves.
 * Imported, "Bj\uFFFDrk" would be written into a member register the database
 * will not let anyone update, so the row is refused and the board sees why.
 */
function refuseGarbledText(
  values: Partial<Record<ImportField, string>>,
): ImportProblem[] {
  const problems: ImportProblem[] = [];
  // A Partial record may still hold a key whose value is undefined.
  for (const [field, value] of Object.entries(values) as [
    ImportField,
    string | undefined,
  ][]) {
    if (value?.includes(REPLACEMENT_CHARACTER) === true) {
      problems.push({ field, reason: "garbled-characters" });
    }
  }
  return problems;
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
