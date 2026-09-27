import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Injectable } from "@nestjs/common";
import { formatDayOfInstant, localDayOf } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Prisma } from "../generated/prisma/client";
import type { AuditChannel } from "../generated/prisma/enums";
import { PluginLoaderService } from "../plugins/plugin-loader.service";
import { boardSeatHeldOn, residencyHeldOn } from "../registers/held-on";
import { apiPackageDirectory, platformVersion } from "../version";
import {
  MANAGEMENT_SUMMARY_SCHEMA,
  type ManagementSummary,
} from "./management-summary";

/**
 * The channels a person acts through.
 *
 * What the board's activity and the extract counts are read from, named rather
 * than derived by leaving some out, so a channel added later counts for
 * nothing until somebody decides it should. SYSTEM is the instance's own
 * clock, and MANAGEMENT is this document being read: a trial kept alive by the
 * nightly jobs, or by the host asking whether it is alive, would be kept alive
 * by nobody. An entry with no channel was written before the log recorded one,
 * by a person as often as not, and counts.
 */
const PERSON_CHANNELS: readonly AuditChannel[] = ["WEB", "MCP", "AI", "PLUGIN"];

const THROUGH_A_PERSON_CHANNEL: Prisma.AuditLogEntryWhereInput = {
  OR: [{ channel: { in: [...PERSON_CHANNELS] } }, { channel: null }],
};

interface MigrationRow {
  migration_name: string;
  finished: boolean;
  rolled_back: boolean;
}

interface SizeRow {
  databaseBytes: bigint | number | string;
  storedFileBytes: bigint | number | string;
}

/**
 * Builds the management API's document (ADR 0021): counts about the
 * association, one day and the version, never anything about a person.
 *
 * One transaction, through AuditLogService.withAuditedRead, so the document
 * and the entry recording that it was read share a fate: a read that fails
 * part way writes no entry, and an entry that cannot be written returns no
 * document. The entry is the only thing written. Nothing here calls a service
 * that writes, and the listener that serves this answers one GET.
 *
 * The register is counted from its own tables, and deliberately not through
 * PluginAddressBookService.summary or AddressBookService.stats. The first
 * leaves out persons with protected personal data and with a restriction of
 * processing, and the second counts what its viewer may see, which for a
 * resident leaves out the protected. Both are right for what they serve and
 * wrong here: a protected member is a member, their apartment is billed like
 * any other, and the register's size is the number of people in it.
 */
@Injectable()
export class ManagementSummaryService {
  /**
   * The migrations this image carries, by folder name.
   *
   * Listed once, when the application is built: the image cannot gain a
   * migration while it runs, and the answer is what a pending count compares
   * the database against.
   */
  private readonly shipped: readonly string[];

  constructor(
    private readonly audit: AuditLogService,
    private readonly plugins: PluginLoaderService,
  ) {
    this.shipped = shippedMigrations(
      join(apiPackageDirectory(), "prisma", "migrations"),
    );
  }

  /** The summary, and its entry in the audit log. */
  async read(): Promise<ManagementSummary> {
    const platform = platformVersion();

    return this.audit.withAuditedRead(
      {
        action: "INSTANCE_SUMMARY_READ",
        channel: "MANAGEMENT",
        context: { schema: MANAGEMENT_SUMMARY_SCHEMA },
      },
      async (tx) => {
        const now = new Date();
        const today = localDayOf(now);
        const heldToday = residencyHeldOn(today);
        const seatToday = boardSeatHeldOn(today);

        const association = await tx.association.findUnique({
          where: { id: 1 },
          select: { setupCompletedAt: true },
        });
        const apartments = await tx.apartment.count();
        const persons = await tx.person.count();
        const members = await tx.person.count({
          where: { residencies: { some: { ...heldToday, role: "MEMBER" } } },
        });
        const residents = await tx.person.count({
          where: { residencies: { some: heldToday } },
        });
        const boardSeats = await tx.boardPosition.count({ where: seatToday });
        const administrators = await tx.systemRole.count({
          where: { role: "ADMIN" },
        });

        /*
         * A resident who has been asked in: an account, which exists only by
         * setup or by an accepted invitation, or an invitation still open. The
         * board and every system role holder are left out, because the
         * question is whether anybody beyond the people running the
         * association has been invited, and setup's administrator holds a role.
         */
        const invitedResidents = await tx.person.count({
          where: {
            residencies: { some: heldToday },
            boardPositions: { none: seatToday },
            systemRoles: { none: {} },
            OR: [
              { userAccount: { isNot: null } },
              {
                invitations: {
                  some: { acceptedAt: null, expiresAt: { gt: now } },
                },
              },
            ],
          },
        });

        const boardActivityOn = await latestBoardActivity(tx, seatToday);

        const memberRegister = await tx.auditLogEntry.count({
          where: {
            action: "MEMBER_REGISTER_EXTRACT_GENERATED",
            ...THROUGH_A_PERSON_CHANNEL,
          },
        });
        const apartmentRegister = await tx.auditLogEntry.count({
          where: {
            action: "APARTMENT_REGISTER_EXTRACT_GENERATED",
            ...THROUGH_A_PERSON_CHANNEL,
          },
        });

        const [sizes] = await tx.$queryRaw<SizeRow[]>`
          SELECT pg_database_size(current_database()) AS "databaseBytes",
                 (SELECT COALESCE(SUM("byteSize"), 0) FROM media_file)
                   AS "storedFileBytes"`;

        return {
          schema: MANAGEMENT_SUMMARY_SCHEMA,
          version: platform.version,
          revision: platform.revision,
          migrations: migrationState(
            this.shipped,
            await tx.$queryRaw<MigrationRow[]>`
              SELECT migration_name,
                     finished_at IS NOT NULL AS finished,
                     rolled_back_at IS NOT NULL AS rolled_back
                FROM _prisma_migrations`,
          ),
          claimed: (association?.setupCompletedAt ?? null) !== null,
          apartments,
          register: {
            persons,
            members,
            residents,
            boardSeats,
            administrators,
          },
          invitedResidents,
          boardActivityOn,
          registerExtracts: { memberRegister, apartmentRegister },
          storage: {
            storedFileBytes: Number(sizes?.storedFileBytes ?? 0),
            databaseBytes: Number(sizes?.databaseBytes ?? 0),
          },
          health: {
            database: "ok",
            pluginFindings: this.plugins.report().length,
          },
        };
      },
    );
  }
}

/**
 * The latest day somebody running the association did something, or null.
 *
 * Two sources, because neither answers alone. A session is renewed at most
 * once a day while it is used, but it is deleted on sign-out and when it is
 * presented after it expired, so it forgets. The audit log never forgets, but
 * it records writes and sensitive reads rather than every visit. Their later
 * answers "active in the last thirty days", which is what the trial rule asks.
 *
 * Whoever holds a seat or ADMIN today, whatever they held when they acted: the
 * question is whether the association's present board is using the instance.
 */
async function latestBoardActivity(
  tx: Prisma.TransactionClient,
  seatToday: Prisma.BoardPositionWhereInput,
): Promise<string | null> {
  const runningTheAssociation: Prisma.PersonWhereInput = {
    OR: [
      { boardPositions: { some: seatToday } },
      { systemRoles: { some: { role: "ADMIN" } } },
    ],
  };

  const session = await tx.session.aggregate({
    where: { user: { person: runningTheAssociation } },
    _max: { updatedAt: true },
  });

  // The log names its actor in a plain column rather than a relation, so the
  // people are read first. Their ids stay here; the document carries a day.
  const people = await tx.person.findMany({
    where: runningTheAssociation,
    select: { id: true },
  });
  const entry =
    people.length === 0
      ? null
      : await tx.auditLogEntry.aggregate({
          where: {
            actorPersonId: { in: people.map((person) => person.id) },
            ...THROUGH_A_PERSON_CHANNEL,
          },
          _max: { createdAt: true },
        });

  const instants = [session._max.updatedAt, entry?._max.createdAt ?? null]
    .filter((instant): instant is Date => instant !== null)
    .map((instant) => instant.getTime());
  if (instants.length === 0) {
    return null;
  }
  return formatDayOfInstant(new Date(Math.max(...instants)));
}

/**
 * The migrations a directory holds: every folder with a migration.sql, which
 * is what `prisma migrate deploy` applies, in name order.
 */
function shippedMigrations(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(directory, entry.name, "migration.sql")),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * The state of the migrations, from what the image carries and what the
 * database recorded.
 *
 * A row that finished and was not rolled back is applied. A row that neither
 * finished nor was rolled back is a migration that failed part way, which
 * makes every later `migrate deploy` refuse until somebody resolves it. A
 * rolled-back row is history and counts as neither.
 */
function migrationState(
  shipped: readonly string[],
  rows: readonly MigrationRow[],
): ManagementSummary["migrations"] {
  const applied = rows
    .filter((row) => row.finished && !row.rolled_back)
    .map((row) => row.migration_name)
    .sort();
  const failed = rows.filter((row) => !row.finished && !row.rolled_back);
  const appliedNames = new Set(applied);
  return {
    shipped: shipped.length,
    applied: applied.length,
    failed: failed.length,
    pending: shipped.filter((name) => !appliedNames.has(name)).length,
    latest: applied.at(-1) ?? null,
  };
}
