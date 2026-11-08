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
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { residencyHeldOn } from "../registers/held-on";
import { lockResidencyTransitions } from "../registers/residency-lock";
import { refusePersonalIdentityNumbers } from "./issue-conversation.service";
import { requireFindingTargetDate } from "./issue-finding-rule";
import {
  ENTRY_SELECT,
  type IssueEntryView,
  NO_ENTRY_PERMISSION,
  toEntryView,
} from "./issue-fit-views";
import { requireHandledIssueForWrite } from "./issue-handlers";
import {
  holdOfferedPlace,
  lockIssue,
  lockIssueForHandling,
} from "./issue-lock";
import { IssueMailer } from "./issue-mailer.service";
import {
  IssueError,
  placeWithApartment,
  requireCalendarDay,
} from "./issue.error";
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
 * The entry names the person who acted and the answer, yes or no, and never
 * the note, the pets, the master key or the expiry day: those are about
 * somebody's home and go when the issue closes, which the audit log does not.
 * By the reporter themselves it is flagged `byReporter`, so the timeline can
 * show it without naming the reporter.
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
 * (BFS 2025:11 1 kap. 17 §); the other kinds have the handler's date. The
 * first mark places a legal hold, which keeps the protocol until a handler
 * releases it.
 *
 * ## Who may answer for a resident
 *
 * A handler records an answer whether or not the issue still names its
 * reporter. An issue whose reporter was purged lost the earlier answer with
 * the reference (`PurgeService`), and stays about its apartment while it is
 * open; what a handler writes on it afterwards is what whoever lives there told
 * the handler then, the handler's own record under the handler's name, not the
 * purged answer put back. Only the reporter's own write is held to the
 * reporter column, because it is the reporter's.
 */
@Injectable()
export class IssueFitService {
  private readonly logger = new Logger(IssueFitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly issues: IssueService,
    private readonly mailer: IssueMailer,
  ) {}

  /** The reporter answers the entry question on their own issue. */
  async answerEntry(
    reporterPersonId: string,
    issueId: string,
    input: IssueEntryInput,
  ): Promise<IssueEntryView | null> {
    const data = entryData(input, false);
    return this.prisma.$transaction(async (tx) => {
      /*
       * A yes reads the reporter's residency, so it takes the key a move-out
       * takes before it changes one: the move-out either commits first and is
       * seen by the read below, or waits for this answer to commit. Taken
       * before the issue's key, the order the person purge keeps (the person's
       * key, then each of their issues'), so the two never wait on each other
       * the other way round. A no or a handler's record reads no residency and
       * takes nothing extra.
       */
      if (data?.entryAnswer === "YES") {
        await lockResidencyTransitions(tx, reporterPersonId);
      }
      await lockIssue(tx, issueId);
      const issue = await this.requireReported(tx, issueId, reporterPersonId);
      /*
       * A yes lets somebody into a home, so it comes from someone who lives
       * there today. A reporter who has moved out keeps their issue and may
       * still read and withdraw what they said, but cannot grant entry to an
       * apartment that is no longer theirs: another household may hold it now.
       * A no, and a handler's record of what the resident said, are not held
       * to this: neither opens a door.
       *
       * A move-out recorded afterwards does not clear a yes already stored: its
       * date may still be ahead, the resident lives there until it, and the
       * answer has its own last day and is cleared when the issue closes.
       */
      if (data?.entryAnswer === "YES" && issue.apartmentId !== null) {
        const resident = await tx.residency.findFirst({
          where: {
            personId: reporterPersonId,
            apartmentId: issue.apartmentId,
            ...residencyHeldOn(localDayOf(new Date())),
          },
          select: { id: true },
        });
        if (resident === null) {
          throw new IssueError(
            "Permission to enter comes from someone who lives in the apartment.",
            "entry-not-resident",
          );
        }
      }
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
      const issue = await this.requireHandledForWrite(
        tx,
        issueId,
        handlerPersonId,
      );
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
      const issue = await this.requireHandledForWrite(
        tx,
        issueId,
        handlerPersonId,
      );
      return this.writeEntry(tx, issue, null, handlerPersonId, false);
    });
  }

  /** Sets the common-area place of an issue, or takes it off. */
  async setPlace(
    handlerPersonId: string,
    issueId: string,
    placeId: string | null,
  ): Promise<QueuedIssueView> {
    const written = await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandledForWrite(
        tx,
        issueId,
        handlerPersonId,
      );
      if (placeId === issue.placeId) {
        return this.issues.writtenIssue(tx, issueId);
      }
      if (placeId !== null && issue.apartmentId !== null) {
        throw placeWithApartment();
      }
      if (placeId !== null && !(await holdOfferedPlace(tx, placeId))) {
        throw new IssueError("No such place.", "place-not-found");
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
      return this.issues.writtenIssue(tx, issueId);
    });
    this.logger.log(`Issue ${issueId} place changed`);
    return this.issues.viewOfWritten(written);
  }

  /**
   * Marks an issue as a finding of an inspection, or changes the mark (decision
   * 31). The protocol must be one of the issue's own handler files, and the due
   * date is written as the issue's target date in the same transaction, with
   * the overdue reminder any target date has. The first mark places a legal
   * hold on the issue where none stands.
   */
  async markFinding(
    handlerPersonId: string,
    issueId: string,
    input: IssueFindingInput,
  ): Promise<QueuedIssueView> {
    const inspectedOn = requireCalendarDay(input.inspectedOn);
    const targetDate = requireCalendarDay(input.targetDate);
    requireFindingTargetDate(input.kind, input.inspectedOn, input.targetDate);

    await this.mailer.ensureQueues();
    const written = await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandledForWrite(
        tx,
        issueId,
        handlerPersonId,
      );
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
        return this.issues.writtenIssue(tx, issueId);
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
      /*
       * A finding places a legal hold (ADR 0057), so neither the clock nor a
       * granted erasure request removes the protocol and the free text the
       * association may have to show for a statutory inspection. Only when the
       * issue is not marked yet and no hold stands: a hold already placed
       * keeps its date, and one a handler released after the mark was their
       * decision, which changing the mark does not undo. A mark put on again
       * after it was taken off is a new finding and places the hold again; the
       * issue does not remember a release, only the audit log does. Taking the
       * mark off leaves the hold (`removeFinding`).
       */
      if (existing === null && issue.legalHoldAt === null) {
        await tx.issue.update({
          where: { id: issueId },
          data: { legalHoldAt: new Date() },
        });
        await this.audit.record(
          {
            action: "ISSUE_LEGAL_HOLD_PLACED",
            channel: "WEB",
            actorPersonId: handlerPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: { byFinding: true },
          },
          tx,
        );
      }
      const dateChanged =
        formatDateColumn(issue.targetDate) !== input.targetDate;
      if (dateChanged) {
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
      // The overdue reminder for the finding's date, as for any target date
      // (`IssueService.setTargetDate`); one queued for an old date sends nothing.
      if (dateChanged) {
        await this.mailer.targetDateSetInTransaction(tx, issueId, targetDate);
      }
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
      return this.issues.writtenIssue(tx, issueId);
    });
    this.logger.log(`Issue ${issueId} marked as a finding`);
    return this.issues.viewOfWritten(written);
  }

  /**
   * Takes the mark off. The target date stays; a handler may clear it. So does
   * the legal hold the mark placed: `legalHoldAt` is one date with no reason
   * beside it, so taking it off here could release a hold a handler or a damage
   * case placed. A handler releases it as any other, as its own act.
   */
  async removeFinding(
    handlerPersonId: string,
    issueId: string,
  ): Promise<QueuedIssueView> {
    const written = await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      await this.requireHandledForWrite(tx, issueId, handlerPersonId);
      const { count } = await tx.issueFinding.deleteMany({
        where: { issueId },
      });
      if (count === 0) {
        return this.issues.writtenIssue(tx, issueId);
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
      return this.issues.writtenIssue(tx, issueId);
    });
    this.logger.log(`Issue ${issueId} is no longer marked as a finding`);
    return this.issues.viewOfWritten(written);
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
          /*
           * That an answer was given, which, and by whom: the timeline reads
           * no more. Not the note, nor whether there are pets, the master key
           * or the last day - they are about somebody's home, cleared when the
           * issue closes, and the audit log outlives that.
           */
          context:
            data === null
              ? { byReporter }
              : { answer: data.entryAnswer, byReporter },
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
     *
     * A permission also names the apartment, for the same reason: the board's
     * removal of the apartment clears its issues and sets their apartment to
     * null (`AddressService.removeApartment`), and a write that waited on that
     * finds no row instead of storing a permission for a home that is gone.
     */
    const { count } = await tx.issue.updateMany({
      where: {
        id: issue.id,
        ...(byReporter ? { reporterPersonId: actorPersonId } : {}),
        ...(data !== null ? { apartmentId: { not: null } } : {}),
      },
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

  /**
   * An issue this person handles and holds `issues:handle` for, read under the
   * locks of the write that asks (`requireHandledIssueForWrite`). The clock is
   * read here, after those locks are held, and the role and the scope are
   * judged at that one instant.
   */
  private async requireHandledForWrite(
    tx: Prisma.TransactionClient,
    issueId: string,
    writerPersonId: string,
  ): Promise<EntryTarget> {
    return requireHandledIssueForWrite(
      tx,
      issueId,
      writerPersonId,
      ENTRY_TARGET_SELECT,
      new Date(),
    );
  }
}

const ENTRY_TARGET_SELECT = {
  id: true,
  apartmentId: true,
  placeId: true,
  closedAt: true,
  targetDate: true,
  legalHoldAt: true,
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
    input.until == null || input.until === ""
      ? null
      : requireCalendarDay(input.until);
  return {
    entryAnswer: "YES",
    entryNote: note,
    entryPets: input.pets ?? false,
    entryMasterKey: input.masterKey ?? false,
    entryUntil: until === null ? null : dateColumnOf(until),
  };
}
