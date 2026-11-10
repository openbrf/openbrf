import { HttpStatus, Injectable } from "@nestjs/common";
import {
  type IssueAccessPart,
  type IssueAccessWithholdingReason,
  isGivenInPartOf,
  issueAccessPartHasId,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { issuesConcerningPerson } from "../issues/issue-concerned-persons";
import { lockIssue } from "../issues/issue-lock";
import { ISSUE_MESSAGE_ORDER } from "../issues/issue-message-view";
import {
  ISSUE_NOTE_ORDER,
  KEYED_WEIGHING_SELECT,
  type StandingWeighing,
  strictestWeighing,
  WEIGHED_NOTE_SELECT,
  WEIGHED_WORK_ORDER_SELECT,
  WEIGHING_SELECT,
  weighingKey,
  WORK_ORDER_ORDER,
  weighingsByText,
} from "./issue-access-weighing";

/**
 * Why a weighing was refused. Codes for the screen to translate, never the
 * text of the issue.
 *
 * - `issue-not-in-report`: the issue is not one the person's report carries,
 *   neither reported by them nor recorded as concerning them. Answered as not
 *   found, as an unknown issue is.
 * - `text-not-weighable`: a text named is not one this report weighs: not on
 *   the issue, redacted, removed, or a part the reporter's report does not
 *   weigh (it weighs only the notes and the work orders' text). Also a text
 *   named twice.
 * - `reason-not-allowed`: the reporter's own report cannot leave a text out
 *   for telling them who reported their own case.
 * - `copy-not-in-part`: a text given in part came with a copy that is not the
 *   text with words left out: it adds or moves a word, marks no place where
 *   one was left out, or keeps nothing or everything. Or it came with no
 *   reason for what it leaves out.
 */
export class IssueAccessWeighingError extends DomainError {
  readonly status: number;

  constructor(
    readonly reason:
      | "issue-not-in-report"
      | "text-not-weighable"
      | "reason-not-allowed"
      | "copy-not-in-part",
    message: string,
  ) {
    super(message);
    this.status =
      reason === "issue-not-in-report"
        ? HttpStatus.NOT_FOUND
        : HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

/** One text the board weighs, with its words, for the board alone. */
export interface IssueAccessWeighingText {
  part: IssueAccessPart;
  /**
   * The message, the note or the work order; null for the description and the
   * location.
   */
  id: string | null;
  /** When it was written; the issue's report date for its description. */
  writtenAt: string;
  /**
   * Whose side wrote a message: the reporter's or a handler's. Null for the
   * description, the location and a note.
   */
  side: "REPORTER" | "HANDLER" | null;
  /**
   * Whom a work order went to, as the mail addressed them, so the board can
   * tell one from another; null once the contractor was removed from the list,
   * and for every other part.
   */
  recipientName: string | null;
  text: string;
  /**
   * The weighing that stands: `given`, the reason it is left out, whole or in
   * part, or null while nobody has weighed it for this report.
   */
  decision: "given" | IssueAccessWithholdingReason | null;
  /**
   * The board's copy where it gave the text in part, which the report gives
   * instead of the text; null where it is given whole, left out whole or not
   * weighed.
   */
  givenText: string | null;
}

/**
 * The texts of one issue that one person's access report weighs, as the board
 * reads them to weigh them. Never part of the report: the report carries only
 * what the board gave.
 */
export interface IssueAccessWeighingView {
  issueId: string;
  number: number;
  typeName: string;
  /**
   * Whose report: the person reported the issue (`reporter`), or a handler
   * recorded it as concerning them (`concerned`). The first weighs the notes
   * and the work orders' text, the second every text, and only the second may
   * leave one out for telling who reported the case.
   */
  report: "reporter" | "concerned";
  texts: IssueAccessWeighingText[];
}

/**
 * One text's weighing, as the board sends it: no reason to give it whole, a
 * reason to leave it out whole, or a reason and a copy to give it in part.
 */
export interface IssueAccessDecisionInput {
  part: IssueAccessPart;
  id: string | null;
  withheldBecause: IssueAccessWithholdingReason | null;
  givenText: string | null;
}

type Db = Prisma.TransactionClient;

/**
 * The board's weighing under GDPR art. 15(4) of what of an issue's text goes
 * into one person's access report (access weighing, ADR 0057).
 *
 * Held by whoever may produce the report: the weighing is part of producing
 * it, and the producer reads every text the report would carry. The words are
 * read here for the board to weigh, and never written to the log; the report
 * gives only what the board gave. A read is logged against the person whose
 * report it is, as a weighing is, and never the issue or a text. A text given in part is given as the board's
 * copy of it, which can only take words out (`isGivenInPartOf`), so the text
 * itself stays as written for the issue and for every other report.
 *
 * A weighing replaces the one before it for that report and issue, in one
 * transaction under the issue's lock, so two board members weighing at once
 * leave one weighing whole rather than a mix. A text written after the board
 * read the issue, and so not in what it sent, stays unweighed.
 */
@Injectable()
export class IssueAccessWeighingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async read(input: {
    personId: string;
    issueId: string;
    actorPersonId: string;
  }): Promise<IssueAccessWeighingView> {
    return this.prisma.$transaction(
      async (tx) => {
        const view = await this.viewIn(tx, input.personId, input.issueId);
        /*
         * The words of the case go to the board member here, so the read is
         * logged, in the transaction that reads, before any of them leave.
         * Against the person whose report it is and never the issue, for the
         * reason the weighing's own entry gives below; nor any text. An issue
         * not on the report is refused before anything is read or logged.
         */
        await this.audit.record(
          {
            action: "ISSUE_ACCESS_WEIGHING_READ",
            channel: "WEB",
            actorPersonId: input.actorPersonId,
            targetPersonId: input.personId,
            context: { texts: view.texts.length },
          },
          tx,
        );
        return view;
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  async weigh(input: {
    personId: string;
    issueId: string;
    actorPersonId: string;
    decisions: readonly IssueAccessDecisionInput[];
  }): Promise<IssueAccessWeighingView> {
    return this.prisma.$transaction(async (tx) => {
      // The lock a redaction, the purge and every write on the issue take, so
      // the texts read below are the ones that stand when this commits.
      await lockIssue(tx, input.issueId);
      const view = await this.viewIn(tx, input.personId, input.issueId);
      const record =
        view.report === "concerned"
          ? await recordOf(tx, input.personId, input.issueId)
          : null;

      const weighable = new Map(
        view.texts.map((text) => [weighingKey(text.part, text.id), text]),
      );
      const seen = new Set<string>();
      for (const decision of input.decisions) {
        const key = weighingKey(decision.part, decision.id);
        const text = weighable.get(key);
        if (
          text === undefined ||
          seen.has(key) ||
          (decision.id !== null) !== issueAccessPartHasId(decision.part)
        ) {
          throw new IssueAccessWeighingError(
            "text-not-weighable",
            "A text named is not one this report weighs.",
          );
        }
        seen.add(key);
        if (
          view.report === "reporter" &&
          decision.withheldBecause === "IDENTIFIES_REPORTER"
        ) {
          throw new IssueAccessWeighingError(
            "reason-not-allowed",
            "A reporter's own report does not leave a text out for naming them.",
          );
        }
        if (
          decision.givenText !== null &&
          (decision.withheldBecause === null ||
            !isGivenInPartOf(decision.givenText, text.text))
        ) {
          throw new IssueAccessWeighingError(
            "copy-not-in-part",
            "A text given in part needs a reason and a copy that only leaves words out.",
          );
        }
      }

      await tx.issueAccessWeighing.deleteMany({
        where: { issueId: input.issueId, concernedPersonId: record },
      });
      if (input.decisions.length > 0) {
        await tx.issueAccessWeighing.createMany({
          data: input.decisions.map((decision) => ({
            issueId: input.issueId,
            concernedPersonId: record,
            part: decision.part,
            messageId: decision.part === "MESSAGE" ? decision.id : null,
            noteId: decision.part === "NOTE" ? decision.id : null,
            workOrderId: decision.part === "WORK_ORDER" ? decision.id : null,
            withheldBecause: decision.withheldBecause,
            givenText: decision.givenText,
          })),
        });
      }

      const given = input.decisions.filter(
        (decision) => decision.withheldBecause === null,
      ).length;
      const givenInPart = input.decisions.filter(
        (decision) => decision.givenText !== null,
      ).length;
      /*
       * The person whose report it is and how much was weighed, never the
       * issue: the log is never purged, and an entry naming the issue beside
       * the person would keep for good that the case concerned them, after
       * the record and its text are gone (as `ISSUE_CONCERNED_PERSON_ADDED`
       * keeps the person out). Nor any text, the copies given in part
       * included.
       */
      await this.audit.record(
        {
          action: "ISSUE_ACCESS_WEIGHED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          context: {
            given,
            givenInPart,
            withheld: input.decisions.length - given - givenInPart,
          },
        },
        tx,
      );

      return this.viewIn(tx, input.personId, input.issueId);
    });
  }

  /**
   * The issue as this person's report weighs it, or the refusal that it is
   * not on their report.
   */
  private async viewIn(
    tx: Db,
    personId: string,
    issueId: string,
  ): Promise<IssueAccessWeighingView> {
    const reported = await tx.issue.findFirst({
      where: { id: issueId, reporterPersonId: personId },
      select: {
        id: true,
        number: true,
        type: { select: { name: true } },
        notes: {
          orderBy: ISSUE_NOTE_ORDER,
          select: {
            ...WEIGHED_NOTE_SELECT,
            accessWeighings: {
              where: { concernedPersonId: null },
              select: WEIGHING_SELECT,
            },
          },
        },
        workOrders: {
          orderBy: WORK_ORDER_ORDER,
          select: {
            ...WEIGHED_WORK_ORDER_SELECT,
            accessWeighings: {
              where: { concernedPersonId: null },
              select: WEIGHING_SELECT,
            },
          },
        },
      },
    });
    if (reported !== null) {
      return {
        issueId: reported.id,
        number: reported.number,
        typeName: reported.type.name,
        report: "reporter",
        texts: [
          ...reported.notes.flatMap((note) =>
            standing(note.body, note.redactedAt)
              ? [
                  {
                    part: "NOTE" as const,
                    id: note.id,
                    writtenAt: note.createdAt.toISOString(),
                    side: null,
                    recipientName: null,
                    text: note.body,
                    ...decisionOf(strictestWeighing(note.accessWeighings)),
                  },
                ]
              : [],
          ),
          ...reported.workOrders.flatMap((order) =>
            workOrderText(order, strictestWeighing(order.accessWeighings)),
          ),
        ],
      };
    }

    const concerning = await tx.issue.findFirst({
      where: { id: issueId, ...issuesConcerningPerson(personId) },
      select: {
        id: true,
        number: true,
        description: true,
        descriptionRedactedAt: true,
        location: true,
        locationRedactedAt: true,
        createdAt: true,
        type: { select: { name: true } },
        concernedPersons: {
          where: { personId },
          select: {
            accessWeighings: { select: KEYED_WEIGHING_SELECT },
          },
        },
        messages: {
          orderBy: ISSUE_MESSAGE_ORDER,
          select: {
            id: true,
            side: true,
            body: true,
            redactedAt: true,
            createdAt: true,
          },
        },
        notes: { orderBy: ISSUE_NOTE_ORDER, select: WEIGHED_NOTE_SELECT },
        workOrders: {
          orderBy: WORK_ORDER_ORDER,
          select: WEIGHED_WORK_ORDER_SELECT,
        },
      },
    });
    if (concerning === null) {
      throw new IssueAccessWeighingError(
        "issue-not-in-report",
        "The issue is not on this person's access report.",
      );
    }
    const weighings = weighingsByText(
      concerning.concernedPersons[0]?.accessWeighings ?? [],
    );
    const decided = (part: IssueAccessPart, id: string | null) =>
      decisionOf(weighings.get(weighingKey(part, id)));
    const reportedAt = concerning.createdAt.toISOString();
    const texts: IssueAccessWeighingText[] = [];
    if (standing(concerning.description, concerning.descriptionRedactedAt)) {
      texts.push({
        part: "DESCRIPTION",
        id: null,
        writtenAt: reportedAt,
        side: null,
        recipientName: null,
        text: concerning.description,
        ...decided("DESCRIPTION", null),
      });
    }
    if (
      concerning.location !== null &&
      standing(concerning.location, concerning.locationRedactedAt)
    ) {
      texts.push({
        part: "LOCATION",
        id: null,
        writtenAt: reportedAt,
        side: null,
        recipientName: null,
        text: concerning.location,
        ...decided("LOCATION", null),
      });
    }
    for (const message of concerning.messages) {
      if (standing(message.body, message.redactedAt)) {
        texts.push({
          part: "MESSAGE",
          id: message.id,
          writtenAt: message.createdAt.toISOString(),
          side: message.side,
          recipientName: null,
          text: message.body,
          ...decided("MESSAGE", message.id),
        });
      }
    }
    for (const note of concerning.notes) {
      if (standing(note.body, note.redactedAt)) {
        texts.push({
          part: "NOTE",
          id: note.id,
          writtenAt: note.createdAt.toISOString(),
          side: null,
          recipientName: null,
          text: note.body,
          ...decided("NOTE", note.id),
        });
      }
    }
    for (const order of concerning.workOrders) {
      texts.push(
        ...workOrderText(
          order,
          weighings.get(weighingKey("WORK_ORDER", order.id)),
        ),
      );
    }
    return {
      issueId: concerning.id,
      number: concerning.number,
      typeName: concerning.type.name,
      report: "concerned",
      texts,
    };
  }
}

/** The record through which the issue concerns the person. */
async function recordOf(
  tx: Db,
  personId: string,
  issueId: string,
): Promise<string> {
  const record = await tx.issueConcernedPerson.findUniqueOrThrow({
    where: { issueId_personId: { issueId, personId } },
    select: { id: true },
  });
  return record.id;
}

/**
 * A work order's text as the board weighs it, or nothing where a handler
 * redacted it or the purge erased it: there is nothing left of it to give.
 */
function workOrderText(
  order: Prisma.WorkOrderGetPayload<{
    select: typeof WEIGHED_WORK_ORDER_SELECT;
  }>,
  weighing: StandingWeighing | undefined,
): IssueAccessWeighingText[] {
  if (order.body === null || !standing(order.body, order.redactedAt)) {
    return [];
  }
  return [
    {
      part: "WORK_ORDER",
      id: order.id,
      writtenAt: order.createdAt.toISOString(),
      side: null,
      recipientName: order.recipientName,
      text: order.body,
      ...decisionOf(weighing),
    },
  ];
}

/** A text there is something of to give: not redacted, not removed. */
function standing(text: string, redactedAt: Date | null): boolean {
  return redactedAt === null && text !== "";
}

function decisionOf(
  weighing: StandingWeighing | undefined,
): Pick<IssueAccessWeighingText, "decision" | "givenText"> {
  return weighing === undefined
    ? { decision: null, givenText: null }
    : {
        decision: weighing.withheldBecause ?? "given",
        givenText: weighing.givenText,
      };
}
