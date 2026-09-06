import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { toIsoDate } from "../address-book/address-book-view";
import { lockResidencyTransitions } from "../registers/residency-lock";
import { lockLegalHold } from "./legal-hold-lock";
import { computePurgeDate } from "./purge-date";
import { purgeCutoff } from "./purge-window";
import { retentionDaysAfterMoveOut } from "./retention-policy";
import {
  erasureRequestedPersonIds,
  withheldPersonIds,
} from "./withheld-persons";

/** Queue the nightly service-data purge runs on. */
export const SERVICE_DATA_PURGE_QUEUE = "service-data-purge";

/**
 * When it runs: last of the nightly band, and on a minute of its own.
 *
 * The band is 03:07 news comments, 03:11 event sign-ups, 03:17 issues, 03:23
 * import sessions, 03:29 motions, 03:41 bookings, 03:53 service data. Two jobs
 * waking together on one small connection pool is a contention nobody gains
 * anything from, and this one is deliberately last: it is the job that executes
 * a granted erasure request and closes it, and the module purges before it
 * select on that request still being open.
 */
const PURGE_CRON = "53 3 * * *";

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
  /**
   * Rows the person was detached from and which stayed. Counted rather than
   * named: the record is the association's, and how many of its own issues a
   * departing resident had filed is not something the audit log needs to hold.
   */
  issuesDetachedFromPerson: number;
  documentsDetachedFromPerson: number;
  mediaDetachedFromPerson: number;
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
 * MemberRegisterEntry, Transfer, Termination, LienNote and AuditLogEntry are
 * never in scope.
 * Not "excluded by the query" - not attempted at all. The database refuses
 * UPDATE and DELETE on them through triggers the runtime role cannot disable,
 * so an attempt would be an error rather than an erasure, and code that tried
 * would be code that believed the archive was purgeable.
 *
 * ## Issues, documents and uploaded files
 *
 * These are detached from the person rather than deleted. The link to the
 * person goes, along with the reporter's name and address held on an issue, and
 * the record stays: an issue is the association's own account of a problem with
 * its building, and a document in the archive is an association record. Neither
 * stops being worth keeping because the person who filed it has moved away.
 *
 * What is left is not anonymous data, and nothing here calls it that. An
 * issue's description is free text somebody wrote, and it may name a
 * neighbour, so the result still identifies a person within the meaning of
 * GDPR Recital 26 - which is why the operation is named for what it does to
 * the link rather than for what it fails to do to the text. The
 * description is never rewritten by this job: a person named in one has an
 * art. 17 request like anybody else, which the board decides on its merits, and
 * a purge editing prose on a schedule would be the association silently
 * rewriting its own records.
 *
 * ## Erasure requests and restrictions
 *
 * A granted erasure request brings this run forward for one person: the same
 * data is erased, on the same rules, only sooner - the retention window and the
 * requirement of a past residency are what a request replaces, and nothing
 * else. Every other refusal still applies, so a person who still lives here, is
 * on the board, holds a system role or is under a legal hold is not erased
 * because they asked.
 *
 * A restriction (art. 18) stops this job for that person entirely. Art. 18(2)
 * permits storage and almost nothing else, so the one act it forbids is the one
 * this job performs.
 *
 * ## Its place in the night
 *
 * This purge runs last of the nightly band, at 03:53. The module purges before
 * it select on the same granted erasure requests, and this is the job that
 * marks a request executed and closes it. Running it first would close the
 * request before the bookings, sign-ups, motions and comments had been looked
 * at, and those would wait for a clock the person had asked to be freed from. A
 * purge added to the band later takes a minute before 03:53.
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
        // was holding: an exception message here can be quoting a row. The id
        // stays because it is the only handle on an erasure that did not
        // happen, and a failed transaction wrote no audit entry to carry it -
        // ADR 0007.
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
    const defaultLocale = await this.defaultLocale();

    /*
     * People whose data is referenced from a row this job detaches. These are
     * plain columns rather than relations, so no `some` filter reaches them and
     * the ordinary scan below would miss somebody whose only remaining trace is
     * an issue they reported years ago. Read as three groupBys for the reason
     * the module purges give: one distinct scan of a column beats a join across
     * every person in the register.
     */
    const referencedIds = await this.referencedPersonIds();

    const requested = await erasureRequestedPersonIds(this.prisma);
    const withheld = new Set(await withheldPersonIds(this.prisma));

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
        processingRestrictedAt: null,
        OR: [...clearableStates(defaultLocale), { id: { in: referencedIds } }],
      },
      orderBy: [{ createdAt: "asc" }],
      take: MAX_PERSONS_PER_RUN,
      select: { id: true },
    });

    /*
     * A granted erasure request replaces two of the conditions above and
     * nothing else: the retention window, and the requirement of a past
     * residency at all. A person who asked to be erased and never lived here -
     * an external board member, an administrator - has service data like
     * anybody else and no move-out to anchor a date on.
     *
     * Every other refusal still stands, which is why this is a second query
     * rather than a relaxed version of the first: a person who still lives
     * here, sits on the board, holds a system role or is under a hold is not
     * erased because they asked, and the board is told which of those it was.
     */
    const onRequest =
      requested.length === 0
        ? []
        : await this.prisma.person.findMany({
            where: {
              id: { in: requested },
              NOT: {
                residencies: {
                  some: {
                    OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
                  },
                },
              },
              boardPositions: {
                none: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
              },
              systemRoles: { none: {} },
              legalHolds: { none: { releasedAt: null } },
              processingRestrictedAt: null,
            },
            orderBy: [{ createdAt: "asc" }],
            take: MAX_PERSONS_PER_RUN,
            select: { id: true },
          });

    const ids: string[] = [];
    for (const person of [...persons, ...onRequest]) {
      if (withheld.has(person.id) || ids.includes(person.id)) {
        continue;
      }
      ids.push(person.id);
    }

    return ids.slice(0, MAX_PERSONS_PER_RUN);
  }

  /**
   * Everybody named by a row this job detaches rather than erases.
   *
   * Three distinct scans rather than a join: reporterPersonId,
   * uploadedByPersonId on a document and the same column on a media file are
   * plain columns with an index each, and asking each of them for its distinct
   * values is one index scan apiece.
   */
  private async referencedPersonIds(): Promise<string[]> {
    const [issues, documents, media] = await Promise.all([
      this.prisma.issue.groupBy({
        by: ["reporterPersonId"],
        where: { reporterPersonId: { not: null } },
      }),
      this.prisma.document.groupBy({
        by: ["uploadedByPersonId"],
        where: { uploadedByPersonId: { not: null } },
      }),
      this.prisma.mediaFile.groupBy({
        by: ["uploadedByPersonId"],
        where: { uploadedByPersonId: { not: null } },
      }),
    ]);

    const ids = new Set<string>();
    for (const row of issues) {
      if (row.reporterPersonId !== null) {
        ids.add(row.reporterPersonId);
      }
    }
    for (const row of [...documents, ...media]) {
      if (row.uploadedByPersonId !== null) {
        ids.add(row.uploadedByPersonId);
      }
    }
    return [...ids];
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
      /*
       * Both locks, in this order, before the read. The lock file's own comment
       * describes the gap this closes: without them a hold placed, or a
       * residency reopened, between the read below and the writes that follow
       * would be decided by whichever transaction committed last.
       *
       * The order is fixed across the product - hold, then residency - and
       * every other writer takes at most one of them: LegalHoldService takes
       * the hold lock, MoveService the residency lock. So no transaction ever
       * holds the second while waiting for the first, and the pair cannot
       * deadlock.
       */
      await lockLegalHold(tx, personId);
      await lockResidencyTransitions(tx, personId);

      const request = await tx.dataSubjectRequest.findFirst({
        where: {
          personId,
          kind: "ERASURE",
          decision: "GRANTED",
          executedAt: null,
          closedAt: null,
        },
        orderBy: [{ requestedOn: "asc" }],
        select: { id: true },
      });

      const person = await tx.person.findUnique({
        where: { id: personId },
        select: {
          id: true,
          processingRestrictedAt: true,
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

      if (
        person === null ||
        !isEligible(
          person,
          now,
          request === null ? cutoff : now,
          request !== null,
        )
      ) {
        /*
         * Re-checked here rather than trusted from the scan. A legal hold
         * placed, or a residency reopened, between the scan and this
         * transaction has to win: the board member who placed the hold is
         * entitled to assume it took effect, and this is the moment where that
         * is either true or a promise nobody kept.
         *
         * A granted request moves the cutoff to now and lifts the requirement
         * of a past residency; it lifts nothing else, so a hold placed after
         * the grant still refuses here and the request stays granted and
         * unexecuted for the board to look at.
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

      /*
       * Issues, documents and uploaded files are detached from the person and
       * kept. What goes is the link and the contact details an issue carries
       * for a reporter who had no account; what stays is the association's
       * record of a problem with its building, the document in its archive, and
       * every photograph.
       *
       * The description is not touched. It is free text somebody wrote about
       * the building, it is the record of what was wrong, and it may name a
       * neighbour - which is why this is a detachment and why the result is
       * not anonymous. A person named in one makes an art. 17 request, which
       * the board decides; a job rewriting prose on a schedule would be the
       * association quietly editing its own history.
       */
      const { count: issuesDetachedFromPerson } = await tx.issue.updateMany({
        where: { reporterPersonId: personId },
        data: {
          reporterPersonId: null,
          reporterNameCipher: null,
          reporterEmailCipher: null,
          reporterEmailIndex: null,
        },
      });

      const { count: documentsDetachedFromPerson } =
        await tx.document.updateMany({
          where: { uploadedByPersonId: personId },
          data: { uploadedByPersonId: null },
        });

      /*
       * Every file the person uploaded, an issue photograph included. Nothing
       * is removed from storage: a photograph of a leaking pipe is the record
       * of the problem, and the flag saying it may show somebody is a default
       * the upload path writes about every issue photograph rather than a
       * finding about the picture.
       */
      const { count: mediaDetachedFromPerson } = await tx.mediaFile.updateMany({
        where: { uploadedByPersonId: personId },
        data: { uploadedByPersonId: null },
      });

      if (issuesDetachedFromPerson > 0) {
        cleared.push("issues");
      }
      if (documentsDetachedFromPerson > 0) {
        cleared.push("documents");
      }
      if (mediaDetachedFromPerson > 0) {
        cleared.push("media");
      }

      if (
        request === null &&
        cleared.length === 0 &&
        !accountDeleted &&
        invitationsDeleted === 0
      ) {
        // Nothing was there to erase. The eligibility query filters these out,
        // so reaching here means the last of it went while this ran; writing an
        // entry for an erasure that erased nothing would be a false record.
        //
        // A granted request is the exception: the board was promised the run
        // would happen, so the entry is written and the request closed even
        // when there was nothing left to clear, which is the difference between
        // "we did it" and "we never got to it".
        return null;
      }

      if (request !== null) {
        await tx.dataSubjectRequest.update({
          where: { id: request.id },
          data: {
            executedAt: now,
            closedAt: now,
            closeReason: "purged",
            // No person: the purge closed it, and that absence is what
            // distinguishes execution from a board member closing it by hand.
            closedByPersonId: null,
          },
        });
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
            issuesDetachedFromPerson,
            documentsDetachedFromPerson,
            mediaDetachedFromPerson,
            retentionDaysAfterMoveOut: days,
            lastMovedOutOn: toIsoDate(lastMoveOut),
            purgeOn: toIsoDate(computePurgeDate(lastMoveOut, days)),
            ...(request === null
              ? {}
              : { requested: true, erasureRequestId: request.id }),
          },
        },
        tx,
      );

      return {
        personId,
        cleared,
        accountDeleted,
        invitationsDeleted,
        issuesDetachedFromPerson,
        documentsDetachedFromPerson,
        mediaDetachedFromPerson,
      };
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
 *
 * A function rather than a constant because of the last term: "states a
 * language other than the association's" cannot be written without knowing
 * which language that is.
 */
function clearableStates(defaultLocale: string): Prisma.PersonWhereInput[] {
  return [
    { emailCipher: { not: null } },
    { emailIndex: { not: null } },
    { phoneCipher: { not: null } },
    { phoneIndex: { not: null } },
    /*
     * The stated language, which purgePerson resets and the scan used to miss.
     * Somebody with no email, no phone, no account and no open invitation was
     * therefore never selected, and their stated preference stayed on file for
     * good - the exact case this list exists to prevent. Imported members are
     * how that state is reached in practice.
     */
    { preferredLocale: { not: defaultLocale } },
    { userAccount: { isNot: null } },
    { invitations: { some: { acceptedAt: null } } },
  ];
}

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
    processingRestrictedAt: Date | null;
  },
  now: Date,
  cutoff: Date,
  onRequest = false,
): boolean {
  /*
   * A restriction refuses before anything else is considered. Art. 18(2) lets
   * the association store the data and little else, so erasing it is the one
   * act the person has asked it not to perform - and asking for a restriction
   * after asking for erasure is a person changing their mind, which the later
   * request wins.
   */
  if (person.processingRestrictedAt !== null) {
    return false;
  }
  /*
   * Asked before the residencies, because none of these depends on one. A
   * granted request moves the cutoff and lifts the requirement of a past
   * residency; it lifts nothing else, so a hold placed after the grant still
   * refuses here - and it has to refuse for somebody who never held a
   * residency too, whose data a hold is just as capable of preserving.
   */
  if (
    person.boardPositions.some(
      (position) =>
        position.endedOn === null || position.endedOn.getTime() > now.getTime(),
    )
  ) {
    return false;
  }
  if (person.systemRoles.length > 0 || person.legalHolds.length > 0) {
    return false;
  }
  /*
   * Somebody who never lived here has no move-out to anchor a purge date on, so
   * the scheduled job leaves them alone. A granted request is a different
   * authority: it names this person, and their contact details and account are
   * service data whether or not they ever held a residency.
   */
  if (person.residencies.length === 0) {
    return onRequest;
  }
  return !person.residencies.some(
    (residency) =>
      residency.movedOutOn === null ||
      residency.movedOutOn.getTime() > cutoff.getTime(),
  );
}
