import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { toIsoDate } from "../address-book/address-book-view";
import { computePurgeDate } from "./purge-date";
import { purgeCutoff } from "./purge-window";
import { retentionDaysAfterMoveOut } from "./retention-policy";

/** Queue the nightly service-data purge runs on. */
export const SERVICE_DATA_PURGE_QUEUE = "service-data-purge";

/**
 * When it runs. In the small hours, and not on the same minute as the import
 * session purge: two jobs waking together on one small connection pool is a
 * contention nobody gains anything from.
 */
const PURGE_CRON = "41 3 * * *";

/**
 * The most people one run erases.
 *
 * A cooperative is 20 to 200 households, so this is never reached in ordinary
 * running. It exists for the day a board shortens the retention policy from
 * ten years to thirty days: without a bound that run would erase a decade of
 * former residents in one transaction-per-person loop, holding the connection
 * pool for as long as it took. The remainder is not lost - the next night's
 * run finds it, because eligibility is computed from the data rather than
 * marked on it.
 */
const MAX_PERSONS_PER_RUN = 500;

/** What one person's purge cleared. Field names and counts, never values. */
export interface PurgeOutcome {
  personId: string;
  /** Service-tier fields set back to empty, by name. */
  cleared: string[];
  accountDeleted: boolean;
  invitationsDeleted: number;
}

export interface PurgeRunSummary {
  /** People the eligibility query selected. */
  considered: number;
  purged: number;
  /**
   * People whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later person for good.
   */
  failed: number;
}

/**
 * The service-tier purge (gallring).
 *
 * The two-tier model exists for this job. A cooperative must keep its member
 * register, its transfers and its lien notes - EFL 5 kap. via BRL 9 kap., at
 * least seven years - and must erase everything it holds for a service purpose
 * once that purpose has ended (GDPR art. 5.1 e). Those two duties are only
 * compatible if the data is separated, and the separation is only real if
 * something acts on it. This is that something.
 *
 * ## What it erases
 *
 * Contact details and the account: the email and phone ciphers with their blind
 * indexes, the personal locale preference, the Better Auth account with the
 * sessions and credentials that hang off it, and invitations that were never
 * accepted. That is the operational relationship with a person who no longer
 * lives here, and none of it has a purpose once they have gone.
 *
 * ## What it does not touch, and why
 *
 * The name and the postal address stay. They are member register content, and
 * the register is public on request: a register that lost its members' names
 * would not be one.
 *
 * The personal identity number stays. It is confidential apartment register
 * content (BRL 9 kap.) rather than service data, which is why it is masked from
 * every screen and reachable only through the audited reveal.
 *
 * MemberRegisterEntry, Transfer, LienNote and AuditLogEntry are never in scope.
 * Not "excluded by the query" - not attempted at all. The database refuses
 * UPDATE and DELETE on them through triggers the runtime role cannot disable,
 * so an attempt would be an error rather than an erasure, and code that tried
 * would be code that believed the archive was purgeable.
 *
 * Issues and documents are out of scope this train. Their retention story needs
 * its own decisions - an issue's description is free text a resident wrote and
 * may name a third party - and a purge that guessed at them would be worse than
 * one that says plainly which data it reaches. The data subject access report
 * lists both, so nothing is invisible in the meantime.
 *
 * ## How it runs
 *
 * One person per transaction. A crash halfway through leaves the people already
 * purged purged and the rest untouched, and tomorrow's run finds the rest,
 * because eligibility is computed from residency dates and the policy rather
 * than from a flag somebody has to keep in step. That also makes the job
 * idempotent: a person with nothing left to clear is not selected, so a purged
 * person does not collect a SERVICE_DATA_PURGED entry every night for ever.
 *
 * Every eligibility rule is checked twice - once in the scan, once inside the
 * transaction that erases. The second check is the one that counts: a legal
 * hold placed while the run was in flight has to win, and a board member who
 * clicks that button is entitled to assume it did.
 */
@Injectable()
export class PurgeService implements OnModuleInit {
  private readonly logger = new Logger(PurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own, so a
      // worker must not race them with the real one.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(SERVICE_DATA_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(SERVICE_DATA_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases the service data of everyone past their purge date.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting a year for a
   *   retention policy to run out.
   */
  async run(now: Date = new Date()): Promise<PurgeRunSummary> {
    const retentionDays = await retentionDaysAfterMoveOut(this.prisma);
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const outcome = await this.purgePerson(personId, now, retentionDays);
        if (outcome !== null) {
          purged += 1;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row.
        failed += 1;
        this.logger.error(
          `Purge failed for person ${personId}: ${failureName(error)}`,
        );
      }
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(
        `Purged service data for ${String(purged)} of ${String(
          personIds.length,
        )} eligible persons`,
      );
    }
    if (personIds.length === MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Purge stopped at its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return { considered: personIds.length, purged, failed };
  }

  /**
   * The people whose service data may be erased today.
   *
   * Four conditions, each of which is a way of saying "the purpose has not
   * ended yet":
   *
   *   the last residency ended, and long enough ago that the association's own
   *   retention policy has run out on it;
   *
   *   no board position is still held - a former resident elected to the board
   *   is an active relationship, and their contact details are how the
   *   association reaches its own board;
   *
   *   no system role is granted - an administrator or a property manager whose
   *   residency ended still administers the instance, and erasing the account
   *   of the only admin because they moved out is a lockout rather than a
   *   purge;
   *
   *   no legal hold stands.
   *
   * And one that is not a condition about purpose at all: there has to be
   * something left to erase. Without it the query would keep returning people
   * who were purged years ago and the job would write them a fresh
   * SERVICE_DATA_PURGED entry every night, into a table that cannot be tidied.
   *
   * A person with no residency at all is not selected. There is no move-out to
   * anchor a purge date on, so nothing has run out: an external board member or
   * an administrator who never lived here is not a former resident.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = purgeCutoff(now, retentionDays);

    const persons = await this.prisma.person.findMany({
      where: {
        residencies: { some: {} },
        // Every residency ended, and every one of them long enough ago. Said
        // as "none is still running" rather than "all ended", because Prisma's
        // `every` is satisfied by a person with no residencies at all.
        NOT: {
          residencies: {
            some: {
              OR: [{ movedOutOn: null }, { movedOutOn: { gt: cutoff } }],
            },
          },
        },
        boardPositions: {
          none: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
        },
        systemRoles: { none: {} },
        legalHolds: { none: { releasedAt: null } },
        OR: CLEARABLE_STATES,
      },
      orderBy: [{ createdAt: "asc" }],
      take: MAX_PERSONS_PER_RUN,
      select: { id: true },
    });

    return persons.map((person) => person.id);
  }

  /**
   * Erases one person's service data, or answers null if they turned out not
   * to be eligible after all.
   *
   * The whole erasure and the entry that records it are one transaction. An
   * audit log that claimed a purge that rolled back would be worse than no log:
   * the entry is the only evidence that data which no longer exists ever did,
   * and it is written into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays?: number,
  ): Promise<PurgeOutcome | null> {
    const days =
      retentionDays ?? (await retentionDaysAfterMoveOut(this.prisma));
    const cutoff = purgeCutoff(now, days);
    const defaultLocale = await this.defaultLocale();

    return this.prisma.$transaction(async (tx) => {
      const person = await tx.person.findUnique({
        where: { id: personId },
        select: {
          id: true,
          emailCipher: true,
          emailIndex: true,
          phoneCipher: true,
          phoneIndex: true,
          preferredLocale: true,
          residencies: {
            orderBy: [{ movedOutOn: "desc" }],
            select: { movedOutOn: true },
          },
          boardPositions: { select: { endedOn: true } },
          systemRoles: { select: { role: true } },
          legalHolds: {
            where: { releasedAt: null },
            select: { id: true },
          },
          userAccount: { select: { id: true } },
          invitations: {
            where: { acceptedAt: null },
            select: { id: true },
          },
        },
      });

      if (person === null || !isEligible(person, now, cutoff)) {
        /*
         * Re-checked here rather than trusted from the scan. A legal hold
         * placed, or a residency reopened, between the scan and this
         * transaction has to win: the board member who placed the hold is
         * entitled to assume it took effect, and this is the moment where that
         * is either true or a promise nobody kept.
         */
        return null;
      }

      const cleared: string[] = [];
      const data: Prisma.PersonUpdateInput = {};
      if (person.emailCipher !== null || person.emailIndex !== null) {
        data.emailCipher = null;
        data.emailIndex = null;
        cleared.push("email");
      }
      if (person.phoneCipher !== null || person.phoneIndex !== null) {
        data.phoneCipher = null;
        data.phoneIndex = null;
        cleared.push("phone");
      }
      if (person.preferredLocale !== defaultLocale) {
        // Back to the association's own default rather than to nothing: the
        // column is not nullable, and a stated preference is what is being
        // erased, not the fact that mail has to be written in some language.
        data.preferredLocale = defaultLocale;
        cleared.push("preferredLocale");
      }

      if (cleared.length > 0) {
        await tx.person.update({ where: { id: personId }, data });
      }

      /*
       * The account goes with the sessions, credentials, second factors and
       * passkeys that hang off it, by the cascades on auth_user. A sign-in
       * that still worked for somebody the register has erased the contact
       * details of would be the clearest possible sign that the purge is
       * cosmetic.
       */
      const accountDeleted =
        person.userAccount === null
          ? false
          : (await tx.user.deleteMany({ where: { personId } })).count > 0;

      /*
       * Invitations that were never accepted. Each carries a live token hash
       * for a link somebody could still be holding, so leaving them would
       * leave a way back into an account the purge just deleted. An accepted
       * invitation is a spent record of an activation and is left alone.
       */
      const { count: invitationsDeleted } = await tx.invitation.deleteMany({
        where: { personId, acceptedAt: null },
      });

      if (cleared.length === 0 && !accountDeleted && invitationsDeleted === 0) {
        // Nothing was there to erase. The eligibility query filters these out,
        // so reaching here means the last of it went while this ran; writing an
        // entry for an erasure that erased nothing would be a false record.
        return null;
      }

      const lastMoveOut = person.residencies[0]?.movedOutOn ?? null;

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention policy promised would happen.
          actorPersonId: null,
          targetPersonId: personId,
          /*
           * What was cleared, never what it held - the retention rule on
           * AuditLogService. This entry outlives the data it describes by
           * design, so a value copied in here would be the one copy the purge
           * did not reach.
           */
          context: {
            cleared,
            accountDeleted,
            invitationsDeleted,
            retentionDaysAfterMoveOut: days,
            lastMovedOutOn: toIsoDate(lastMoveOut),
            purgeOn: toIsoDate(computePurgeDate(lastMoveOut, days)),
          },
        },
        tx,
      );

      return { personId, cleared, accountDeleted, invitationsDeleted };
    });
  }

  /** The association's default language, or the schema's when unset. */
  private async defaultLocale(): Promise<string> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { defaultLocale: true },
    });
    return association?.defaultLocale ?? "sv";
  }
}

/**
 * The states that mean a person still has service data to erase.
 *
 * Shared between the scan and nothing else, but written out here so the list
 * the query filters on and the list {@link PurgeService.purgePerson} clears
 * are visibly the same list. A field added to one and not the other is a field
 * that is either never erased or erased over and over.
 */
const CLEARABLE_STATES: Prisma.PersonWhereInput[] = [
  { emailCipher: { not: null } },
  { emailIndex: { not: null } },
  { phoneCipher: { not: null } },
  { phoneIndex: { not: null } },
  { userAccount: { isNot: null } },
  { invitations: { some: { acceptedAt: null } } },
];

/**
 * Whether this person is still eligible, judged on rows already read inside
 * the erasing transaction.
 *
 * The same four conditions the scan applies, expressed over objects rather
 * than as a query, because the check that matters is the one taken with the
 * rows locked in front of it.
 */
function isEligible(
  person: {
    residencies: readonly { movedOutOn: Date | null }[];
    boardPositions: readonly { endedOn: Date | null }[];
    systemRoles: readonly unknown[];
    legalHolds: readonly unknown[];
  },
  now: Date,
  cutoff: Date,
): boolean {
  if (person.residencies.length === 0) {
    return false;
  }
  if (
    person.residencies.some(
      (residency) =>
        residency.movedOutOn === null ||
        residency.movedOutOn.getTime() > cutoff.getTime(),
    )
  ) {
    return false;
  }
  if (
    person.boardPositions.some(
      (position) =>
        position.endedOn === null || position.endedOn.getTime() > now.getTime(),
    )
  ) {
    return false;
  }
  return person.systemRoles.length === 0 && person.legalHolds.length === 0;
}
