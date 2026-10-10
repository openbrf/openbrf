import { Injectable } from "@nestjs/common";
import { dateColumnOf, formatDateColumn, localDayOf } from "@openbrf/shared";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { normalizePersonalIdentityNumber } from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { hasMovedOut } from "../registers/held-on";
import { ImportError } from "./import-errors";
import { type ImportMapping, validateMapping } from "./import-columns";
import {
  apartmentNameKey,
  hasIndexableIdentityNumber,
  type ImportDecisions,
  type ImportPlan,
  type ImportRole,
  planImport,
  type PreparedRow,
  push,
  readRow,
  type RegisterResidency,
  type RegisterSnapshot,
  type UnwrittenIdentityNumber,
} from "./import-plan";

/**
 * Working out what an import would do, for the preview and the apply alike.
 *
 * Both callers plan through this one service so the rows a board approved and
 * the rows a worker writes are decided by the same code. The difference between
 * them is only how much of the file is planned at once: the preview plans all of
 * it, and the apply plans one chunk at a time against a register that already
 * holds what the previous chunk wrote.
 */

/**
 * Blind indexes computed for one unit of work.
 *
 * Keyed by the normalized personal identity number rather than by a hash of it.
 * A hash would look like a protection it is not: the value space of a personal
 * identity number is small enough to reverse by brute force, and the uploaded
 * rows are decrypted in this same process while the work runs anyway. What keeps
 * the exposure bounded is the lifetime - the map is created by the caller for
 * one unit of work and is gone when that unit ends, so nothing derived from an
 * identity number outlives the preview job or the chunk that needed it.
 *
 * It exists because the apply needs each index twice: once to match the row
 * against the register, once to write the person. At 43.8 ms a value that is the
 * difference between one pass and two.
 */
export type IdentityIndexCache = Map<string, string>;

export interface ImportPlanRequest {
  /** The file's data rows, decrypted, header excluded. */
  rows: readonly string[][];
  /** The header's width, so a mapping that does not fit the file is refused. */
  columnCount: number;
  mapping: ImportMapping;
  defaultRole: ImportRole | null;
  defaultMovedInOn: string | null;
  /**
   * The rows to plan, as a 0-based half-open window. The whole file when
   * absent. Row numbers stay absolute either way: a decision the board made
   * names a row of the file, not a row of a chunk.
   */
  window?: { from: number; count: number };
  /**
   * What the board decided for the rows that need it, so the rows after one
   * are matched against what it writes. None when absent.
   */
  decisions?: ImportDecisions;
  /**
   * The rows of earlier chunks whose identity number the apply did not write,
   * and the person it wrote each of them to. The number is read from the row
   * again, so a later row stating it reaches that person. None when absent.
   */
  unwrittenIdentityNumbers?: ReadonlyMap<number, string>;
  /**
   * Whether every valid identity number is indexed.
   *
   * The apply sets this: a person it writes carries the index, so the cost is
   * owed whatever the register looks like. The preview does not, because an
   * index is only worth 43.8 ms when there is something to match it against -
   * and a lookup in an empty map cannot hit. A first import into a register
   * that holds no identity numbers therefore previews without touching
   * Argon2id at all, which is the import every cooperative starts with.
   */
  indexEveryIdentityNumber: boolean;
  indexes: IdentityIndexCache;
  /**
   * Told how many rows of the window have been prepared, after each one. The
   * preview job reports its progress through this, and stops through it as
   * well: a report that throws ends the plan where it is, which is how a job
   * planning a preview somebody has since replaced lets go of its worker.
   */
  onRowPrepared?: (rowsPrepared: number) => Promise<void>;
  /**
   * The transaction to read the register through. The apply plans a chunk a
   * second time inside the transaction that writes it, under the import lock,
   * so the register it plans against is the one it writes into.
   */
  db?: Prisma.TransactionClient;
}

@Injectable()
export class ImportPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /** The uploaded rows, as they were read from the file. */
  async decryptRows(rowsCipher: string): Promise<string[][]> {
    return JSON.parse(
      await this.encryption.decrypt("importSession.rows", rowsCipher),
    ) as string[][];
  }

  async plan(request: ImportPlanRequest): Promise<ImportPlan> {
    assertMappingApplies(request);

    const from = request.window?.from ?? 0;
    const to =
      request.window === undefined
        ? request.rows.length
        : Math.min(request.rows.length, from + request.window.count);

    // Loaded before the rows are prepared, because whether an identity number
    // is worth indexing depends on whether the register holds one to match.
    const snapshot = await this.snapshot(request.db ?? this.prisma);
    const indexIdentityNumbers =
      request.indexEveryIdentityNumber ||
      snapshot.personsByIdentityNumber.size > 0;

    const prepared: PreparedRow[] = [];
    for (let index = from; index < to; index++) {
      const values = readRow(request.rows[index] ?? [], request.mapping);
      prepared.push({
        rowNumber: index + 1,
        values,
        identityNumberIndex:
          indexIdentityNumbers && hasIndexableIdentityNumber(values)
            ? await this.identityNumberIndex(
                values.personalIdentityNumber ?? "",
                request.indexes,
              )
            : null,
        emailIndex:
          values.email === undefined
            ? null
            : await this.encryption.computeIndex("person.email", values.email),
      });
      await request.onRowPrepared?.(prepared.length);
    }

    return planImport(
      prepared,
      snapshot,
      {
        defaultRole: request.defaultRole,
        defaultMovedInOn: request.defaultMovedInOn,
      },
      request.decisions,
      unwrittenIdentityNumbers(request),
    );
  }

  /**
   * The blind index of one identity number, computed at most once per unit of
   * work.
   */
  async identityNumberIndex(
    value: string,
    indexes: IdentityIndexCache,
  ): Promise<string | null> {
    const normalized = normalizePersonalIdentityNumber(value);
    if (normalized === null) {
      return null;
    }

    const cached = indexes.get(normalized);
    if (cached !== undefined) {
      return cached;
    }

    const index = await this.encryption.computeIndex(
      "person.personalIdentityNumber",
      value,
    );
    if (index !== null) {
      indexes.set(normalized, index);
    }
    return index;
  }

  /**
   * The register as matching needs to see it.
   *
   * Loaded whole rather than queried per row: a per-row lookup on a two hundred
   * row file is two hundred round trips, and the register of one housing
   * cooperative is small enough to hold in memory. Only the columns matching
   * needs are read - no ciphertext leaves the database here.
   *
   * Read again for every chunk, and that is the point: a chunk plans against a
   * register that already holds what the chunk before it wrote, so a person
   * listed twice in one file is matched the second time rather than created
   * twice. The plan reproduces those writes for the rows of one pass, which is
   * why the snapshot also carries what decides them: who has an email address
   * and every residency each person has held.
   */
  private async snapshot(
    db: Prisma.TransactionClient,
  ): Promise<RegisterSnapshot> {
    // Today as the date column holds it (ADR 0013): a move-out date is a day,
    // and compared with a moment it would end a residency hours early.
    const now = new Date();
    const today = dateColumnOf(localDayOf(now));

    // One after the other: a transaction is one connection, and runs one query
    // at a time however the calls are awaited.
    const apartments = await db.apartment.findMany({
      select: {
        id: true,
        number: true,
        addressId: true,
        address: { select: { street: true, number: true } },
      },
    });
    const persons = await db.person.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailIndex: true,
        personalIdentityNumberIndex: true,
        residencies: {
          select: {
            apartmentId: true,
            role: true,
            movedInOn: true,
            movedOutOn: true,
          },
        },
      },
    });
    // Whether a person has an address at all, which decides whether a row
    // matched to them gives them one. Asked of the database rather than read
    // off the ciphertext, which has no business in this process here.
    const withEmail = await db.person.findMany({
      where: { emailCipher: { not: null } },
      select: { id: true },
    });

    const personsByIdentityNumber = new Map<string, string[]>();
    const personsByEmail = new Map<string, string[]>();
    const personsByApartmentAndName = new Map<string, string[]>();
    const personsByApartmentAndNameEver = new Map<string, string[]>();
    const residenciesByPerson = new Map<string, RegisterResidency[]>();
    const personNames = new Map<string, string>();
    const identityNumberIndexByPerson = new Map<string, string>();

    for (const person of persons) {
      personNames.set(
        person.id,
        `${person.firstName} ${person.lastName}`.trim(),
      );
      if (person.personalIdentityNumberIndex !== null) {
        identityNumberIndexByPerson.set(
          person.id,
          person.personalIdentityNumberIndex,
        );
        push(
          personsByIdentityNumber,
          person.personalIdentityNumberIndex,
          person.id,
        );
      }
      if (person.emailIndex !== null) {
        push(personsByEmail, person.emailIndex, person.id);
      }
      const held: RegisterResidency[] = [];
      for (const residency of person.residencies) {
        const key = apartmentNameKey(
          residency.apartmentId,
          person.firstName,
          person.lastName,
        );
        if (!hasMovedOut(residency.movedOutOn, now)) {
          push(personsByApartmentAndName, key, person.id);
        }
        // Once per person and key: a person who moved out and back in is
        // still one candidate, not two.
        if (
          !(personsByApartmentAndNameEver.get(key) ?? []).includes(person.id)
        ) {
          push(personsByApartmentAndNameEver, key, person.id);
        }
        held.push(registerResidency(residency));
      }
      residenciesByPerson.set(person.id, held);
    }

    return {
      apartments: apartments.map((apartment) => ({
        id: apartment.id,
        number: apartment.number,
        addressId: apartment.addressId,
        addressLabel: `${apartment.address.street} ${apartment.address.number}`,
      })),
      personsByIdentityNumber,
      personsByEmail,
      personsByApartmentAndName,
      personsByApartmentAndNameEver,
      personNames,
      identityNumberIndexByPerson,
      personsWithEmail: new Set(withEmail.map((person) => person.id)),
      residenciesByPerson,
      takenAt: today,
    };
  }
}

/** The numbers earlier rows stated and the apply did not write, in file order. */
function unwrittenIdentityNumbers(
  request: ImportPlanRequest,
): UnwrittenIdentityNumber[] {
  const unwritten: UnwrittenIdentityNumber[] = [];
  const earlier = [...(request.unwrittenIdentityNumbers ?? [])].sort(
    ([a], [b]) => a - b,
  );
  for (const [rowNumber, personId] of earlier) {
    const values = readRow(request.rows[rowNumber - 1] ?? [], request.mapping);
    const identityNumber = hasIndexableIdentityNumber(values)
      ? normalizePersonalIdentityNumber(values.personalIdentityNumber ?? "")
      : null;
    if (identityNumber !== null) {
      unwritten.push({ rowNumber, identityNumber, personId });
    }
  }
  return unwritten;
}

/**
 * Refuses a mapping that cannot be applied to the file.
 *
 * Exported for the preview request, which checks the mapping before it queues
 * anything: a mapping problem is the board's to fix on the screen it is on, and
 * finding one costs nothing.
 */
export function assertMappingApplies(
  request: Pick<
    ImportPlanRequest,
    "mapping" | "columnCount" | "defaultRole" | "defaultMovedInOn"
  >,
): void {
  const mappingProblems = validateMapping({
    mapping: request.mapping,
    columnCount: request.columnCount,
    defaultRole: request.defaultRole,
    defaultMovedInOn: request.defaultMovedInOn,
  });
  if (mappingProblems.length > 0) {
    throw new ImportError(
      `The mapping cannot be applied: ${mappingProblems.join(", ")}.`,
      "mapping-invalid",
    );
  }
}

/** A stored residency with its dates as the calendar dates a plan compares. */
export function registerResidency(residency: {
  apartmentId: string;
  role: ImportRole;
  movedInOn: Date;
  movedOutOn: Date | null;
}): RegisterResidency {
  return {
    apartmentId: residency.apartmentId,
    role: residency.role,
    movedInOn: formatDateColumn(residency.movedInOn),
    movedOutOn: formatDateColumn(residency.movedOutOn),
  };
}
