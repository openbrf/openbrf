import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { dateColumnOf, localDayOf } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import {
  pluginRecordsErasedOnRequest,
  remainingRunBound,
} from "../retention/erasure-domains";
import { lockErasureEligibility } from "../retention/erasure-lock";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  erasureRequestedPersonIds,
  isErasureInForce,
  isPersonWithheld,
  withheldPersonIds,
} from "../retention/withheld-persons";

/** Queue the nightly purge of plugins' records about a person runs on. */
export const PLUGIN_RECORDS_PURGE_QUEUE = "plugin-records-purge";

/**
 * When it runs: after the feed's purge and before the service-data purge,
 * which closes the granted erasure requests this job reads.
 * `retention/erasure-request-order.spec.ts` fails for any job that reads the
 * request and is scheduled at or after the job that closes it.
 */
const PURGE_CRON = "50 3 * * *";

/**
 * The most people one run erases the records of, for the reason every purge
 * has one (`events/event-signup-purge.service.ts`). The people a granted
 * erasure request names are taken first and are not cut by it.
 */
const MAX_PERSONS_PER_RUN = 500;

export interface PluginRecordsPurgeRunSummary {
  /** People the scan found records to erase for. */
  considered: number;
  /** People whose records were erased. */
  purged: number;
  /** Records deleted across all of them, live and set aside. */
  recordsDeleted: number;
  /** People whose purge threw. The run carries on past them. */
  failed: number;
}

/**
 * The purge of plugins' records about a person (ADR 0047), across every
 * plugin, installed, switched off or removed.
 *
 * ## What it erases
 *
 * Every record whose erase date has come, and every record about a person a
 * granted erasure request names, whatever its date: the live row and every row
 * set aside under its key alike. The erase date is the retention rule itself,
 * stated by the plugin on each record within the bound its manifest declares,
 * so the host can apply it without the plugin's code - which is the point. A
 * plugin switched off refuses every host service, one that failed to load runs
 * nothing and a removed one has no code, and none of the three stops this.
 *
 * A record of `host.records` names nobody and has no erase date, so it is never
 * selected.
 *
 * ## Legal hold and restriction
 *
 * A person under either is skipped, in the scan and again inside the
 * transaction that deletes, under the person's legal hold key, for the reason
 * `events/event-signup-purge.service.ts` gives. Their records stay, the set
 * aside ones with them, and each goes on the first run past its own erase date
 * once the hold or the restriction has ended.
 *
 * ## The log
 *
 * One `PLUGIN_RECORDS_PURGED` entry per run that erased anything, with counts
 * per plugin and collection and no person: the core's own domains write an
 * entry per person, and a plugin's collection name beside a person's id would
 * be a record, kept for good, of which module somebody used. What reaches a
 * person's access report is the closing job's entry, which names this domain
 * among those it verified empty.
 *
 * ## The closing job
 *
 * `pluginRecords` is in `ERASURE_DOMAINS`, with the expression this job
 * deletes by on a granted request, so the service-data purge counts what is
 * left for the person before it closes the request.
 */
@Injectable()
export class PluginRecordsPurgeService implements OnModuleInit {
  private readonly logger = new Logger(PluginRecordsPurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(PLUGIN_RECORDS_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(PLUGIN_RECORDS_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every record whose day has come, and every record a granted
   * erasure request reaches, person by person.
   *
   * @param now The moment to judge at, on the association's calendar.
   */
  async run(now: Date = new Date()): Promise<PluginRecordsPurgeRunSummary> {
    const personIds = await this.eligible(now);

    let purged = 0;
    let recordsDeleted = 0;
    let failed = 0;
    const counts = new Map<string, number>();
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now);
        let total = 0;
        for (const { pluginId, collection, records } of deleted) {
          const label = `${pluginId}/${collection}`;
          counts.set(label, (counts.get(label) ?? 0) + records);
          total += records;
        }
        if (total > 0) {
          purged += 1;
          recordsDeleted += total;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding, as every purge logs it (ADR 0007).
        failed += 1;
        this.logger.error(
          `Plugin records purge failed for person ${personId}: ${failureName(
            error,
          )}`,
        );
      }
    }

    if (recordsDeleted > 0) {
      await this.audit.record({
        action: "PLUGIN_RECORDS_PURGED",
        channel: "SYSTEM",
        // Nobody clicked this: dates arrived, or a request the board granted.
        actorPersonId: null,
        targetKind: "pluginRecords",
        context: {
          records: recordsDeleted,
          collections: Object.fromEntries(
            [...counts.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        },
      });
    }
    if (recordsDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(recordsDeleted)} plugin records for ${String(
          purged,
        )} of ${String(personIds.length)} eligible persons`,
      );
    }
    if (personIds.length >= MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Plugin records purge reached its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )} people. Everybody a granted erasure request names was taken ` +
          "first, so what waits for a later run is people on their erase " +
          "dates alone.",
      );
    }

    return { considered: personIds.length, purged, recordsDeleted, failed };
  }

  /**
   * The people with at least one record to erase: those a granted erasure
   * request names first, then those with a record whose day has come, leaving
   * out anybody under a hold or a restriction in the query itself so they
   * cannot spend the bound.
   */
  async eligible(now: Date): Promise<string[]> {
    const today = dateColumnOf(localDayOf(now));
    const withheld = await withheldPersonIds(this.prisma);
    const requested = await erasureRequestedPersonIds(this.prisma, now);

    const onRequest =
      requested.length === 0
        ? []
        : await this.prisma.pluginRecord.groupBy({
            by: ["subjectPersonId"],
            where: pluginRecordsErasedOnRequest({ in: requested }),
            orderBy: [{ subjectPersonId: "asc" }],
            take: requested.length,
          });

    const bound = remainingRunBound(onRequest.length, MAX_PERSONS_PER_RUN);
    const excluded = [...withheld, ...requested];
    const due =
      bound === 0
        ? []
        : await this.prisma.pluginRecord.groupBy({
            by: ["subjectPersonId"],
            where: {
              eraseOn: { lte: today },
              AND: [
                { subjectPersonId: { not: null } },
                ...(excluded.length > 0
                  ? [{ subjectPersonId: { notIn: excluded } }]
                  : []),
              ],
            },
            orderBy: [{ subjectPersonId: "asc" }],
            take: bound,
          });

    return [...onRequest, ...due].flatMap((group) =>
      group.subjectPersonId === null ? [] : [group.subjectPersonId],
    );
  }

  /**
   * Erases one person's records whose day has come, or all of them on a
   * granted request, and answers how many went from which plugin's collection.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
  ): Promise<{ pluginId: string; collection: string; records: number }[]> {
    const today = dateColumnOf(localDayOf(now));

    return this.prisma.$transaction(async (tx) => {
      // Before the hold is read, so that reading it settles the question, as
      // in every purge.
      await lockLegalHold(tx, personId);
      await lockErasureEligibility(tx, personId);
      if (await isPersonWithheld(tx, personId)) {
        return [];
      }

      const onRequest = await isErasureInForce(tx, personId, now);
      const where = onRequest
        ? pluginRecordsErasedOnRequest(personId)
        : { subjectPersonId: personId, eraseOn: { lte: today } };
      const groups = await tx.pluginRecord.groupBy({
        by: ["pluginId", "collection"],
        where,
        _count: { _all: true },
        orderBy: [{ pluginId: "asc" }, { collection: "asc" }],
      });
      if (groups.length === 0) {
        return [];
      }
      await tx.pluginRecord.deleteMany({ where });
      return groups.map((group) => ({
        pluginId: group.pluginId,
        collection: group.collection,
        records: group._count._all,
      }));
    });
  }
}
