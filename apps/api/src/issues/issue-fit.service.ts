import { Injectable, Logger } from "@nestjs/common";
import {
  compareLocalDays,
  dateColumnOf,
  findDoorCode,
  formatDateColumn,
  type IssueEntryAnswer,
  type IssueFindingKind,
  localDayOf,
  localDayOfColumn,
  parseLocalDay,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { refusePersonalIdentityNumbers } from "./issue-conversation.service";
import { requireFindingTargetDate } from "./issue-finding-rule";
import {
  ENTRY_SELECT,
  type IssueEntryView,
  NO_ENTRY_PERMISSION,
  toEntryView,
} from "./issue-fit-views";
import { requireHandledIssue } from "./issue-handlers";
import { lockIssue, lockIssueForHandling } from "./issue-lock";
import { IssueError } from "./issue.error";
import { IssueService, type QueuedIssueView } from "./issue.service";

/**
 * A resident's answer to whether the association may enter (decision 29).
 *
 * A no carries nothing else. A yes carries whether there are pets and whether
 * the master key may be used, both stated (absent is no), and optionally a note
 * on how to get in and the last day the permission stands.
 */
export interface IssueEntryInput {
  answer: IssueEntryAnswer;
  note?: string | null;
  pets?: boolean;
  masterKey?: boolean;
  /** `YYYY-MM-DD`. */
  until?: string | null;
}

/** The mark of an inspection finding (decision 31), with its target date. */
export interface IssueFindingInput {
  kind: IssueFindingKind;
  /** The day of the inspection, `YYYY-MM-DD`. */
  inspectedOn: string;
  /** One of the issue's own handler files: the protocol. */
  protocolAttachmentId: string;
  /** The finding's real date, `YYYY-MM-DD`, written as the issue's target date. */
  targetDate: string;
}

/**
 * What is particular to a Swedish house on an issue: the resident's permission
 * to enter (tillträde, decision 29), the common-area place it is about
 * (decision 30) and the mark of an inspection finding (decision 31).
 *
 * ## Permission to enter
 *
 * On an issue about an apartment, answered by the resident who reported it or,
 * from what the resident said by telephone, by a handler. The right of entry
 * is the association's under BRL 7 kap. 13 §; this records whether the
 * resident has said yes and what a contractor at the door should know.
 * Personal data about somebody's home, so it is:
 * - cleared when the issue closes, in the transaction that closes it
 *   (`IssueService.setStatus`), and held to that by a database constraint;
 * - refused after that, on an issue that is done;
 * - never a door code. The note is refused when it reads like one
 *   (`findDoorCode`), with where it starts and never the value, because a code
 *   in a note is read by every handler and kept in every copy.
 *
 * The entry names the person who acted and the facts - the answer, whether pets
 * and the master key were stated, the expiry day - and never the note. By the
 * reporter themselves it is flagged `byReporter`, so the timeline can show it
 * without naming the reporter.
 *
 * ## Place
 *
 * One place from the association's list, set on filing or by a handler. A
 * building fact: it stays when the free text goes.
 *
 * ## Finding
 *
 * The issue is marked as a finding of an OVK, lift or fire inspection, with the
 * protocol (one of its handler-only files), the inspection's day and a real due
 * date, which is the issue's target date so the Overdue view reads it as it
 * reads any other. A lift's target date is held to a month from the inspection
 * (BFS 2025:11 1 kap. 17 §); the other kinds have the handler's date.
 */
@Injectable()
export class IssueFitService {
  private readonly logger = new Logger(IssueFitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly issues: IssueService,
  ) {}

  /** The reporter answers the entry question on their own issue. */
  async answerEntry(
    reporterPersonId: string,
    issueId: string,
    input: IssueEntryInput,
  ): Promise<IssueEntryView | null> {
    const data = entryData(input, false);
    return this.prisma.$transaction(async (tx) => {
      await lockIssue(tx, issueId);
      const issue = await this.requireReported(tx, issueId, reporterPersonId);
      return this.writeEntry(tx, issue, data, reporterPersonId, true);
    });
  }

  /** The reporter withdraws their answer. */
  async withdrawEntry(
    reporterPersonId: string,
    issueId: string,
  ): Promise<IssueEntryView | null> {
    return this.prisma.$transaction(async (tx) => {
      await lockIssue(tx, issueId);
      const issue = await this.requireReported(tx, issueId, reporterPersonId);
      return this.writeEntry(tx, issue, null, reporterPersonId, true);
    });
  }

  /**
   * A handler records the resident's answer, given by telephone or at the
   * door. The note is a text the board writes, so it is scanned for a personal
   * identity number as every such text is.
   */
  async answerEntryAsHandler(
    handlerPersonId: string,
    issueId: string,
    input: IssueEntryInput,
  ): Promise<IssueEntryView | null> {
    const data = entryData(input, true);
    return this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandled(tx, issueId, handlerPersonId);
      return this.writeEntry(tx, issue, data, handlerPersonId, false);
    });
  }

  /** A handler takes the resident's answer off the issue. */
  async withdrawEntryAsHandler(
    handlerPersonId: string,
    issueId: string,
  ): Promise<IssueEntryView | null> {
    return this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandled(tx, issueId, handlerPersonId);
      return this.writeEntry(tx, issue, null, handlerPersonId, false);
    });
  }

  /** Sets the common-area place of an issue, or takes it off. */
  async setPlace(
    handlerPersonId: string,
    issueId: string,
    placeId: string | null,
  ): Promise<QueuedIssueView> {
    await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandled(tx, issueId, handlerPersonId);
      if (placeId !== null && placeId !== issue.placeId) {
        const place = await tx.issuePlace.findFirst({
          where: { id: placeId, active: true },
          select: { id: true },
        });
        if (place === null) {
          throw new IssueError("No such place.", "place-not-found");
        }
      }
      if (placeId === issue.placeId) {
        return;
      }
      await this.audit.record(
        {
          action: "ISSUE_PLACE_CHANGED",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          // By identifier: the name is the board's text and may be renamed.
          context: { from: issue.placeId, to: placeId },
        },
        tx,
      );
      await tx.issue.update({ where: { id: issueId }, data: { placeId } });
    });
    this.logger.log(`Issue ${issueId} place changed`);
    return this.issues.queuedIssue(handlerPersonId, issueId, "show");
  }

  /**
   * Marks an issue as a finding of an inspection, or changes the mark (decision
   * 31). The protocol must be one of the issue's own handler files, and the due
   * date is written as the issue's target date in the same transaction.
   */
  async markFinding(
    handlerPersonId: string,
    issueId: string,
    input: IssueFindingInput,
  ): Promise<QueuedIssueView> {
    const inspectedOn = requireDay(input.inspectedOn);
    const targetDate = requireDay(input.targetDate);
    requireFindingTargetDate(input.kind, input.inspectedOn, input.targetDate);

    await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandled(tx, issueId, handlerPersonId);
      if (issue.closedAt !== null || issue.status.meaning === "DONE") {
        throw new IssueError("The issue is done.", "issue-closed");
      }
      const protocol = await tx.issueAttachment.findFirst({
        where: { id: input.protocolAttachmentId, issueId },
        select: { id: true },
      });
      if (protocol === null) {
        throw new IssueError(
          "That file is not one of this issue's.",
          "finding-protocol-not-found",
        );
      }

      const existing = await tx.issueFinding.findUnique({
        where: { issueId },
        select: { kind: true, inspectedOn: true, protocolAttachmentId: true },
      });
      const unchanged =
        existing !== null &&
        existing.kind === input.kind &&
        formatDateColumn(existing.inspectedOn) === input.inspectedOn &&
        existing.protocolAttachmentId === protocol.id &&
        formatDateColumn(issue.targetDate) === input.targetDate;
      if (unchanged) {
        return;
      }

      const data = {
        kind: input.kind,
        inspectedOn: dateColumnOf(inspectedOn),
        protocolAttachmentId: protocol.id,
      };
      await tx.issueFinding.upsert({
        where: { issueId },
        create: { issueId, ...data },
        update: data,
      });
      if (formatDateColumn(issue.targetDate) !== input.targetDate) {
        await this.audit.record(
          {
            action: "ISSUE_TARGET_DATE_CHANGED",
            channel: "WEB",
            actorPersonId: handlerPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: {
              from: formatDateColumn(issue.targetDate),
              to: input.targetDate,
            },
          },
          tx,
        );
      }
      await tx.issue.update({
        where: { id: issueId },
        data: { targetDate: dateColumnOf(targetDate) },
      });
      await this.audit.record(
        {
          action: "ISSUE_FINDING_MARKED",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          // Facts about the finding. The protocol by its attachment, never the
          // file's name: a handler's file name is free text about a case.
          context: {
            kind: input.kind,
            inspectedOn: input.inspectedOn,
            targetDate: input.targetDate,
            protocolAttachmentId: protocol.id,
          },
        },
        tx,
      );
    });
    this.logger.log(`Issue ${issueId} marked as a finding`);
    return this.issues.queuedIssue(handlerPersonId, issueId, "show");
  }

  /** Takes the mark off. The target date stays; a handler may clear it. */
  async removeFinding(
    handlerPersonId: string,
    issueId: string,
  ): Promise<QueuedIssueView> {
    await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      await this.requireHandled(tx, issueId, handlerPersonId);
      const { count } = await tx.issueFinding.deleteMany({
        where: { issueId },
      });
      if (count === 0) {
        return;
      }
      await this.audit.record(
        {
          action: "ISSUE_FINDING_REMOVED",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          context: {},
        },
        tx,
      );
    });
    this.logger.log(`Issue ${issueId} is no longer marked as a finding`);
    return this.issues.queuedIssue(handlerPersonId, issueId, "show");
  }

  /**
   * Writes an entry permission, or clears it with `data` null, on an issue that
   * is about an apartment and not done. The issue lock is held by the caller.
   */
  private async writeEntry(
    tx: Prisma.TransactionClient,
    issue: EntryTarget,
    data: EntryData | null,
    actorPersonId: string,
    byReporter: boolean,
  ): Promise<IssueEntryView | null> {
    if (issue.closedAt !== null || issue.status.meaning === "DONE") {
      throw new IssueError("The issue is done.", "issue-closed");
    }
    if (data !== null && issue.apartmentId === null) {
      throw new IssueError(
        "Permission to enter belongs to an issue about an apartment.",
        "entry-needs-apartment",
      );
    }
    const today = localDayOf(new Date());
    if (
      data?.entryUntil != null &&
      compareLocalDays(localDayOfColumn(data.entryUntil), today) < 0
    ) {
      throw new IssueError(
        "The permission would already have lapsed.",
        "entry-until-past",
      );
    }

    const next = data ?? NO_ENTRY_PERMISSION;
    const changed =
      issue.entryAnswer !== next.entryAnswer ||
      issue.entryNote !== next.entryNote ||
      issue.entryPets !== next.entryPets ||
      issue.entryMasterKey !== next.entryMasterKey ||
      formatDateColumn(issue.entryUntil) !== formatDateColumn(next.entryUntil);
    if (changed && (data !== null || issue.entryAnswer !== null)) {
      await this.audit.record(
        {
          action:
            data === null
              ? "ISSUE_ENTRY_PERMISSION_REMOVED"
              : "ISSUE_ENTRY_PERMISSION_SET",
          channel: "WEB",
          actorPersonId,
          targetKind: "issue",
          targetId: issue.id,
          // Facts, never the note: it is about somebody's home.
          context:
            data === null
              ? { byReporter }
              : {
                  answer: data.entryAnswer,
                  pets: data.entryPets,
                  masterKey: data.entryMasterKey,
                  until: formatDateColumn(data.entryUntil),
                  byReporter,
                },
        },
        tx,
      );
    }
    /*
     * The reporter's own write also names the reporter. The issue was read
     * above, but a purge of that person can detach and clear it before this
     * write lands (it takes the locks of the issues it found, and an issue
     * filed after that is not among them); at READ COMMITTED the update
     * re-checks the filter once the purge's row lock lets go, finds no row,
     * and the answer is refused instead of leaving entry details on an issue
     * the erasure was recorded as having cleared.
     */
    const { count } = await tx.issue.updateMany({
      where: byReporter
        ? { id: issue.id, reporterPersonId: actorPersonId }
        : { id: issue.id },
      data: next,
    });
    if (count === 0) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    const written = await tx.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: ENTRY_SELECT,
    });
    this.logger.log(`Issue ${issue.id} entry permission changed`);
    return toEntryView(written, today);
  }

  /** An issue this person reported, with what an entry write reads. */
  private async requireReported(
    tx: Prisma.TransactionClient,
    issueId: string,
    reporterPersonId: string,
  ): Promise<EntryTarget> {
    const issue = await tx.issue.findFirst({
      where: { id: issueId, reporterPersonId },
      select: ENTRY_TARGET_SELECT,
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    return issue;
  }

  /** An issue this person handles (`requireHandledIssue`). */
  private async requireHandled(
    tx: Prisma.TransactionClient,
    issueId: string,
    readerPersonId: string,
  ): Promise<EntryTarget> {
    return requireHandledIssue(
      tx,
      issueId,
      readerPersonId,
      ENTRY_TARGET_SELECT,
    );
  }
}

const ENTRY_TARGET_SELECT = {
  id: true,
  apartmentId: true,
  placeId: true,
  closedAt: true,
  targetDate: true,
  status: { select: { meaning: true } },
  ...ENTRY_SELECT,
} as const;

type EntryTarget = Prisma.IssueGetPayload<{
  select: typeof ENTRY_TARGET_SELECT;
}>;

interface EntryData {
  entryAnswer: IssueEntryAnswer;
  entryNote: string | null;
  entryPets: boolean | null;
  entryMasterKey: boolean | null;
  entryUntil: Date | null;
}

/**
 * The columns an answer is written as, or the refusal of it.
 *
 * The note is refused when it reads like a door code, wherever it is written
 * from, and when a handler wrote it, when it carries a personal identity
 * number. A no is stored with nothing else, so a form that sent a note with it
 * has it dropped rather than kept: a refusal would tell a resident who said no
 * that their words were wrong.
 */
function entryData(input: IssueEntryInput, byHandler: boolean): EntryData {
  if (input.answer === "NO") {
    return {
      entryAnswer: "NO",
      entryNote: null,
      entryPets: null,
      entryMasterKey: null,
      entryUntil: null,
    };
  }

  const trimmed = input.note?.trim() ?? "";
  const note = trimmed === "" ? null : trimmed;
  if (note !== null) {
    const code = findDoorCode(note);
    if (code !== null) {
      throw new IssueError(
        "The note reads like a door code and cannot be stored.",
        "door-code",
        [{ part: "entryNote", offset: code.offset }],
      );
    }
    if (byHandler) {
      refusePersonalIdentityNumbers({ entryNote: note });
    }
  }

  const until =
    input.until == null || input.until === "" ? null : requireDay(input.until);
  return {
    entryAnswer: "YES",
    entryNote: note,
    entryPets: input.pets ?? false,
    entryMasterKey: input.masterKey ?? false,
    entryUntil: until === null ? null : dateColumnOf(until),
  };
}

/** A calendar day the calendar has, or the refusal. */
function requireDay(
  value: string,
): NonNullable<ReturnType<typeof parseLocalDay>> {
  const day = parseLocalDay(value);
  if (day === null) {
    throw new IssueError("That is not a date.", "date-invalid");
  }
  return day;
}
