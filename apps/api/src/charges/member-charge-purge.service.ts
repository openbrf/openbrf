import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  MEMBER_CHARGE_RETENTION_YEARS,
  memberChargePurgeCutoff,
} from "./member-charge-retention";
import { MEMBER_CHARGE_TARGET_KIND } from "./member-charge.service";

/** Queue the nightly charge purge runs on. */
export const MEMBER_CHARGE_PURGE_QUEUE = "member-charge-purge";

/**
 * When it runs.
 *
 * In the small hours, on a minute of its own: the sign-up purge takes 03:11, the
 * import session purge 03:23, the motion purge 03:29, the service data purge
 * 03:41 and the booking purge 03:53, and jobs waking together on one small
 * connection pool is a contention nobody gains anything from. 03:17 is the gap
 * between the first two.
 */
const PURGE_CRON = "17 3 * * *";

/**
 * The most charged parties one run erases the charges of.
 *
 * A cooperative is 20 to 200 households and a night's worth of expiries is a
 * handful, so this is never reached in ordinary running. It exists for the first
 * run on an instance that has been keeping charges for years, or the day the
 * retention window is shortened: without a bound that run would erase every
 * charge ever recorded in one transaction-per-party loop. Nothing is lost by
 * stopping - eligibility is computed from the data rather than marked on it, so
 * the next night's run finds the rest.
 *
 * Counted over persons and apartments separately, because they are two scans
 * with two hold rules; a run that found the bound in both erases up to twice
 * this many parties, which is the same shape of bound and not a hole in it.
 */
const MAX_PARTIES_PER_RUN = 500;

export interface MemberChargePurgeRunSummary {
  /** People and apartments the eligibility scan found erasable charges for. */
  considered: number;
  /** Parties whose charges were erased. */
  purged: number;
  /** Charges deleted across all of them. */
  chargesDeleted: number;
  /**
   * Parties whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later party for good.
   */
  failed: number;
}

/** One party a run erases the charges of. */
type ChargedParty =
  { kind: "person"; id: string } | { kind: "apartment"; id: string };

/**
 * The charge purge (gallring av debiteringar).
 *
 * A charge is service-tier personal data - what the association put on a named
 * person, or on an apartment that leads back to whoever lives in it - and the
 * purpose it is held for ends when the accounting record it was the basis for
 * has outlived its own preservation period. So it is erased on a clock derived
 * from the charge's own date, seven calendar years later, and not on the
 * residency purge's: somebody who still lives here has no more use for a 2026
 * key charge than somebody who has left, and the residency purge would never
 * reach it at all while they stayed. The arithmetic and the reasoning are in
 * `member-charge-retention.ts`.
 *
 * ## What it erases
 *
 * The charge row, whole. There is nothing on it to blank down to: strip the
 * person and the apartment and what is left is a sum the association charged
 * nobody, which is of no use and is still a row somebody has to keep. The
 * hand-over date goes with it, because it is a fact about the charge rather than
 * a record of its own.
 *
 * ## Legal hold
 *
 * A hold standing against the person charged stops it, the way it stops the
 * residency purge, the booking purge and the sign-up purge. The ground under
 * GDPR art. 17.3 is about the person's data rather than about one table, so a
 * dispute that keeps somebody's contact details keeps the charges that may be
 * what the dispute is about - what a household was charged for a repair, and on
 * what basis, is exactly the record a hold exists to preserve.
 *
 * A charge on an apartment names nobody, so the hold is read through the flat:
 * a hold against anybody who has ever held a residency there keeps the
 * apartment's charges. Ever, and not only now, because the charge is from a year
 * that has closed and the household that disputes it may have moved out since.
 * That errs towards keeping, which is the direction a hold is for.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes. The second one is the one that counts, because a hold placed
 * while the run was in flight has to win, and the board member who clicked that
 * button is entitled to assume it did. That second check is taken under the
 * advisory lock in `retention/legal-hold-lock.ts`, which is what makes it a
 * decision rather than a race: a placement takes the same key, so it either
 * lands before the check and stops the run or waits for it and takes effect from
 * the moment it commits.
 *
 * The scan's check is not a duplicate of it. Held parties are excluded by the
 * query rather than dropped from its answer, so they cannot spend a run's bound
 * without anything being erased.
 *
 * ## How it runs
 *
 * One party per transaction, like the booking and sign-up purges and for the
 * same reasons. A crash halfway through leaves what it finished finished and the
 * rest for tomorrow, because eligibility is computed from the charge date and the
 * window rather than from a flag somebody has to keep in step; and a party with
 * nothing left to erase is not selected, so nobody collects an entry a night for
 * ever in a table that cannot be tidied.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "memberCharge", rather
 * than an action of its own. It is the same act the log already has a word for -
 * service-tier data past its retention date was erased - and one entry per party
 * is what lets a later access report say which of that person's data went and
 * when. An apartment's entry names no subject, for the reason the recording
 * entry gives: which of its residents that would be is a question the log must
 * not answer by guessing.
 */
@Injectable()
export class MemberChargePurgeService implements OnModuleInit {
  private readonly logger = new Logger(MemberChargePurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own, so a worker
      // must not race them with the real one.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(MEMBER_CHARGE_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(MEMBER_CHARGE_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every charge past its purge date, party by party.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting seven years.
   * @param retentionYears How many full calendar years after its own a charge is
   *   kept.
   */
  async run(
    now: Date = new Date(),
    retentionYears: number = MEMBER_CHARGE_RETENTION_YEARS,
  ): Promise<MemberChargePurgeRunSummary> {
    const parties = await this.eligible(now, retentionYears);

    let purged = 0;
    let chargesDeleted = 0;
    let failed = 0;
    for (const party of parties) {
      try {
        const deleted = await this.purgeParty(party, now, retentionYears);
        if (deleted > 0) {
          purged += 1;
          chargesDeleted += deleted;
        }
      } catch (error) {
        // The class of the failure and the party, and nothing the failure was
        // holding: an exception message here can be quoting a row.
        failed += 1;
        this.logger.error(
          `Member charge purge failed for ${party.kind} ${party.id}: ${failureName(
            error,
          )}`,
        );
      }
    }

    if (chargesDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(chargesDeleted)} member charges for ${String(
          purged,
        )} of ${String(parties.length)} eligible parties`,
      );
    }

    return {
      considered: parties.length,
      purged,
      chargesDeleted,
      failed,
    };
  }

  /**
   * The parties holding at least one charge whose retention has run out.
   *
   * Grouped by the party rather than listing charges, because the unit of work
   * is a party: one transaction, one audit entry, one answer to "what of mine
   * was erased and when".
   *
   * A held party is excluded by the query itself rather than filtered out of its
   * answer, and that ordering is the whole reason for the extra round trips. The
   * per-run bound is applied by the database, so held parties removed afterwards
   * would still have spent it: five hundred held people sorting ahead of
   * everybody else would fill every run for as long as their holds stood, and
   * the charges behind them would outlive their retention window with nothing
   * reporting a fault. The booking, sign-up and residency purges all state the
   * same rule inside their own scans, for the same reason.
   *
   * The hold is checked again inside the transaction that deletes. That is the
   * check that counts.
   */
  async eligible(now: Date, retentionYears: number): Promise<ChargedParty[]> {
    const cutoff = memberChargePurgeCutoff(now, retentionYears);
    const heldPersonIds = await this.heldPersonIds();
    const heldApartmentIds = await this.apartmentsOf(heldPersonIds);

    const persons = await this.prisma.memberCharge.groupBy({
      by: ["personId"],
      where: {
        chargedOn: { lt: cutoff },
        personId: { not: null },
        // Spelled conditionally rather than as an empty `notIn`, so what the
        // query asks does not depend on how the client renders a list of none.
        ...(heldPersonIds.length > 0
          ? { personId: { not: null, notIn: heldPersonIds } }
          : {}),
      },
      orderBy: [{ personId: "asc" }],
      take: MAX_PARTIES_PER_RUN,
    });

    const apartments = await this.prisma.memberCharge.groupBy({
      by: ["apartmentId"],
      where: {
        chargedOn: { lt: cutoff },
        apartmentId: { not: null },
        ...(heldApartmentIds.length > 0
          ? { apartmentId: { not: null, notIn: heldApartmentIds } }
          : {}),
      },
      orderBy: [{ apartmentId: "asc" }],
      take: MAX_PARTIES_PER_RUN,
    });

    return [
      ...persons
        .map((group) => group.personId)
        .filter((id): id is string => id !== null)
        .map((id): ChargedParty => ({ kind: "person", id })),
      ...apartments
        .map((group) => group.apartmentId)
        .filter((id): id is string => id !== null)
        .map((id): ChargedParty => ({ kind: "apartment", id })),
    ];
  }

  /**
   * Erases one party's expired charges, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgeParty(
    party: ChargedParty,
    now: Date = new Date(),
    retentionYears: number = MEMBER_CHARGE_RETENTION_YEARS,
  ): Promise<number> {
    const cutoff = memberChargePurgeCutoff(now, retentionYears);
    const holdOn =
      party.kind === "person" ? [party.id] : await this.residentsOf(party.id);

    return this.prisma.$transaction(async (tx) => {
      /*
       * Before the holds are read, so that reading them settles the question.
       * Everything below runs at READ COMMITTED, where a placement committing
       * between the read and the delete would leave this transaction erasing the
       * rows the hold was placed to preserve - and the board member would have
       * been told the person was held. `LegalHoldService.place` takes the same
       * key, which is what makes the two orderable at all.
       *
       * Taken in sorted order, which matters only for an apartment: two runs
       * holding two of the same flat's residents in opposite orders would
       * deadlock, and there is nothing in this loop that could recover from one.
       */
      for (const personId of [...holdOn].sort()) {
        await lockLegalHold(tx, personId);
      }

      if (holdOn.length > 0) {
        const held = await tx.legalHold.findFirst({
          where: { personId: { in: holdOn }, releasedAt: null },
          select: { id: true },
        });
        if (held !== null) {
          /*
           * Re-checked here rather than trusted from the scan. A hold placed
           * between the scan and this transaction has to win: the board member
           * who placed it is entitled to assume it took effect, and this is the
           * moment where that is either true or a promise nobody kept.
           */
          return 0;
        }
      }

      const { count } = await tx.memberCharge.deleteMany({
        where:
          party.kind === "person"
            ? { personId: party.id, chargedOn: { lt: cutoff } }
            : { apartmentId: party.id, chargedOn: { lt: cutoff } },
      });
      if (count === 0) {
        // The scan filters these out, so reaching here means the last of them
        // went while this ran. An entry for an erasure that erased nothing would
        // be a false record in a table that cannot be corrected.
        return 0;
      }

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention window promised would happen.
          actorPersonId: null,
          targetPersonId: party.kind === "person" ? party.id : null,
          targetKind: MEMBER_CHARGE_TARGET_KIND,
          /*
           * How many, and the window they fell out of. Not which charges, not
           * what they were for and not what they came to - the retention rule on
           * AuditLogService. This entry names the person and outlives the rows it
           * describes by design, and the log is exempt from every purge, so a sum
           * copied in here would be a precise, permanent record of what somebody
           * was charged, inside the entry that says it was erased.
           */
          context: {
            charges: count,
            party: party.kind,
            ...(party.kind === "apartment" ? { apartmentId: party.id } : {}),
            retentionYearsAfterChargeYear: retentionYears,
          },
        },
        tx,
      );

      return count;
    });
  }

  /**
   * Everybody a legal hold currently stands against.
   *
   * Read whole rather than asked about a shortlist, because the scan needs them
   * before it chooses its shortlist rather than after. One row per held person at
   * most, and a hold is a dispute the board entered deliberately, so this is a
   * handful of ids in a cooperative that has any at all.
   */
  private async heldPersonIds(): Promise<string[]> {
    const holds = await this.prisma.legalHold.findMany({
      where: { releasedAt: null },
      select: { personId: true },
      distinct: ["personId"],
    });
    return holds.map((hold) => hold.personId);
  }

  /** The apartments a set of people have ever held a residency on. */
  private async apartmentsOf(personIds: readonly string[]): Promise<string[]> {
    if (personIds.length === 0) {
      return [];
    }
    const residencies = await this.prisma.residency.findMany({
      where: { personId: { in: [...personIds] } },
      select: { apartmentId: true },
      distinct: ["apartmentId"],
    });
    return residencies.map((residency) => residency.apartmentId);
  }

  /** Everybody who has ever held a residency on one apartment. */
  private async residentsOf(apartmentId: string): Promise<string[]> {
    const residencies = await this.prisma.residency.findMany({
      where: { apartmentId },
      select: { personId: true },
      distinct: ["personId"],
    });
    return residencies.map((residency) => residency.personId);
  }
}
