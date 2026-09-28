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
  /** Key from {@link apartmentNameKey}. */
  personsByApartmentAndName: ReadonlyMap<string, readonly string[]>;
  personNames: ReadonlyMap<string, string>;
  /** Blind index of each person's identity number, for those that have one. */
  identityNumberIndexByPerson: ReadonlyMap<string, string>;
  /** Persons with an email address stored, indexed or not. */
  personsWithEmail: ReadonlySet<string>;
  /** Every apartment each person has a residency in, past ones included. */
  apartmentsByPerson: ReadonlyMap<string, ReadonlySet<string>>;
  /** When the snapshot was read: a residency counts as current until then. */
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
  movedOutOn: string | null;
  /** The existing person this row will be written against. */
  matchedPersonId: string | null;
  /** Their name as the register holds it, so the board can see who it is. */
  matchedPersonName: string | null;
  matchedBy: ImportMatchKey | null;
  /**
   * Why a row that matched one person still waits for a decision. Null when it
   * is ambiguous because it matched several, and on every other outcome.
   */
  mismatch: ImportMismatch | null;
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

/** What the board answered for a row the plan could not resolve. */
export type ImportDecision =
  | { action: "use-person"; personId: string }
  | { action: "create" }
  | { action: "skip" };

/** Keyed by the row's number in the file, as a string. */
export type ImportDecisions = Record<string, ImportDecision>;

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
 */
export function planImport(
  rows: readonly PreparedRow[],
  snapshot: RegisterSnapshot,
  defaults: ImportDefaults,
  decisions: ImportDecisions = {},
): ImportPlan {
  const written: FileWrites = {
    byIdentityNumber: new Map(),
    byEmail: new Map(),
    byApartmentAndName: new Map(),
    registered: new Map(),
  };

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
   * The normalized number of a person the file creates. A person the register
   * already holds is compared through their blind index instead, and an import
   * never gives them a number they did not have.
   */
  identityNumber: string | null;
  hasEmail: boolean;
  apartmentIds: Set<string>;
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
 * An ambiguous row writes what the board decided for it, and nothing while it
 * has no decision: the apply will not run until it has one.
 */
interface FileWrites {
  byIdentityNumber: Map<string, FilePerson[]>;
  byEmail: Map<string, FilePerson[]>;
  byApartmentAndName: Map<string, FilePerson[]>;
  /** The register's persons, once looked at, carrying what rows added. */
  registered: Map<string, FilePerson>;
}

interface PersonMatch {
  key: ImportMatchKey | null;
  candidates: readonly FilePerson[];
}

function planRow(
  row: PreparedRow,
  snapshot: RegisterSnapshot,
  defaults: ImportDefaults,
  decisions: ImportDecisions,
  written: FileWrites,
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
    movedOutOn,
    matchedPersonId: null,
    matchedPersonName: null,
    matchedBy: null,
    mismatch: null,
    sameAsRowNumber: null,
    candidates: [],
    problems,
  };

  if (problems.length > 0 || apartment === null) {
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
    written,
  );
  const mismatch = findMismatch(match, row, normalizedNumber, person, snapshot);
  const [only] = match.candidates;

  if (match.candidates.length > 1 || mismatch !== null) {
    const decision = decisions[String(row.rowNumber)];
    if (decision?.action === "create") {
      recordCreated(
        written,
        row,
        person,
        normalizedNumber,
        apartment,
        movedOutOn,
        snapshot,
      );
    } else if (decision?.action === "use-person") {
      // A person the row did not match is not recorded: the apply refuses that
      // decision rather than writing it.
      const chosen = match.candidates.find(
        (candidate) => candidate.personId === decision.personId,
      );
      if (chosen !== undefined) {
        recordWrites(written, chosen, row, apartment, movedOutOn, snapshot);
      }
    }

    const earlier =
      match.candidates.length === 1 ? (only?.createdByRow ?? null) : null;
    return {
      ...base,
      outcome: "ambiguous",
      matchedBy: earlier === null ? match.key : "earlierRow",
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
    recordCreated(
      written,
      row,
      person,
      normalizedNumber,
      apartment,
      movedOutOn,
      snapshot,
    );
    return { ...base, outcome: "create" };
  }

  // A file may list one person twice - two apartments, or a member and their
  // own resident row. The second occurrence reaches the same person through
  // what the first one wrote, whether that person already existed or was
  // created by the earlier row.
  recordWrites(written, only, row, apartment, movedOutOn, snapshot);
  return {
    ...base,
    outcome: "update",
    matchedPersonId: only.personId,
    matchedPersonName: only.personId === null ? null : only.name,
    // Named by the key when it was the identity number, which the person an
    // earlier row creates carries: the row then adds nothing they lack.
    matchedBy:
      only.personId === null && match.key !== "personalIdentityNumber"
        ? "earlierRow"
        : match.key,
    sameAsRowNumber: only.createdByRow,
  };
}

function matchPerson(
  row: PreparedRow,
  identityNumber: string | null,
  person: PlannedPerson,
  apartment: RegisterApartment,
  snapshot: RegisterSnapshot,
  written: FileWrites,
): PersonMatch {
  const byNumber = candidatesUnder(
    snapshot.personsByIdentityNumber,
    row.identityNumberIndex,
    written.byIdentityNumber,
    identityNumber,
    snapshot,
    written,
  );
  if (byNumber.length > 0) {
    return { key: "personalIdentityNumber", candidates: byNumber };
  }

  const byEmail = candidatesUnder(
    snapshot.personsByEmail,
    row.emailIndex,
    written.byEmail,
    row.emailIndex,
    snapshot,
    written,
  );
  if (byEmail.length > 0) {
    return { key: "email", candidates: byEmail };
  }

  const nameKey = apartmentNameKey(
    apartment.id,
    person.firstName,
    person.lastName,
  );
  const byName = candidatesUnder(
    snapshot.personsByApartmentAndName,
    nameKey,
    written.byApartmentAndName,
    nameKey,
    snapshot,
    written,
  );
  if (byName.length > 0) {
    return { key: "apartmentAndName", candidates: byName };
  }

  return { key: null, candidates: [] };
}

/** The register's persons under one key and the file's, each person once. */
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
    hasEmail: snapshot.personsWithEmail.has(personId),
    apartmentIds: new Set(snapshot.apartmentsByPerson.get(personId)),
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
  apartment: RegisterApartment,
  movedOutOn: string | null,
  snapshot: RegisterSnapshot,
): void {
  const created: FilePerson = {
    personId: null,
    createdByRow: row.rowNumber,
    name: `${person.firstName} ${person.lastName}`,
    identityNumber,
    hasEmail: false,
    apartmentIds: new Set(),
  };
  if (identityNumber !== null) {
    push(written.byIdentityNumber, identityNumber, created);
  }
  recordWrites(written, created, row, apartment, movedOutOn, snapshot);
}

/**
 * Records what the apply will write for a row that reaches this person.
 *
 * The same fields the apply's own rules write: an email address only onto a
 * person who has none, a residency only in an apartment the person has never
 * had one in, and no identity number onto anyone who already exists. The
 * residency is findable by apartment and name only while it is current, as the
 * register snapshot reads it.
 */
function recordWrites(
  written: FileWrites,
  target: FilePerson,
  row: PreparedRow,
  apartment: RegisterApartment,
  movedOutOn: string | null,
  snapshot: RegisterSnapshot,
): void {
  if (!target.hasEmail && row.emailIndex !== null) {
    target.hasEmail = true;
    push(written.byEmail, row.emailIndex, target);
  }
  if (!target.apartmentIds.has(apartment.id)) {
    target.apartmentIds.add(apartment.id);
    if (
      movedOutOn === null ||
      new Date(`${movedOutOn}T00:00:00.000Z`) > snapshot.takenAt
    ) {
      push(
        written.byApartmentAndName,
        apartmentFullNameKey(apartment.id, target.name),
        target,
      );
    }
  }
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
 * there is nothing for the row to contradict. A person an earlier row creates is
 * compared by the number that row carries.
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
    candidate.personId === null
      ? identityNumber !== null &&
        candidate.identityNumber !== null &&
        candidate.identityNumber !== identityNumber
      : differs(
          row.identityNumberIndex,
          snapshot.identityNumberIndexByPerson.get(candidate.personId),
        );
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
 * The first reason the plan cannot be applied with these decisions, if any: an
 * ambiguous row the board has not answered for, or one answered with a person
 * it did not match.
 */
export function findUndecided(
  plan: ImportPlan,
  decisions: ImportDecisions,
): "ambiguous-rows-undecided" | "decision-not-a-candidate" | null {
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

function differs(row: string | null, registered: string | undefined): boolean {
  return row !== null && registered !== undefined && registered !== row;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
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
  const raw = values.movedInOn;
  if (raw === undefined) {
    if (defaults.defaultMovedInOn !== null) {
      return defaults.defaultMovedInOn;
    }
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
