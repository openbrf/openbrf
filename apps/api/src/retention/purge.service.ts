import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { formatDateColumn } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockResidencyTransitions } from "../registers/residency-lock";
import {
  sweepConnectedAppTokens,
  type ConnectedAppTokenSweepOutcome,
} from "./connected-app-token-sweep";
import {
  describeRemainder,
  ERASURE_DOMAINS,
  erasureRemainder,
  remainingRunBound,
  type ErasureRemainder,
} from "./erasure-domains";
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
 * When it runs: 03:53, after every job that reads a granted erasure request, and
 * on a minute of its own.
 *
 * This is the job that executes a granted erasure request and closes it, and the
 * module purges select on that request still being open, so each of them takes
 * an earlier minute. `erasure-request-order.spec.ts` beside this file finds every
 * job that reads the request from its source and fails for one scheduled at or
 * after this minute. Two jobs waking together on one small connection pool is a
 * contention nobody gains anything from.
 */
const PURGE_CRON = "53 3 * * *";

/**
 * The most people one run erases off the retention policy's clock.
 *
 * A cooperative is 20 to 200 households, so this is never reached in ordinary
 * running. It exists for the day a board shortens the retention policy from
 * ten years to thirty days: without a bound that run would erase a decade of
 * former residents in one transaction-per-person loop, holding the connection
 * pool for as long as it took. The remainder is not lost - the next night's
 * run finds it, because eligibility is computed from the data rather than
 * marked on it.
 *
 * The people a granted erasure request names are taken before it and cannot be
 * cut by it: they are selected by a flag rather than by a date, and this job is
 * what clears it, so a run exceeds this number only where there are more open
 * granted requests than it. `erasure-domains.ts` has the whole of why.
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
  /**
   * Whether a granted erasure request was marked executed and closed.
   *
   * False where there was none, and false where there was one the run could not
   * yet call carried out: {@link PurgeOutcome.erasureRemainder} then says what
   * was still standing.
   */
  erasureRequestClosed: boolean;
  /** What each erasure-aware domain still held, where any of them held rows. */
  erasureRemainder: ErasureRemainder[];
}

/**
 * Why a granted erasure request is still open when a run ends.
 *
 * Two answers and they mean opposite things. "blocked" is the product working as
 * it is meant to: a legal hold, a restriction, a board seat, a system role, a
 * residency that has not ended or a motion the association is still dealing
 * with is keeping rows the purge must not take, and the request waits for that
 * to change. "incomplete" is work that was owed and did not happen: a run that
 * threw for this person, a reader that has not got through them, a night the
 * instance was down. The first is expected and logged as such; the second is a
 * fault and is warned about, because nothing else would report it.
 *
 * Not the word this product already uses for a person whose personal data is
 * protected (skyddade personuppgifter), which every service that returns a
 * person to a screen answers with and which a debiting list and a fee notice
 * print in the cell where a name would go. A log line saying it beside a person
 * id would be a false signal for an ordinary member and would read as a
 * disclosure for a real one.
 */
export type ErasureRequestStatus = "blocked" | "incomplete";

/** One granted erasure request the run left open, and what it is waiting on. */
export interface OpenErasureRequest {
  personId: string;
  status: ErasureRequestStatus;
  /**
   * What is standing in the way, in names and counts.
   *
   * Never a value out of any of those rows - what somebody wrote in a room or
   * proposed to a meeting is not something a log line may carry (ADR 0007).
   */
  because: string;
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
  /**
   * What the connected-app token sweep deleted on this run.
   *
   * Not part of anybody's purge and counted apart from it: a credential that
   * has run out has run out whoever it was issued for.
   */
  tokensSwept: ConnectedAppTokenSweepOutcome;
  /**
   * Granted erasure requests still open when the run ended, and why each one is.
   *
   * The run's own account of the erasures it did not finish. A request that
   * closed is not here, and one that is has a reason rather than a silence:
   * before this existed, a request the purge could not carry out was left open
   * by a `return null` that wrote nothing anywhere.
   */
  erasureRequestsOpen: OpenErasureRequest[];
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
 * This is the job that marks a granted erasure request executed and closes it,
 * and closing it ends the erasure: every job that reads the request selects
 * only open ones. So it closes a request only once it has counted what each
 * erasure-aware domain still holds for that person and found nothing -
 * `erasure-domains.ts` holds the registry and ADR 0016 the decision. Running
 * the other jobs first settles how quickly an erasure finishes; this settles
 * whether it finished.
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
 * ## Tokens issued to connected apps
 *
 * The same run sweeps the access and refresh rows behind the apps members have
 * connected, once the rows can no longer be presented. They are credentials
 * rather than records of anything, they are not held against one person's
 * retention clock, and there are no rows to loop over - so they ride this run's
 * minute instead of taking one of their own. `connected-app-token-sweep.ts`
 * holds the rule and the reasons.
 *
 * A person's own grants are not swept: they go with the account, by the
 * cascades on it, in the same statement that deletes the account below.
 *
 * ## Its place in the night
 *
 * This purge runs at 03:53, after the module purges that select on the same
 * granted erasure requests, and this is the job that marks a request executed
 * and closes it. Running it first would close the request before the bookings,
 * sign-ups, motions, comments and chat messages had been looked at, and those
 * would wait for a clock the person had asked to be freed from. A purge that
 * reads the request takes a minute before 03:53, and
 * `erasure-request-order.spec.ts` fails for one that does not.
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
    /*
     * Who the loop threw for, so the account taken below can tell a request
     * left open by a failure from one left open by a hold. The two look
     * identical in the database - a granted request with no executedAt - and
     * telling them apart is the difference between a board waiting for a date
     * and a board waiting for somebody to look at a log.
     */
    const failedPersonIds = new Set<string>();
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
        failedPersonIds.add(personId);
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
    if (personIds.length >= MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Purge reached its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )} people. Everybody a granted erasure request names was taken ` +
          "first and the retention policy's clock took what was left of the " +
          "bound, so what waits for a later run is people on that clock alone.",
      );
    }

    /*
     * Every granted request that is still open, with what it is waiting on.
     * Taken after the loop and read from the database rather than assembled
     * from it, so a request somebody granted while the run was in flight is in
     * the account too, and so is one this job never selected.
     */
    const erasureRequestsOpen = await this.openErasureRequests(
      now,
      failedPersonIds,
    );
    for (const open of erasureRequestsOpen) {
      const line =
        `Granted erasure request for person ${open.personId} stays open ` +
        `(${open.status}): ${open.because}`;
      if (open.status === "blocked") {
        // Expected: something the purge must not overrule is keeping the rows,
        // and the request waits for it rather than for anybody.
        this.logger.log(line);
      } else {
        // Owed and not done. Nothing else reports it: the request looks the
        // same in the database either way, and the next run is what fixes it.
        this.logger.warn(line);
      }
    }

    /*
     * Last, and after the loop rather than inside it. The people purged above
     * took their own grants and tokens with them through the cascades on the
     * account; what is left for this to reach is every other app's credentials
     * that have simply run out, which belong to no person's purge.
     */
    const tokensSwept = await sweepConnectedAppTokens(this.prisma, now);
    if (tokensSwept.accessTokens > 0 || tokensSwept.refreshTokens > 0) {
      // Counts, like every other line this job writes: what a token was issued
      // for is in the audit log, and a token value is never written anywhere.
      this.logger.log(
        `Swept ${String(tokensSwept.accessTokens)} expired access tokens and ${String(
          tokensSwept.refreshTokens,
        )} spent refresh tokens issued to connected apps`,
      );
    }

    return {
      considered: personIds.length,
      purged,
      failed,
      tokensSwept,
      erasureRequestsOpen,
    };
  }

  /**
   * Every granted erasure request still open when a run ended, and why.
   *
   * Asked of the database rather than of the loop, because the question is what
   * is true now: a request granted while the run was in flight is open and
   * unstarted, a request whose person the bound did not reach is open and
   * untouched, and both belong in the account.
   *
   * @param failedPersonIds People this run's own erasure threw for.
   */
  private async openErasureRequests(
    now: Date,
    failedPersonIds: ReadonlySet<string>,
  ): Promise<OpenErasureRequest[]> {
    const open: OpenErasureRequest[] = [];
    for (const personId of await erasureRequestedPersonIds(this.prisma)) {
      const remainder = await erasureRemainder(this.prisma, personId, now);
      const described = remainder.map(describeRemainder).join("; ");

      if (failedPersonIds.has(personId)) {
        // The failure first, whatever else is standing: it is the thing that
        // happened tonight and the thing somebody has to look at.
        open.push({
          personId,
          status: "incomplete",
          because: join("the erasure failed for them on this run", described),
        });
        continue;
      }

      const refusal = await this.purgeRefusalFor(personId, now);
      if (refusal !== null) {
        open.push({
          personId,
          status: "blocked",
          because: join(refusal, described),
        });
      } else if (remainder.some((domain) => domain.owed > 0)) {
        // A job that reads granted requests has not got through this person:
        // it threw for them, stopped at its bound, or did not run at all.
        open.push({ personId, status: "incomplete", because: described });
      } else if (remainder.length > 0) {
        // Only rows a domain keeps on purpose are left. The erasure has gone as
        // far as it can go, and the request says so rather than claiming to be
        // carried out.
        open.push({ personId, status: "blocked", because: described });
      } else {
        /*
         * Nothing owed, nothing kept and nothing refusing, so the request would
         * have closed had this run reached the person. The per-run bound is
         * what is left, and the next run takes them.
         */
        open.push({
          personId,
          status: "incomplete",
          because: "this run did not reach them",
        });
      }
    }
    return open;
  }

  /**
   * What refuses this person's purge, or null where nothing does.
   *
   * The scan's rules asked one person at a time, so a request left open has a
   * reason that names the same thing the query filtered on. A granted request
   * is the authority here, so the cutoff is now and a past residency is not
   * required - every other refusal stands.
   */
  private async purgeRefusalFor(
    personId: string,
    now: Date,
  ): Promise<string | null> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        processingRestrictedAt: true,
        residencies: { select: { movedOutOn: true } },
        boardPositions: { select: { endedOn: true } },
        systemRoles: { select: { role: true } },
        legalHolds: { where: { releasedAt: null }, select: { id: true } },
      },
    });
    if (person === null) {
      return "the person row is gone";
    }
    return purgeRefusal(person, now, now, true);
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

    /*
     * A granted erasure request replaces two of the conditions below and
     * nothing else: the retention window, and the requirement of a past
     * residency at all. A person who asked to be erased and never lived here -
     * an external board member, an administrator - has service data like
     * anybody else and no move-out to anchor a date on.
     *
     * Every other refusal still stands, which is why this is a query of its own
     * rather than a relaxed version of the one below: a person who still lives
     * here, sits on the board, holds a system role or is under a hold is not
     * erased because they asked, and the board is told which of those it was.
     *
     * Taken first, and what is left of the bound is what the query below may
     * take. These people are selected by a flag that this job clears, so one
     * pushed off the end of a bounded run is one no later run would select -
     * the single case where the bound's promise that the next run finds the
     * rest does not hold.
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
            take: requested.length,
            select: { id: true },
          });

    const bound = remainingRunBound(onRequest.length, MAX_PERSONS_PER_RUN);
    const persons =
      bound === 0
        ? []
        : await this.prisma.person.findMany({
            where: {
              residencies: { some: {} },
              // Every residency ended, and every one of them long enough
              // ago. Said as "none is still running" rather than "all
              // ended", because Prisma's `every` is satisfied by a person
              // with no residencies at all.
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
              // Excluded rather than deduplicated afterwards: the bound is
              // applied by the database, so somebody dropped from the answer
              // would still have spent it.
              ...(requested.length > 0 ? { id: { notIn: requested } } : {}),
              OR: [
                ...clearableStates(defaultLocale),
                { id: { in: referencedIds } },
              ],
            },
            orderBy: [{ createdAt: "asc" }],
            take: bound,
            select: { id: true },
          });

    const ids: string[] = [];
    for (const person of [...onRequest, ...persons]) {
      if (withheld.has(person.id) || ids.includes(person.id)) {
        continue;
      }
      ids.push(person.id);
    }

    return ids;
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
        purgeRefusal(
          person,
          now,
          request === null ? cutoff : now,
          request !== null,
        ) !== null
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

      /*
       * What the other erasure-aware domains still hold for this person, read
       * in this transaction and before anything is written.
       *
       * This is what turns closing the request from an assumption into a
       * finding. Every job that erases a person's rows on a granted request
       * runs before this one, and `erasure-request-order.spec.ts` keeps them
       * there - but running first is not getting through: a run that caught a
       * failure for one person and carried on, a run that stopped at its bound
       * and a night the instance was down all leave the order intact and the
       * rows standing. Closing the request on the strength of the order alone
       * is what made those three silent, because no later run selects a person
       * whose request is closed.
       *
       * Nothing here refuses the erasure below. The contact details and the
       * account go tonight whatever the other domains hold; what waits is the
       * record saying the request was carried out.
       */
      const remainder =
        request === null ? [] : await erasureRemainder(tx, personId, now);
      const closing = request !== null && remainder.length === 0;

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
        !closing &&
        cleared.length === 0 &&
        !accountDeleted &&
        invitationsDeleted === 0
      ) {
        // Nothing was there to erase. The eligibility query filters these out,
        // so reaching here means the last of it went while this ran; writing an
        // entry for an erasure that erased nothing would be a false record.
        //
        // A request being closed is the exception: the board was promised the
        // run would happen, so the entry is written and the request closed even
        // when there was nothing left to clear, which is the difference between
        // "we did it" and "we never got to it".
        //
        // A request that cannot close yet is not that exception. The person is
        // selected every night while it is open, so an entry here would be one
        // a night for ever, in a table nobody can tidy - and it would say an
        // erasure had been carried out that had not.
        return null;
      }

      if (closing) {
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
          channel: "SYSTEM",
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
            lastMovedOutOn: formatDateColumn(lastMoveOut),
            purgeOn: formatDateColumn(computePurgeDate(lastMoveOut, days)),
            ...(request === null
              ? {}
              : {
                  requested: true,
                  erasureRequestId: request.id,
                  /*
                   * The evidence the close rests on, or the reason there was
                   * none. Domain names and counts, never a row out of any of
                   * them - ADR 0007, and this entry outlives what it describes.
                   */
                  ...(closing
                    ? {
                        verifiedEmptyOf: ERASURE_DOMAINS.map(
                          (domain) => domain.name,
                        ),
                      }
                    : {
                        erasureRequestLeftOpen:
                          remainder.map(describeRemainder),
                      }),
                }),
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
        erasureRequestClosed: closing,
        erasureRemainder: remainder,
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
 * What refuses this person's purge, or null where nothing does.
 *
 * The same four conditions the scan applies, expressed over objects rather
 * than as a query, because the check that matters is the one taken with the
 * rows locked in front of it.
 *
 * A reason rather than a boolean, so that a granted erasure request the purge
 * will not carry out can say which rule kept it waiting. The strings are for a
 * log line and a run summary: they name a rule and never a row.
 */
function purgeRefusal(
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
): string | null {
  /*
   * A restriction refuses before anything else is considered. Art. 18(2) lets
   * the association store the data and little else, so erasing it is the one
   * act the person has asked it not to perform - and asking for a restriction
   * after asking for erasure is a person changing their mind, which the later
   * request wins.
   */
  if (person.processingRestrictedAt !== null) {
    return "processing is restricted";
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
    return "a board seat is still held";
  }
  if (person.legalHolds.length > 0) {
    return "a legal hold stands";
  }
  if (person.systemRoles.length > 0) {
    return "a system role is still granted";
  }
  /*
   * Somebody who never lived here has no move-out to anchor a purge date on, so
   * the scheduled job leaves them alone. A granted request is a different
   * authority: it names this person, and their contact details and account are
   * service data whether or not they ever held a residency.
   */
  if (person.residencies.length === 0) {
    return onRequest ? null : "no residency to anchor a purge date on";
  }
  return person.residencies.some(
    (residency) =>
      residency.movedOutOn === null ||
      residency.movedOutOn.getTime() > cutoff.getTime(),
  )
    ? onRequest
      ? "a residency is still running"
      : "a residency has not ended long enough ago"
    : null;
}

/**
 * Two reasons in one line, or whichever of them there is.
 *
 * Both halves are optional and neither is worth a sentence of its own: a
 * request waiting on a legal hold with a motion of theirs still open is waiting
 * on both, and a line that named one would send somebody to release a hold that
 * was not the whole of it.
 */
function join(first: string, second: string): string {
  if (first === "") {
    return second;
  }
  if (second === "") {
    return first;
  }
  return `${first}; ${second}`;
}
