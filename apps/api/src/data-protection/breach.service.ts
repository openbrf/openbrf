import { Injectable } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { BreachRisk } from "../generated/prisma/enums";
import { JobQueueService } from "../jobs/job-queue.service";
import { BreachError } from "./breach.error";
import {
  BREACH_NOTIFICATION_HOURS,
  breachState,
  computeBreachDeadline,
  computeBreachReminderAt,
  hoursLeft,
} from "./breach-deadline";
import { BREACH_REMINDER_QUEUE } from "./breach-reminder.queue";

const BREACH_SELECT = {
  id: true,
  title: true,
  description: true,
  occurredAt: true,
  discoveredAt: true,
  personalDataCategories: true,
  dataSubjectCategories: true,
  dataDescription: true,
  affectedCount: true,
  effects: true,
  measures: true,
  risk: true,
  imyNotificationRequired: true,
  imyDecisionGround: true,
  imyNotifiedAt: true,
  imyReference: true,
  delayReasons: true,
  subjectsInformationRequired: true,
  subjectsDecisionGround: true,
  subjectsInformedAt: true,
  decidedAt: true,
  decidedByPersonId: true,
  closedAt: true,
  closedByPersonId: true,
  recordedByPersonId: true,
} as const;

/** The row shape BREACH_SELECT produces, spelled out so the view is typed. */
interface BreachRow {
  id: string;
  title: string;
  description: string;
  occurredAt: Date | null;
  discoveredAt: Date;
  personalDataCategories: string[];
  dataSubjectCategories: string[];
  dataDescription: string;
  affectedCount: number | null;
  effects: string;
  measures: string;
  risk: BreachRisk | null;
  imyNotificationRequired: boolean | null;
  imyDecisionGround: string | null;
  imyNotifiedAt: Date | null;
  imyReference: string | null;
  delayReasons: string | null;
  subjectsInformationRequired: boolean | null;
  subjectsDecisionGround: string | null;
  subjectsInformedAt: Date | null;
  decidedAt: Date | null;
  decidedByPersonId: string | null;
  closedAt: Date | null;
  closedByPersonId: string | null;
  recordedByPersonId: string;
  subjects: readonly { personId: string; informedAt: Date | null }[];
}

/** One breach as the register shows it, with the derived clock on it. */
export interface BreachView {
  breachId: string;
  title: string;
  description: string;
  occurredAt: string | null;
  discoveredAt: string;
  personalDataCategories: string[];
  dataSubjectCategories: string[];
  dataDescription: string;
  affectedCount: number | null;
  effects: string;
  measures: string;
  risk: BreachRisk | null;
  imyNotificationRequired: boolean | null;
  imyDecisionGround: string | null;
  imyNotifiedAt: string | null;
  imyReference: string | null;
  delayReasons: string | null;
  subjectsInformationRequired: boolean | null;
  subjectsDecisionGround: string | null;
  subjectsInformedAt: string | null;
  decidedAt: string | null;
  decidedByPersonId: string | null;
  closedAt: string | null;
  closedByPersonId: string | null;
  recordedByPersonId: string;
  /** The bound art. 33(1) sets, derived from the discovery and never stored. */
  imyNotifyBy: string;
  remindAt: string;
  hoursLeft: number;
  state: "awaitingDecision" | "overdue" | "decided" | "closed";
  subjects: { personId: string; informedAt: string | null }[];
}

/**
 * The register of personal data breaches (personuppgiftsincident).
 *
 * GDPR art. 33(5) requires the controller to document every breach - the facts,
 * its effects and the remedial action - so that a supervisory authority can
 * verify that the association decided lawfully. That is what this is: the
 * record, the clock and the evidence of the decision.
 *
 * It does not notify anybody. The notification is made in IMY's own e-service,
 * and a product that offered a button saying "notify IMY" would be claiming to
 * have done something it cannot do. What it holds instead is when the
 * association became aware, what it decided, on what ground, and when it acted.
 *
 * ## The two decisions
 *
 * Either can lawfully be "no", which is the whole reason both are recorded with
 * their grounds rather than as flags:
 *
 *   IMY is notified without undue delay and, where feasible, within 72 hours of
 *   the association becoming aware - unless the breach is unlikely to result in
 *   a risk to people (art. 33(1)). A notification made later carries the
 *   reasons for the delay, which is why a late notified-at without them is
 *   refused rather than accepted quietly.
 *
 *   The people affected are told where the risk is high (art. 34(1)), unless
 *   one of the exemptions in art. 34(3) applies - encryption, later measures,
 *   or disproportionate effort, in which case a public communication may do
 *   instead. Deciding not to tell them at a high risk therefore requires a
 *   ground naming which exemption; deciding to tell them anyway is accepted at
 *   any risk, because art. 34 sets a floor and a board may go beyond it.
 */
@Injectable()
export class BreachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
  ) {}

  async list(now: Date = new Date()): Promise<BreachView[]> {
    const rows = await this.prisma.personalDataBreach.findMany({
      orderBy: [{ closedAt: "asc" }, { discoveredAt: "desc" }],
      select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
    });
    return rows.map((row) => toView(row, now));
  }

  async read(breachId: string, now: Date = new Date()): Promise<BreachView> {
    const row = await this.prisma.personalDataBreach.findUnique({
      where: { id: breachId },
      select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
    });
    if (row === null) {
      throw new BreachError("There is no such breach.", "breach-not-found");
    }
    return toView(row, now);
  }

  /**
   * Records a breach and schedules the reminder in the same transaction.
   *
   * The queue is created before the transaction opens, because creating one is
   * the queue backend's own work on its own connection.
   */
  async record(input: {
    title: string;
    description: string;
    occurredAt: Date | null;
    discoveredAt: Date;
    personalDataCategories: string[];
    dataSubjectCategories: string[];
    dataDescription: string;
    affectedCount: number | null;
    effects: string;
    measures: string;
    subjectPersonIds: string[];
    actorPersonId: string;
    now?: Date;
  }): Promise<BreachView> {
    const now = input.now ?? new Date();

    assertNoIdentityNumber([
      input.title,
      input.description,
      input.dataDescription,
      input.effects,
      input.measures,
    ]);

    if (input.discoveredAt.getTime() > now.getTime()) {
      // The clock runs from awareness. A discovery in the future would give the
      // association a bound it has not started counting towards yet.
      throw new BreachError(
        "A breach cannot have been discovered in the future.",
        "discovered-in-future",
      );
    }

    if (input.subjectPersonIds.length > 0) {
      const found = await this.prisma.person.count({
        where: { id: { in: input.subjectPersonIds } },
      });
      if (found !== new Set(input.subjectPersonIds).size) {
        throw new BreachError(
          "One of those people is not in the register.",
          "person-not-found",
        );
      }
    }

    await this.jobs.ensureQueue(BREACH_REMINDER_QUEUE);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.personalDataBreach.create({
        data: {
          title: input.title,
          description: input.description,
          occurredAt: input.occurredAt,
          discoveredAt: input.discoveredAt,
          personalDataCategories: input.personalDataCategories,
          dataSubjectCategories: input.dataSubjectCategories,
          dataDescription: input.dataDescription,
          affectedCount: input.affectedCount,
          effects: input.effects,
          measures: input.measures,
          recordedByPersonId: input.actorPersonId,
          subjects: {
            create: [...new Set(input.subjectPersonIds)].map((personId) => ({
              personId,
            })),
          },
        },
        select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
      });

      /*
       * Categories, counts and dates. Never the title, the description or what
       * the breach touched in the board's own words: the log is append-only and
       * outside every purge, so free text copied here would outlive the record
       * it describes and could not be corrected with it.
       */
      await this.audit.record(
        {
          action: "PERSONAL_DATA_BREACH_RECORDED",
          actorPersonId: input.actorPersonId,
          targetKind: "personalDataBreach",
          targetId: row.id,
          context: {
            personalDataCategories: input.personalDataCategories,
            dataSubjectCategories: input.dataSubjectCategories,
            affectedCount: input.affectedCount,
            subjects: input.subjectPersonIds.length,
            occurredAt: input.occurredAt?.toISOString() ?? null,
            discoveredAt: input.discoveredAt.toISOString(),
          },
        },
        tx,
      );

      await this.jobs.sendAtInTransaction(
        tx,
        BREACH_REMINDER_QUEUE,
        {
          breachId: row.id,
          discoveredAt: input.discoveredAt.toISOString(),
        },
        computeBreachReminderAt(input.discoveredAt),
      );

      return row;
    });

    return toView(created, now);
  }

  /**
   * Corrects the facts, or writes down a later act.
   *
   * The facts are frozen by a decision - the record has to show what was
   * decided on - but the notification, the communication and the reasons for a
   * delay are acts that happen afterwards and stay writable.
   */
  async update(
    breachId: string,
    input: {
      title?: string;
      description?: string;
      occurredAt?: Date | null;
      discoveredAt?: Date;
      personalDataCategories?: string[];
      dataSubjectCategories?: string[];
      dataDescription?: string;
      affectedCount?: number | null;
      effects?: string;
      measures?: string;
      imyNotifiedAt?: Date | null;
      imyReference?: string | null;
      subjectsInformedAt?: Date | null;
      delayReasons?: string | null;
      actorPersonId: string;
    },
  ): Promise<BreachView> {
    const existing = await this.prisma.personalDataBreach.findUnique({
      where: { id: breachId },
      select: {
        id: true,
        discoveredAt: true,
        decidedAt: true,
        imyNotifiedAt: true,
        delayReasons: true,
      },
    });
    if (existing === null) {
      throw new BreachError("There is no such breach.", "breach-not-found");
    }

    const LATER_ACTS = new Set([
      "imyNotifiedAt",
      "imyReference",
      "subjectsInformedAt",
      "delayReasons",
      "actorPersonId",
    ]);
    const changed = Object.keys(input).filter(
      (field) => input[field as keyof typeof input] !== undefined,
    );
    if (
      existing.decidedAt !== null &&
      changed.some((field) => !LATER_ACTS.has(field))
    ) {
      throw new BreachError(
        "The facts of a decided breach are the record of what was decided on.",
        "already-decided",
      );
    }

    assertNoIdentityNumber(
      [
        input.title,
        input.description,
        input.dataDescription,
        input.effects,
        input.measures,
        input.delayReasons,
      ].filter((value): value is string => typeof value === "string"),
    );

    const discoveredAt = input.discoveredAt ?? existing.discoveredAt;
    /*
     * The values the row will hold, not the ones this call names. An omitted
     * field leaves the stored one standing, so reading `null` for it would let
     * a later act clear the reasons off a notification the record already says
     * was made after the bound.
     */
    assertDelayReasons({
      discoveredAt,
      imyNotifiedAt:
        input.imyNotifiedAt === undefined
          ? existing.imyNotifiedAt
          : input.imyNotifiedAt,
      delayReasons:
        input.delayReasons === undefined
          ? existing.delayReasons
          : input.delayReasons,
    });

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.personalDataBreach.update({
        where: { id: breachId },
        data: {
          title: input.title,
          description: input.description,
          occurredAt: input.occurredAt,
          discoveredAt: input.discoveredAt,
          personalDataCategories: input.personalDataCategories,
          dataSubjectCategories: input.dataSubjectCategories,
          dataDescription: input.dataDescription,
          affectedCount: input.affectedCount,
          effects: input.effects,
          measures: input.measures,
          imyNotifiedAt: input.imyNotifiedAt,
          imyReference: input.imyReference,
          subjectsInformedAt: input.subjectsInformedAt,
          delayReasons: input.delayReasons,
        },
        select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
      });

      /*
       * A corrected discovery date is a new clock, so a new reminder is
       * enqueued carrying it. The job already on the queue is left alone and
       * no-ops when it fires: its payload no longer matches the row, which is
       * the whole of the cancellation strategy.
       */
      if (input.discoveredAt !== undefined) {
        await this.jobs.sendAtInTransaction(
          tx,
          BREACH_REMINDER_QUEUE,
          {
            breachId,
            discoveredAt: input.discoveredAt.toISOString(),
          },
          computeBreachReminderAt(input.discoveredAt),
        );
      }

      await this.audit.record(
        {
          action: "PERSONAL_DATA_BREACH_UPDATED",
          actorPersonId: input.actorPersonId,
          targetKind: "personalDataBreach",
          targetId: breachId,
          // Which fields moved, never what they now say.
          context: { fields: changed.filter((f) => f !== "actorPersonId") },
        },
        tx,
      );

      return toView(row, new Date());
    });
  }

  /** Records the two decisions art. 33 and art. 34 ask for. */
  async decide(
    breachId: string,
    input: {
      risk: BreachRisk;
      imyNotificationRequired: boolean;
      imyDecisionGround: string;
      imyNotifiedAt?: Date | null;
      imyReference?: string | null;
      delayReasons?: string | null;
      subjectsInformationRequired: boolean;
      subjectsDecisionGround?: string | null;
      actorPersonId: string;
    },
  ): Promise<BreachView> {
    const existing = await this.prisma.personalDataBreach.findUnique({
      where: { id: breachId },
      select: {
        id: true,
        discoveredAt: true,
        decidedAt: true,
        imyNotifiedAt: true,
        delayReasons: true,
      },
    });
    if (existing === null) {
      throw new BreachError("There is no such breach.", "breach-not-found");
    }
    if (existing.decidedAt !== null) {
      throw new BreachError(
        "This breach has already been decided.",
        "already-decided",
      );
    }

    assertNoIdentityNumber(
      [input.imyDecisionGround, input.subjectsDecisionGround].filter(
        (value): value is string => typeof value === "string",
      ),
    );

    if (!input.imyNotificationRequired && input.risk !== "UNLIKELY") {
      /*
       * art. 33(1) excuses notification only where the breach is unlikely to
       * result in a risk. Saying there is a risk and that IMY need not be told
       * is a record that contradicts itself.
       */
      throw new BreachError(
        "IMY is notified unless the breach is unlikely to result in a risk.",
        "risk-inconsistent",
      );
    }

    if (
      !input.subjectsInformationRequired &&
      input.risk === "HIGH" &&
      (input.subjectsDecisionGround ?? "").trim() === ""
    ) {
      // art. 34(3): not telling them at a high risk needs the exemption named.
      throw new BreachError(
        "Not telling the people affected at a high risk names the art. 34(3) exemption relied on.",
        "subjects-ground-required",
      );
    }

    // The values the row will hold, for the reason `update` gives: a decision
    // that omits either field decides about what is already recorded.
    assertDelayReasons({
      discoveredAt: existing.discoveredAt,
      imyNotifiedAt:
        input.imyNotifiedAt === undefined
          ? existing.imyNotifiedAt
          : input.imyNotifiedAt,
      delayReasons:
        input.delayReasons === undefined
          ? existing.delayReasons
          : input.delayReasons,
    });

    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.personalDataBreach.update({
        where: { id: breachId },
        data: {
          risk: input.risk,
          imyNotificationRequired: input.imyNotificationRequired,
          imyDecisionGround: input.imyDecisionGround,
          imyNotifiedAt: input.imyNotifiedAt,
          imyReference: input.imyReference,
          delayReasons: input.delayReasons,
          subjectsInformationRequired: input.subjectsInformationRequired,
          subjectsDecisionGround: input.subjectsDecisionGround,
          decidedAt: now,
          decidedByPersonId: input.actorPersonId,
        },
        select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
      });

      const notifiedAt = input.imyNotifiedAt ?? null;
      await this.audit.record(
        {
          action: "PERSONAL_DATA_BREACH_DECIDED",
          actorPersonId: input.actorPersonId,
          targetKind: "personalDataBreach",
          targetId: breachId,
          context: {
            risk: input.risk,
            imyNotificationRequired: input.imyNotificationRequired,
            subjectsInformationRequired: input.subjectsInformationRequired,
            hoursAfterDiscovery:
              notifiedAt === null
                ? null
                : Math.round(
                    BREACH_NOTIFICATION_HOURS -
                      hoursLeft(existing.discoveredAt, notifiedAt),
                  ),
            notifiedWithinDeadline:
              notifiedAt === null
                ? null
                : notifiedAt.getTime() <=
                  computeBreachDeadline(existing.discoveredAt).getTime(),
          },
        },
        tx,
      );

      return toView(row, now);
    });
  }

  /** Adds one person the breach reached. */
  async addSubject(
    breachId: string,
    personId: string,
    actorPersonId: string,
  ): Promise<BreachView> {
    await this.requireBreach(breachId);

    const person = await this.prisma.person.count({ where: { id: personId } });
    if (person === 0) {
      throw new BreachError("There is no such person.", "person-not-found");
    }

    const already = await this.prisma.personalDataBreachSubject.count({
      where: { breachId, personId },
    });
    if (already > 0) {
      throw new BreachError(
        "That person is already recorded on this breach.",
        "already-subject",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.personalDataBreachSubject.create({
        data: { breachId, personId },
      });

      /*
       * Recorded as a change to the breach, with the person as its subject.
       * Saying that somebody's data was reached is a statement about them, so
       * their own access report has to be able to show that the association
       * made it - and who made it.
       */
      await this.audit.record(
        {
          action: "PERSONAL_DATA_BREACH_UPDATED",
          actorPersonId,
          targetPersonId: personId,
          targetKind: "personalDataBreach",
          targetId: breachId,
          context: { fields: ["subjects"] },
        },
        tx,
      );

      const row = await tx.personalDataBreach.findUniqueOrThrow({
        where: { id: breachId },
        select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
      });
      return toView(row, new Date());
    });
  }

  /** Records that one person has been told (art. 34). */
  async markSubjectInformed(
    breachId: string,
    personId: string,
    actorPersonId: string,
  ): Promise<BreachView> {
    await this.requireBreach(breachId);

    return this.prisma.$transaction(async (tx) => {
      /*
       * Only a subject who has not been told yet. The instant recorded here is
       * when the art. 34 communication was made, and there is one of those: a
       * second click would move the date the association would show a
       * supervisory authority, and it is the first one that happened.
       */
      const { count } = await tx.personalDataBreachSubject.updateMany({
        where: { breachId, personId, informedAt: null },
        data: { informedAt: new Date() },
      });

      if (count === 0) {
        const subject = await tx.personalDataBreachSubject.findFirst({
          where: { breachId, personId },
          select: { informedAt: true },
        });
        if (subject === null) {
          /*
           * Nobody by that id is recorded as a subject of this breach. The
           * audit entry below is append-only and outside every purge, so
           * writing it here would assert an art. 34 communication about data
           * this breach never reached, on a row the association could not
           * afterwards withdraw.
           */
          throw new BreachError(
            "That person is not a subject of this breach.",
            "person-not-found",
          );
        }

        /*
         * Already told, so this changed nothing and the log says nothing. A
         * second entry would read as a second communication that never
         * happened, on a person's own access report.
         */
        const unchanged = await tx.personalDataBreach.findUniqueOrThrow({
          where: { id: breachId },
          select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
        });
        return toView(unchanged, new Date());
      }

      // The subject is the person, so their own access report shows that the
      // association told them about a breach that reached their data.
      await this.audit.record(
        {
          action: "PERSONAL_DATA_BREACH_SUBJECT_INFORMED",
          actorPersonId,
          targetPersonId: personId,
          targetKind: "personalDataBreach",
          targetId: breachId,
        },
        tx,
      );

      const row = await tx.personalDataBreach.findUniqueOrThrow({
        where: { id: breachId },
        select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
      });
      return toView(row, new Date());
    });
  }

  /** Closes a decided breach. */
  async close(breachId: string, actorPersonId: string): Promise<BreachView> {
    const existing = await this.requireBreach(breachId);
    if (existing.decidedAt === null) {
      // A breach closed without a decision would be the record of a question
      // nobody answered.
      throw new BreachError(
        "A breach is decided before it is closed.",
        "not-decided",
      );
    }
    if (existing.closedAt !== null) {
      /*
       * Closing twice would rewrite who finished with the breach and when. The
       * first closure is the fact the record holds, and a second board member
       * clicking the same button a moment later is what this refuses.
       */
      throw new BreachError(
        "This breach has already been closed.",
        "already-closed",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      /*
       * The state the transition needs, asked as part of the write. The two
       * refusals above answer the board in a sentence it can act on, but they
       * read outside this transaction: two board members clicking within the
       * same moment would both pass them, and the second would rewrite who
       * finished with the breach and append a second closure to a log that
       * cannot be corrected.
       */
      const { count } = await tx.personalDataBreach.updateMany({
        where: { id: breachId, decidedAt: { not: null }, closedAt: null },
        data: { closedAt: new Date(), closedByPersonId: actorPersonId },
      });
      if (count === 0) {
        throw new BreachError(
          "This breach has already been closed.",
          "already-closed",
        );
      }

      await this.audit.record(
        {
          action: "PERSONAL_DATA_BREACH_CLOSED",
          actorPersonId,
          targetKind: "personalDataBreach",
          targetId: breachId,
        },
        tx,
      );

      const row = await tx.personalDataBreach.findUniqueOrThrow({
        where: { id: breachId },
        select: { ...BREACH_SELECT, subjects: SUBJECT_SELECT },
      });
      return toView(row, new Date());
    });
  }

  private async requireBreach(breachId: string): Promise<{
    id: string;
    discoveredAt: Date;
    decidedAt: Date | null;
    closedAt: Date | null;
  }> {
    const row = await this.prisma.personalDataBreach.findUnique({
      where: { id: breachId },
      select: {
        id: true,
        discoveredAt: true,
        decidedAt: true,
        closedAt: true,
      },
    });
    if (row === null) {
      throw new BreachError("There is no such breach.", "breach-not-found");
    }
    return row;
  }
}

/**
 * The subjects a breach reached, oldest first.
 *
 * Not `as const`: Prisma's relation arguments are mutable, and a readonly
 * orderBy is not assignable to them.
 */
const SUBJECT_SELECT = {
  orderBy: [{ createdAt: "asc" }],
  select: { personId: true, informedAt: true },
} satisfies { orderBy: { createdAt: "asc" }[]; select: object };

/**
 * A notification made later than the bound carries the reasons for the delay
 * (art. 33(1), last sentence).
 *
 * Checked wherever a notified-at can be written, so a late notification entered
 * after the decision cannot slip past the rule the decision enforced.
 */
function assertDelayReasons(input: {
  discoveredAt: Date;
  imyNotifiedAt: Date | null;
  delayReasons: string | null;
}): void {
  if (input.imyNotifiedAt === null) {
    return;
  }
  const late =
    input.imyNotifiedAt.getTime() >
    computeBreachDeadline(input.discoveredAt).getTime();
  if (late && (input.delayReasons ?? "").trim() === "") {
    throw new BreachError(
      "A notification made after 72 hours carries the reasons for the delay.",
      "delay-reasons-required",
    );
  }
}

/** Refuses an identity number in anything the board typed. */
function assertNoIdentityNumber(values: readonly (string | undefined)[]): void {
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    for (const _hit of scanForPersonalIdentityNumbers(value)) {
      throw new BreachError(
        "Write what happened without a personal identity number in it.",
        "personal-identity-number",
      );
    }
  }
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toView(row: BreachRow, now: Date): BreachView {
  const deadline = computeBreachDeadline(row.discoveredAt);

  return {
    breachId: row.id,
    title: row.title,
    description: row.description,
    occurredAt: toIso(row.occurredAt),
    discoveredAt: row.discoveredAt.toISOString(),
    personalDataCategories: row.personalDataCategories,
    dataSubjectCategories: row.dataSubjectCategories,
    dataDescription: row.dataDescription,
    affectedCount: row.affectedCount,
    effects: row.effects,
    measures: row.measures,
    risk: row.risk,
    imyNotificationRequired: row.imyNotificationRequired,
    imyDecisionGround: row.imyDecisionGround,
    imyNotifiedAt: toIso(row.imyNotifiedAt),
    imyReference: row.imyReference,
    delayReasons: row.delayReasons,
    subjectsInformationRequired: row.subjectsInformationRequired,
    subjectsDecisionGround: row.subjectsDecisionGround,
    subjectsInformedAt: toIso(row.subjectsInformedAt),
    decidedAt: toIso(row.decidedAt),
    decidedByPersonId: row.decidedByPersonId,
    closedAt: toIso(row.closedAt),
    closedByPersonId: row.closedByPersonId,
    recordedByPersonId: row.recordedByPersonId,
    imyNotifyBy: deadline.toISOString(),
    remindAt: computeBreachReminderAt(row.discoveredAt).toISOString(),
    hoursLeft: hoursLeft(row.discoveredAt, now),
    state: breachState(row, now),
    subjects: row.subjects.map((subject) => ({
      personId: subject.personId,
      informedAt: toIso(subject.informedAt),
    })),
  };
}
