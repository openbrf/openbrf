import { Injectable, Logger } from "@nestjs/common";
import {
  type AuthorView,
  compareLocalDays,
  dateColumnOf,
  formatDateColumn,
  ISSUE_ENTRY_ANSWERS,
  ISSUE_FINDING_KINDS,
  ISSUE_COST_RESPONSIBILITIES,
  ISSUE_LINK_LIMITS,
  ISSUE_OPEN_MEANINGS,
  ISSUE_OUTCOMES,
  ISSUE_PRIORITIES,
  ISSUE_REDACTION_TARGETS,
  ISSUE_SEARCH_LIMITS,
  ISSUE_STATUS_LIMITS,
  ISSUE_STATUS_MEANINGS,
  ISSUE_WAITING_REASONS,
  type IssueClosingOutcome,
  type IssueEntryAnswer,
  type IssueFindingKind,
  type IssueCostResponsibility,
  type IssueHandledBy,
  type IssueMeaningFilter,
  type IssueOutcome,
  type IssuePriority,
  type IssueReplyMode,
  type IssueQueueView,
  type IssueRedactionTarget,
  type IssueReporterGroup,
  type IssueSignature,
  type IssueStatusMeaning,
  type IssueWaitingReason,
  isIssueStatusMeaning,
  type LocalDay,
  localDayOf,
  localDayOfColumn,
  replyReopensIssue,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { readAuthors } from "../feed/feed-author";
import { type IssueLinkOutcome, linkIssueToPost } from "../feed/feed-issue";
import { type AuditAction, Prisma } from "../generated/prisma/client";
import { failureName } from "../logging/failure";
import { mediaUrl, MediaService } from "../media/media.service";
import { residencyHeldOn } from "../registers/held-on";
import {
  handlesIssues,
  issueHandledBy,
  issueReaderScope,
  issuesHandledWhere,
  readIssueHandlers,
  requireHandledIssue,
  typesHandledWhere,
} from "./issue-handlers";
import {
  refusePersonalIdentityNumbers,
  signatureOf,
} from "./issue-conversation.service";
import { requireFindingTargetDate } from "./issue-finding-rule";
import {
  type EntryColumns,
  type FindingRecord,
  FINDING_SELECT,
  type IssueEntryView,
  type IssueFindingView,
  type IssuePlaceRef,
  NO_ENTRY_PERMISSION,
  toEntryView,
  toFindingView,
} from "./issue-fit-views";
import {
  KNOWN_FAULT_SELECT,
  knownFaultOf,
  knownFaultShownWhere,
  type KnownFaultView,
  typeNameForTheHouse,
} from "./issue-known-fault";
import { type IssueTypeView, IssueTypeService } from "./issue-type.service";
import {
  holdOfferedPlace,
  lockIssue,
  lockIssueForHandling,
  lockIssuesForHandling,
  lockIssueType,
} from "./issue-lock";
import {
  REPORTER_LINK_STATE_SELECT,
  type ReporterLinkState,
  reporterLinkState,
} from "./issue-reporter-link";
import { IssueReporterLinkService } from "./issue-reporter-link.service";
import { IssueMailer } from "./issue-mailer.service";
import {
  IssueError,
  placeWithApartment,
  requireCalendarDay,
} from "./issue.error";
import { workOrderKnownNotSent } from "./work-order-delivery";

/**
 * How many photographs one report may carry.
 *
 * A bound on one report, and only on one report: every file is held in memory
 * while it is identified and checksummed, and a hundred images on a single
 * issue report are neither readable by whoever has to work it nor free to
 * serve.
 *
 * It is deliberately not a defence against filling the data volume, and reading
 * it as one would be a mistake: nothing caps how many reports an account may
 * file, so a resident who wanted the space could take it six photographs at a
 * time without ever meeting this number.
 */
export const MAX_PHOTOS_PER_ISSUE = 6;

export interface IssuePhotoView {
  id: string;
  /** A path on this instance's own origin, never an address at a bucket. */
  url: string;
  fileName: string;
  width: number | null;
  height: number | null;
}

export interface IssueApartmentView {
  id: string;
  number: string;
  /** "Storgatan 12", so a handler knows which entrance without a second call. */
  address: string;
}

/**
 * Who reported an issue, as whoever handles it may be told.
 *
 * Four cases, and the two that are not a plain name are the point of the type.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld here even though the board's own
 * address book prints it: that register has a statutory reason to, and an issue
 * queue - which an external property manager reads - has none. A handler who
 * has to reach them goes through the board. Their apartment is withheld with
 * the name, for the reason `QueuedIssueView` gives. It carries no personId
 * either: a handler who saw the same person unmasked earlier, as a resident
 * reporter, could otherwise link them to every later protected row.
 *
 * `unknown` is a reporter reference that no longer resolves to a person. Issue
 * data is service tier and a person can be purged out from under it, so the
 * queue has to be able to say "we no longer know" rather than break.
 */
export type IssueReporterView =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected" }
  | {
      kind: "external";
      name: string | null;
      email: string | null;
      /**
       * Where the private link mailed to them stands (ADR 0055): whether a
       * handler's message reaches them, and whether there is a link to
       * withdraw. For the board's screen; never offered to a connected app.
       */
      link: ReporterLinkState;
    }
  | { kind: "unknown" };

/**
 * An issue as its reporter reads it.
 *
 * Its status as the meaning and never the board's label. The label is the
 * board's own text, written for its handlers in the board's language - "Väntar
 * på styrelsebeslut" - and what a reporter is shown of it is a question ADR 0054
 * leaves to the owner; until it is answered, the reporter is told what they
 * were told before statuses became the board's to name, in their own language.
 */
export interface IssueRowView {
  id: string;
  /** The issue number (ärendenummer), which every mail about it names. */
  number: number;
  meaning: IssueStatusMeaning;
  typeId: string;
  typeName: string;
  location: string | null;
  /**
   * The common-area place it is about, from the association's list (decision
   * 30), or null.
   */
  place: IssuePlaceRef | null;
  description: string;
  apartment: IssueApartmentView | null;
  /**
   * The resident's entry permission (decision 29), or null while nobody has
   * answered. The reporter reads their own answer, and the handlers read it to
   * send someone to the door.
   */
  entry: IssueEntryView | null;
  photos: IssuePhotoView[];
  /**
   * Whether a handler opened it on the reporter's behalf (decision 14). The
   * reporter is told that much and never which handler: who works an issue is
   * internal (ADR 0054).
   */
  enteredByHandler: boolean;
  /**
   * When a handler redacted the description or the location, or null (ADR
   * 0057). The text is then empty, and the screen says it was taken out.
   */
  descriptionRedactedAt: string | null;
  locationRedactedAt: string | null;
  /**
   * When the purge removed the free text - the description, the location, the
   * conversation and the photographs - after the issue closed, or null. The
   * screen says so with the date rather than showing an empty issue.
   */
  freeTextRemovedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An issue as its reporter reads it: the row, and what the reporter can do
 * next and follow.
 */
export interface OwnIssueView extends IssueRowView {
  /**
   * What a reply does (ADR 0054): a message on an open issue, a reopening
   * within the window after it closed, and after that, or once it was merged
   * into another issue, a new report linked to it instead. Decided here, on
   * the server's clock, so a screen open across the window's end is refused
   * rather than believed.
   */
  replyMode: IssueReplyMode;
  /**
   * Where the issue it was merged into stands, while it is a duplicate
   * (decision 22): the meaning, in the reporter's own language, as their own
   * issue's is, and nothing else of an issue somebody else may have reported.
   * Null on an issue that is not a duplicate, and on one whose issue is gone.
   */
  mergedIntoMeaning: IssueStatusMeaning | null;
}

/**
 * Another issue an issue is linked to, as a handler is told of it: merged
 * into, merged from, followed up or following up (decisions 8 and 22).
 *
 * `hidden` is an issue the reader does not handle, such as one the board keeps
 * to itself, or one that no longer exists: the reader learns that there is a
 * link and nothing about what is at the other end of it.
 */
export type IssueReferenceView =
  | {
      kind: "issue";
      id: string;
      typeName: string;
      meaning: IssueStatusMeaning;
      createdAt: string;
    }
  | { kind: "hidden" };

/** The issues one issue is linked to, as a handler reads them. */
export interface IssueLinksView {
  /** The issue this one was merged into, while it is a duplicate. */
  mergedInto: IssueReferenceView | null;
  /** The issues merged into this one, that the reader handles. */
  duplicates: Extract<IssueReferenceView, { kind: "issue" }>[];
  /**
   * How many issues are merged into this one, those the reader does not
   * handle included, which merging this one into another is refused for. A
   * number and nothing of the issues behind it.
   */
  duplicateCount: number;
  /** The earlier issue this one follows up, when it does. */
  follows: IssueReferenceView | null;
  /**
   * The first later issues that follow this one up that the reader handles, at
   * most `ISSUE_LINK_LIMITS.followUpsListed` of them.
   */
  followUps: Extract<IssueReferenceView, { kind: "issue" }>[];
  /** How many follow-ups the reader handles, those not listed included. */
  followUpCount: number;
}

/**
 * A handler as an issue names them: its assignee, the handler who entered it,
 * the one who acted on its timeline.
 *
 * The feed's `AuthorView`, built by the feed's one mapping (`readAuthors`), so
 * there is no further spelling of the protected-person rule: a handler with
 * protected personal data is named to nobody and keeps their identifier, so an
 * issue can still be assigned to them (ADR 0056). Unlike a protected reporter's
 * row, the identifier stays: a handler is chosen from a list, and a list of
 * people whose names are withheld is only usable by identifier.
 */
export type IssueHandlerView = AuthorView;

/**
 * An issue as whoever handles it reads it.
 *
 * `apartment` is null when the reporter has protected personal data, whatever
 * the report was filed against. A signed-in resident can only file against an
 * apartment they live in, so on a protected reporter's report the apartment is
 * their home address, and withholding the name beside it would withhold
 * nothing. The location and the description stay: the reporter wrote those
 * themselves. So does the entry permission (decision 29): its note is the
 * reporter's own words as the description is, a door code in it is refused
 * (`findDoorCode`), and the answer, the pets and the master key say how to get
 * in, not where. Without the apartment they lead to no door, and whoever the
 * board sends there needs them.
 *
 * `aboutApartment` says whether it was filed against an apartment, which the
 * mask does not hide: it names no apartment, and on an issue about one the
 * handler records the entry permission rather than a common-area place, as the
 * server decides it.
 *
 * The same row for every handler, the board included. The queue is one view
 * under one capability, and the board already has the address book, which has
 * a statutory reason to print the apartment. A board member who has to send
 * someone to the door looks there.
 */
export type QueuedIssueView = IssueRowView & {
  /**
   * Whether it was filed against an apartment, true also while `apartment` is
   * withheld for a protected reporter. The handler's screen offers the entry
   * permission or a common-area place from it, never from `apartment`.
   */
  aboutApartment: boolean;
  /** The status it stands in, as the board named it for this type. */
  status: { id: string; label: string };
  /** Whom it waits on, while its status means WAITING; null otherwise. */
  waitingReason: IssueWaitingReason | null;
  /**
   * How it ended, while its status means DONE. Null while it is open, and on
   * an issue closed before outcomes existed (ADR 0054).
   */
  outcome: IssueOutcome | null;
  /** Who may report an issue of its type. */
  typeReporters: IssueReporterGroup[];
  /** Who handles an issue of its type. */
  typeHandledBy: IssueHandledBy;
  /** When it last moved into DONE, or null while it is open. */
  closedAt: string | null;
  priority: IssuePriority;
  /** The day it is meant to be done by, `YYYY-MM-DD`, or null. */
  targetDate: string | null;
  /**
   * Whether its target date has passed, on the association's calendar, while
   * it is not done. Computed when the row is read, never stored.
   */
  overdue: boolean;
  /** Its assignee, or null while it is unassigned. */
  assignee: IssueHandlerView | null;
  /** The handler who opened it, or null when its reporter filed it. */
  enteredBy: IssueHandlerView | null;
  /** Whether it is closed to every handler but the board on its own. */
  boardOnly: boolean;
  /** The inspection it is a finding of (decision 31), or null. */
  finding: IssueFindingView | null;
  /**
   * Its known fault, while one is published (decision 22); null otherwise.
   * The type's name is the row's own.
   */
  knownFault: Omit<KnownFaultView, "typeName"> | null;
  /**
   * Since when a legal hold stands on it, or null (ADR 0057). While one stands
   * its free text outlasts its clock, and a handler may not redact it.
   */
  legalHoldAt: string | null;
  /**
   * Who pays for it, or null while nobody has said (decision 26). Never an
   * amount: a charge made from the issue is read from the charges, by those
   * who may read charges, and the property manager may not.
   */
  costResponsibility: IssueCostResponsibility | null;
} & (
    | { reporter: Exclude<IssueReporterView, { kind: "protected" }> }
    | {
        reporter: Extract<IssueReporterView, { kind: "protected" }>;
        apartment: null;
      }
  );

/**
 * Whether a read of the queue shows the issues a reporter with protected
 * personal data filed, or leaves them out altogether.
 *
 * An argument of `pageOfQueue` and `queuedIssue` rather than a default, so
 * each caller states which it is. The board's own screen (`listQueue`) shows
 * them, with the reporter withheld as `IssueReporterView` describes. A read
 * handed to a caller outside the instance (`mcp`, `ai`) leaves them out:
 * Beslutslogg 64 puts protected personal data outside every token and every
 * prompt, and a report from such a person is about their own home whoever's
 * name is withheld from it. Left out here, inside the service, because an
 * action may bind a read only where the omission happens in the service method
 * it calls (docs/actions.md, "What an action that names a person must
 * satisfy").
 */
export type ProtectedReporters = "show" | "omit";

/**
 * What the board's screen narrows a view of the queue to (decision 15): the
 * status filter, a type, a priority and a search.
 *
 * The screen's own, beside `IssueQueueFilter`, which is what the actions
 * narrow a page to. An action that searched the queue or read a view would be
 * a new read on `mcp` and `ai`, which ADR 0040 says needs its own decision.
 */
export interface IssueBoardFilter {
  meaning?: IssueMeaningFilter;
  typeId?: string;
  /** The common-area place the issue is about (decision 30). */
  placeId?: string;
  priority?: IssuePriority;
  /**
   * What the handler typed, matched as `IssueService.searchWhere` says. Blank
   * is no search.
   */
  search?: string;
}

/**
 * How many issues each view of the queue holds, under one filter: the numbers
 * on the screen's views and, unfiltered but for open issues, the three on the
 * board's front page. Counted by the same conditions the lists are read by, so
 * a number and its list cannot disagree.
 */
export type IssueQueueCounts = Record<
  "mine" | "unassigned" | "overdue" | "all",
  number
>;

/**
 * One view of the queue and every view's count, read at one moment
 * (`IssueService.readQueueSnapshot`): what the queue screen draws.
 */
export interface IssueQueueSnapshot {
  issues: QueuedIssueView[];
  counts: IssueQueueCounts;
}

/** What a read of the queue may be narrowed to. */
export interface IssueQueueFilter {
  /** The meaning of the status the issue stands in. */
  meaning?: IssueStatusMeaning;
  typeId?: string;
  /** The common-area place the issue is about (decision 30). */
  placeId?: string;
  /** A group that may report the issue's type. */
  reporter?: IssueReporterGroup;
}

/**
 * A move of an issue to another status, with what the status's meaning
 * requires: a waiting reason into WAITING, an outcome into DONE from another
 * meaning (ADR 0054).
 */
export interface IssueStatusMove {
  statusId: string;
  waitingReason?: IssueWaitingReason;
  /**
   * Required on the move into DONE from another meaning. On a move between two
   * DONE statuses, absent keeps the outcome the issue has.
   */
  outcome?: IssueClosingOutcome;
}

/**
 * An issue a handler opens (decision 14): for a named resident, who is then
 * its reporter with every rule about a reporter, masking included, or as an
 * internal issue with no reporter at all.
 */
export interface OpenIssueInput {
  typeId: string;
  /**
   * The residency of the resident it is opened for, as the resident picker
   * (`IssueResidentsService`) offered it: the resident becomes the reporter
   * and the residency's apartment the issue's. Absent or null opens an
   * internal issue.
   */
  residencyId?: string | null;
  location?: string | null;
  /** A common-area place from the association's list (decision 30). */
  placeId?: string | null;
  description: string;
}

/**
 * One step in an issue's timeline (decision 16): who did what, and when.
 *
 * Read from the audit log, which is the record of every act on an issue and is
 * append-only, so the timeline cannot be rewritten by the acts it records. Each
 * step carries the facts its entry holds and never a text a person wrote:
 * statuses by identifier and meaning, which the screen names from the type,
 * people by `IssueHandlerView`.
 *
 * `actor` is null on a step nobody took by hand - an assignment the type's
 * default made on filing - and on a step the reporter took, a reopening by
 * their reply (`byReporter`); on an entry whose actor was purged it is
 * `unknown`. A reporter is never named here: the queue row says who reported
 * the issue, masked as a reporter is, and a second spelling of them would be a
 * second place for a protected reporter's name to escape.
 */
export type IssueTimelineStep = {
  at: string;
  actor: IssueHandlerView | null;
} & (
  | { kind: "reported" }
  | { kind: "opened"; internal: boolean }
  | {
      kind: "status";
      fromMeaning: IssueStatusMeaning | null;
      toMeaning: IssueStatusMeaning | null;
      fromStatusId: string | null;
      toStatusId: string | null;
      waitingReason: IssueWaitingReason | null;
      outcome: IssueOutcome | null;
      /** Reopened by the reporter's reply within the window (ADR 0054). */
      byReporter: boolean;
    }
  | {
      kind: "assigned";
      assignee: IssueHandlerView | null;
      /** Set from the type's default when the issue was filed. */
      byTypeDefault: boolean;
    }
  | { kind: "priority"; from: IssuePriority | null; to: IssuePriority | null }
  | { kind: "targetDate"; from: string | null; to: string | null }
  | { kind: "access"; boardOnly: boolean }
  | { kind: "knownFault"; published: boolean }
  /**
   * A work order was written; the work orders themselves say to whom. How its
   * mail ended is read from the work order as the timeline is read, because
   * the entry is written when the mail is queued and is never rewritten:
   * `null` when the work order is no longer there to ask.
   */
  | { kind: "workOrder"; delivery: IssueTimelineWorkOrderDelivery | null }
  /** A handler redacted a text or removed a file (ADR 0057). */
  | { kind: "redacted"; target: IssueRedactionTarget | null }
  | { kind: "legalHold"; held: boolean }
  | {
      /** The common-area place set or changed; null when taken off. */
      kind: "place";
      placeId: string | null;
    }
  | {
      /**
       * The entry permission given (its answer) or withdrawn (null). By the
       * reporter themselves, the step has no actor: a reporter is never named
       * on the timeline.
       */
      kind: "entry";
      answer: IssueEntryAnswer | null;
      byReporter: boolean;
    }
  | {
      /** Marked as a finding of this kind, or taken off (null). */
      kind: "finding";
      findingKind: IssueFindingKind | null;
    }
  | {
      kind: "costResponsibility";
      from: IssueCostResponsibility | null;
      to: IssueCostResponsibility | null;
    }
);

/** What a charge made from an issue starts with: see `chargeBasis`. */
export interface IssueChargeBasis {
  issueId: string;
  typeName: string;
  costResponsibility: IssueCostResponsibility | null;
  /**
   * Whether the reporter's personal data is protected, from the same read as
   * the party. A null party does not say it: an unprotected reporter who is no
   * resident has none either.
   */
  reporterProtected: boolean;
  /** Who a charge for it is put on unless the board picks another, or null. */
  party:
    | { kind: "apartment"; apartmentId: string }
    | { kind: "person"; personId: string }
    | null;
}

/** How a work order's mail stands, for its step in the timeline. */
export type IssueTimelineWorkOrderDelivery =
  "pending" | "sent" | "failed" | "unconfirmed";

/**
 * How many issues one page of the queue answers with.
 *
 * The bound the motion queue has, for the motion queue's reason: an
 * association accumulates one queue for as long as it exists, and a
 * description runs to four thousand characters. A page comes with a cursor, so
 * the bound hides nothing.
 */
export const ISSUES_PER_PAGE = 50;

/**
 * Where a page of the queue ends: the last issue's own sort key.
 *
 * The queue is read by the meaning of each issue's status, in the order
 * `ISSUE_STATUS_MEANINGS` gives (ADR 0054), then by the board's order of the
 * statuses within that meaning, then oldest first, with the identifier to break
 * a tie on the instant. Values rather than a row, for the reason
 * `MotionQueueCursor` gives: an issue is purged on its own clock, and a cursor
 * naming a purged row would answer a page silently empty. An issue moved to
 * another status, or a status the board moved, between two pages sorts again
 * and can be read twice, which is the reader's to merge by id.
 */
export interface IssueQueueCursor {
  meaning: IssueStatusMeaning;
  /** The board's place for the issue's status within its meaning. */
  position: number;
  createdAt: Date;
  id: string;
}

/** Separates the parts; none of them can contain it. */
const CURSOR_SEPARATOR = "|";

/** Separates the meaning from the position in the cursor's first part. */
const POSITION_SEPARATOR = ".";

/**
 * The digits a position takes at most: those of the highest place a status can
 * have, `ISSUE_STATUS_LIMITS.sortOrder`, which both the board's own setting and
 * a status added after the last one keep to.
 */
const POSITION_DIGITS = String(ISSUE_STATUS_LIMITS.sortOrder).length;

/** A position as the cursor writes it. */
const POSITION = new RegExp(String.raw`^\d{1,${POSITION_DIGITS}}$`);

/** The first part of a cursor as a pattern, for the published document. */
export const ISSUE_QUEUE_CURSOR_STATES: readonly string[] =
  ISSUE_STATUS_MEANINGS.map(
    (meaning) => String.raw`${meaning}\.\d{1,${POSITION_DIGITS}}`,
  );

/** The cursor for the page ending at this issue. */
export function issueQueueCursor(row: IssueQueueCursor): string {
  return [
    `${row.meaning}${POSITION_SEPARATOR}${row.position}`,
    row.createdAt.toISOString(),
    row.id,
  ].join(CURSOR_SEPARATOR);
}

/**
 * The cursor a reader handed back, or null when it is not one this service
 * issued. Null rather than a lenient reading: answering a cursor nobody issued
 * with the first page would hand a reader the issues already in front of it.
 */
export function parseIssueQueueCursor(value: string): IssueQueueCursor | null {
  const [state = "", instant = "", id = "", ...rest] =
    value.split(CURSOR_SEPARATOR);
  const [meaning, position = "", ...extra] = state.split(POSITION_SEPARATOR);
  const createdAt = new Date(instant);
  if (
    rest.length > 0 ||
    extra.length > 0 ||
    !isIssueStatusMeaning(meaning) ||
    !POSITION.test(position) ||
    id === "" ||
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== instant
  ) {
    return null;
  }
  return { meaning, position: Number(position), createdAt, id };
}

/** One page of the queue. */
export interface IssueQueuePage {
  issues: QueuedIssueView[];
  /** Handed back as `after` for the page behind this one; null at the end. */
  nextCursor: string | null;
}

export interface ReportIssueInput {
  typeId: string;
  /** The reporter's own apartment, when the issue is in one. */
  apartmentId?: string | null;
  location?: string | null;
  /** A common-area place from the association's list (decision 30). */
  placeId?: string | null;
  description: string;
  /**
   * The post in the feed the report is made from ("Gör felanmälan"), when it
   * is. The post then names the report, and shows its status to whoever may
   * read the report.
   */
  postId?: string | null;
  /**
   * One's own earlier issue, closed, that this report follows up (ADR 0054):
   * what the reply field offers once a reply no longer reopens it.
   */
  followsIssueId?: string | null;
}

/**
 * A report filed from the association's public website, by nobody in
 * particular.
 *
 * No apartment: the form is served before any sign-in and must not offer a
 * picker that enumerates the building to whoever loads the page (decision 28).
 * The free-text location covers everything an apartment number would have.
 *
 * No photograph either, and that is the same argument one step further: an
 * anonymous upload surface is a place to put files on somebody else's server,
 * and a passer-by reporting a broken door does not need one.
 *
 * The contact details are optional. Somebody who reports a fault in the street
 * owes the association nothing, and a form that refused the report without a
 * name would collect fewer reports rather than better ones.
 */
export interface ReportPublicIssueInput {
  typeId: string;
  location?: string | null;
  description: string;
  reporterName?: string | null;
  reporterEmail?: string | null;
  /**
   * The language the reporter read the form in, when their browser asked for
   * one this instance speaks: what the mail with their private link is written
   * in. Null leaves it to the association's own.
   */
  reporterLocale?: string | null;
}

/**
 * Reported issues: filing one, reading one's own, and the triage queue.
 *
 * Two properties are enforced here rather than left to the screens.
 *
 * The audience filter decides which type a report may be filed under, and it is
 * the same filter that decided which types to offer - a caller who posts an
 * identifier they were never shown is answered as if that type did not exist.
 *
 * A reporter reads their own reports and nobody else's. Everything else about
 * an issue - who else reported what, the internal ones - needs issues:handle,
 * which is the external property manager's single capability besides their own
 * account (decision 11).
 *
 * The description is free text and is deliberately neither scanned nor refused.
 * An issue report is exactly where health data and a third party's details turn
 * up without anyone intending it - a leak in a bathroom, a neighbour's
 * behaviour - and the answer to that is the warning the form carries, not a
 * refusal that would turn away the reports the module exists for. Nothing here
 * is published, and the publication guardrails that scan text apply to the
 * association's website, not to its private queue.
 */
@Injectable()
export class IssueService {
  private readonly logger = new Logger(IssueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly types: IssueTypeService,
    private readonly media: MediaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
    private readonly reporterLinks: IssueReporterLinkService,
    private readonly mailer: IssueMailer,
  ) {}

  /**
   * Files a report for a signed-in resident.
   *
   * ## From a post
   *
   * A report made from a post in the feed is filed and linked to the post in
   * one transaction, so a report never exists that its post was refused, and a
   * post never names a report that was not filed. Which posts may carry one,
   * and who may make it, is the feed's answer (`linkIssueToPost`): the post's
   * writer or a board seat holder, from a post they may read, once. Its
   * refusals are this module's, so the form has one set of reasons to read.
   * What the report says is still the reporter's own - the form starts from the
   * post's text and photographs, and the reporter files what they choose.
   */
  async report(
    principal: Principal,
    input: ReportIssueInput,
  ): Promise<{ id: string }> {
    const type = await this.types.requireReportable(principal, input.typeId);

    const apartmentId =
      input.apartmentId == null
        ? null
        : await this.requireOwnApartment(principal.personId, input.apartmentId);

    const followsIssueId = input.followsIssueId ?? null;
    const data = {
      typeId: type.id,
      // The type's default NEW status: a report is new until a handler moves it.
      statusId: type.newStatusId,
      reporterPersonId: principal.personId,
      apartmentId,
      placeId: input.placeId ?? null,
      location: locationOrNull(input.location),
      description: input.description,
      followsIssueId,
    };
    const postId = input.postId ?? null;

    await this.mailer.ensureQueues();
    const issue = await this.prisma.$transaction(async (tx) => {
      if (followsIssueId !== null) {
        await requireFollowable(
          tx,
          followsIssueId,
          principal.personId,
          type.id,
        );
      }
      const filed = await this.file(tx, data);
      if (postId !== null) {
        refuseUnlinked(
          await linkIssueToPost(tx, principal, postId, filed.id, new Date()),
        );
      }
      return filed;
    });

    // The identifiers only. The description is the resident's own account of
    // their home, and the type's name is the board's text; neither has any
    // business in a log line.
    this.logger.log(`Reported issue ${issue.id} under type ${type.id}`);
    return issue;
  }

  /**
   * Files a report that arrived through the public website.
   *
   * The type is resolved through the same filter that decided which types to
   * offer the form, called with no principal: a caller posting an identifier
   * that was never on the page is answered as if that type did not exist, and
   * an association with public reporting switched off is refused here rather
   * than merely not shown a form. The switch is the rule; the missing form is
   * its consequence.
   *
   * The reporter's details are encrypted exactly as a sign-up request's are,
   * and the address carries a blind index so a second report from the same
   * person is recognisable as theirs.
   */
  async reportPublicly(input: ReportPublicIssueInput): Promise<{ id: string }> {
    const type = await this.types.requireReportable(null, input.typeId);

    const name =
      input.reporterName == null || input.reporterName === ""
        ? null
        : await this.encryption.encrypt(
            "issue.reporterName",
            input.reporterName,
          );
    const email =
      input.reporterEmail == null || input.reporterEmail === ""
        ? null
        : await this.encryption.encrypt(
            "issue.reporterEmail",
            input.reporterEmail,
          );

    if (email !== null) {
      await this.reporterLinks.ensureQueues();
    }
    await this.mailer.ensureQueues();

    const issue = await this.prisma.$transaction(async (tx) => {
      const filed = await this.file(tx, {
        typeId: type.id,
        statusId: type.newStatusId,
        // No account behind it. The reporter reference stays null and the
        // contact fields carry whatever the person chose to leave.
        reporterPersonId: null,
        reporterNameCipher: name?.cipher ?? null,
        reporterEmailCipher: email?.cipher ?? null,
        reporterEmailIndex: email?.index ?? null,
        // Empty is nothing, as it is for the name and the address above: the
        // form's location field is optional, so a visitor who touched it and
        // thought better of it must not leave the board an issue whose
        // location is present and blank.
        location: locationOrNull(input.location),
        description: input.description,
      });
      /*
       * An address is a way to answer the reporter, and the only one: the
       * private link to the issue is mailed to it (decision 20, ADR 0055).
       * Queued with the report, so a report that rolls back mails nobody; the
       * worker mints the token as it mails it, so the job carries none. No
       * address, no link and no follow-up.
       */
      if (email !== null) {
        await this.reporterLinks.queueInTransaction(
          tx,
          filed.id,
          input.reporterLocale ?? null,
        );
      }
      return filed;
    });

    // The identifier and the type. What a passer-by wrote about the building,
    // and who they said they were, has no business in a log line.
    this.logger.log(`Reported issue ${issue.id} from the public form`);
    return issue;
  }

  /**
   * Opens an issue as a handler (decision 14), for a named resident or as an
   * internal issue with no reporter. Reached with issues:handle, the property
   * manager's included (ADR 0054).
   *
   * Under any switched-on type the handler handles, whoever its reporters are:
   * the handler files it, so the reporter groups, which say whom a form offers
   * a type to, do not decide it. The issue records which handler entered it,
   * and is filed with the type's default priority and assignee as a report is.
   *
   * A named resident is named by a residency the resident picker offers
   * (`IssueResidentsService`), so any handler names one, the property manager
   * included, and none of them through the address book (ADR 0054). The
   * residency must be held today, read in the transaction that files the
   * issue: its person is the reporter and its apartment the issue's. A
   * residency that has ended, has not begun or does not exist is answered
   * alike.
   */
  async open(
    principal: Principal,
    input: OpenIssueInput,
  ): Promise<QueuedIssueView> {
    const residencyId = input.residencyId ?? null;

    await this.mailer.ensureQueues();
    const issue = await this.prisma.$transaction(async (tx) => {
      /*
       * The type, whether this handler handles it and its NEW status, all read
       * under the type's lock, which a change to who handles the type takes
       * too (`IssueTypeService.update`). Read before the lock, a type handed to
       * the board in between would take an issue from a handler it now shuts
       * out, and the handler would be told it failed when it had been filed.
       */
      await lockIssueType(tx, input.typeId);
      const scope = await this.readerScope(tx, principal.personId, new Date());
      const type = await tx.issueType.findFirst({
        where: { id: input.typeId, active: true, ...typesHandledWhere(scope) },
        select: {
          id: true,
          statuses: {
            where: { meaning: "NEW", isDefault: true },
            select: { id: true },
          },
        },
      });
      const newStatus = type?.statuses[0];
      if (type === null || newStatus === undefined) {
        throw new IssueError("No such issue type.", "type-not-found");
      }

      const resident =
        residencyId === null
          ? null
          : await tx.residency.findFirst({
              where: {
                id: residencyId,
                ...residencyHeldOn(localDayOf(new Date())),
              },
              select: { personId: true, apartmentId: true },
            });
      if (residencyId !== null && resident === null) {
        throw new IssueError("No such resident.", "resident-not-found");
      }
      const reporterPersonId = resident?.personId ?? null;

      const filed = await this.file(tx, {
        typeId: type.id,
        statusId: newStatus.id,
        reporterPersonId,
        enteredByPersonId: principal.personId,
        enteredByHandler: true,
        apartmentId: resident?.apartmentId ?? null,
        placeId: input.placeId ?? null,
        location: locationOrNull(input.location),
        description: input.description,
      });
      /*
       * The handler as the actor and the resident as the target, so the
       * opening is on both of their access reports; the type by identifier,
       * because its name is the board's text. Never the description.
       */
      await this.audit.record(
        {
          action: "ISSUE_OPENED",
          channel: "WEB",
          actorPersonId: principal.personId,
          targetPersonId: reporterPersonId,
          targetKind: "issue",
          targetId: filed.id,
          context: { typeId: type.id, internal: reporterPersonId === null },
        },
        tx,
      );
      /*
       * Read here, under the type's lock, and not after the commit: a type
       * handed to the board in between would no longer match this handler's
       * scope, and the read would answer "no such issue" for one just filed.
       */
      return tx.issue.findUniqueOrThrow({
        where: { id: filed.id },
        include: ISSUE_INCLUDE,
      });
    });

    this.logger.log(`Opened issue ${issue.id} under type ${input.typeId}`);
    return this.viewOf(issue);
  }

  /** The reporter's own issues, newest first. */
  async listOwn(personId: string): Promise<OwnIssueView[]> {
    const issues = await this.prisma.issue.findMany({
      where: { reporterPersonId: personId },
      orderBy: { createdAt: "desc" },
      include: ISSUE_INCLUDE,
    });

    const now = new Date();
    return issues.map((issue) => toOwnView(issue, now));
  }

  /**
   * The known faults the house is told of (decision 22): every open issue
   * with a notice that every handler may read, newest first. Reached with
   * issues:report, by a resident or a handler; anybody else, such as a
   * signed-in person who does not live here, is told of none, as the public
   * website is not.
   *
   * Read by the rule `knownFaultShownWhere` states, which the feed reads a
   * post's notice by too, so the report form and the post cannot disagree
   * about which notices stand.
   */
  async knownFaults(principal: Principal): Promise<KnownFaultView[]> {
    if (!principal.isResident && !principal.capabilities.has("issues:handle")) {
      return [];
    }
    const issues = await this.prisma.issue.findMany({
      where: knownFaultShownWhere(),
      orderBy: [{ knownFaultPublishedAt: "desc" }, { id: "asc" }],
      select: KNOWN_FAULT_SELECT,
    });
    return issues.flatMap((issue) => {
      const view = knownFaultOf(issue);
      return view === null
        ? []
        : [{ ...view, typeName: typeNameForTheHouse(issue.type) }];
    });
  }

  /**
   * The types this reader handles, active or not, with their statuses: what
   * the queue moves issues between and what a handler opens an issue under.
   * Reached with issues:handle. A type the board keeps to itself is left out
   * for a reader the board-only rule does not let in, as its issues are, and
   * a type's counts are of the issues the reader handles.
   */
  async handledTypes(readerPersonId: string): Promise<IssueTypeView[]> {
    const scope = await this.readerScope(
      this.prisma,
      readerPersonId,
      new Date(),
    );
    return this.types.list(typesHandledWhere(scope), issuesHandledWhere(scope));
  }

  /**
   * The triage queue. Reached with issues:handle.
   *
   * By the meaning of each issue's status - new, in progress, waiting, done -
   * then by the board's order of the statuses within a meaning, and oldest
   * first, because the queue is worked from the top and the thing that has been
   * waiting longest is the thing to look at.
   *
   * The issues the reader handles and no others: a reader the board-only rule
   * does not let in is not shown an issue its type or the issue itself keeps to
   * the board, here or by any read below (ADR 0054).
   *
   * One view of it (`IssueQueueView`), narrowed by `IssueBoardFilter`; with
   * neither, every issue the reader handles, closed ones included. The screen
   * asks with the open meanings unless the handler chooses otherwise, and
   * reads the list with its counts (`readQueueSnapshot`). The same conditions
   * as `countQueue`, so a count is the length of its list.
   */
  async listQueue(
    readerPersonId: string,
    view: IssueQueueView = "ALL",
    filter: IssueBoardFilter = {},
  ): Promise<QueuedIssueView[]> {
    const meanings = meaningsInView(view, filter.meaning);
    if (meanings.length === 0) {
      return [];
    }
    const narrowed = this.boardWhere(readerPersonId, filter);

    // The clock is read inside the transaction, so the seat the reader holds
    // and the day the view and the overdue flag count from are one instant.
    const { issues, reporters, today } = await this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const day = localDayOf(now);
        const where = await narrowed(tx, now);
        const read = await readQueueIn(
          tx,
          { AND: [where, viewWhere(view, readerPersonId, day)] },
          meanings,
          null,
          undefined,
        );
        return {
          issues: read,
          // Read with the issues: see `readReporters`.
          reporters: await this.readReporters(tx, read),
          today: day,
        };
      },
      { isolationLevel: "RepeatableRead" },
    );

    return this.queuedViews(issues, "show", today, reporters);
  }

  /**
   * How many issues each view holds under one filter. Reached with
   * issues:handle.
   *
   * Counted by the conditions `listQueue` reads each view by, in one REPEATABLE
   * READ transaction, so the four numbers describe the queue at one moment and
   * an issue taken between two of them is not counted in both views or in
   * neither. The board's front page asks with `meaning: "OPEN"` and nothing
   * else: `all` is then the open issues, beside the overdue and the unassigned.
   */
  async countQueue(
    readerPersonId: string,
    filter: IssueBoardFilter = {},
  ): Promise<IssueQueueCounts> {
    const narrowed = this.boardWhere(readerPersonId, filter);

    return this.prisma.$transaction(
      async (tx) => {
        // The clock is read inside the transaction, as in `listQueue`.
        const now = new Date();
        return countQueueIn(
          tx,
          await narrowed(tx, now),
          readerPersonId,
          localDayOf(now),
          filter.meaning,
        );
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  /**
   * What the queue screen draws: one view's issues, as `listQueue` reads them,
   * and every view's count, as `countQueue` counts them. Reached with
   * issues:handle.
   *
   * Read in one REPEATABLE READ transaction, so the rows and the numbers
   * describe the queue at one moment. Read as two requests, an issue assigned
   * or closed between them would be in the list and not in its view's count,
   * or the other way round.
   */
  async readQueueSnapshot(
    readerPersonId: string,
    view: IssueQueueView,
    filter: IssueBoardFilter = {},
  ): Promise<IssueQueueSnapshot> {
    const narrowed = this.boardWhere(readerPersonId, filter);
    const meanings = meaningsInView(view, filter.meaning);

    const { rows, reporters, counts, today } = await this.prisma.$transaction(
      async (tx) => {
        // The clock is read inside the transaction, as in `listQueue`.
        const now = new Date();
        const day = localDayOf(now);
        const where = await narrowed(tx, now);
        // One after another: a transaction runs one statement at a time.
        const read =
          meanings.length === 0
            ? []
            : await readQueueIn(
                tx,
                { AND: [where, viewWhere(view, readerPersonId, day)] },
                meanings,
                null,
                undefined,
              );
        return {
          rows: read,
          // Read with the rows: see `readReporters`.
          reporters: await this.readReporters(tx, read),
          counts: await countQueueIn(
            tx,
            where,
            readerPersonId,
            day,
            filter.meaning,
          ),
          today: day,
        };
      },
      { isolationLevel: "RepeatableRead" },
    );

    return {
      issues: await this.queuedViews(rows, "show", today, reporters),
      counts,
    };
  }

  /**
   * One page of the triage queue. Reached with issues:handle.
   *
   * The queue `listQueue` reads, in the same order and built into the same
   * rows, a page at a time and narrowed by meaning, type or a group that may
   * report the type. One more
   * row than the page holds is read, which is how "there is a page after this
   * one" is answered without a second statement about a second moment.
   *
   * With `omit`, an issue a reporter with protected personal data filed is not
   * on the page at all, and neither is anything about it. It is left out of the
   * query, so a page is not short for it, and left out again once the reporters
   * are read, so a person whose data became protected between the two reads is
   * not shown either. A row dropped that late leaves a gap, which is filled by
   * reading on from the last row read until the page and the one row behind it
   * are rows that were kept. The cursor is then the last row on the page: a
   * cursor naming a dropped row would hand its identifier, its status and the
   * moment it was filed to a caller the issue itself is withheld from.
   */
  async pageOfQueue(
    readerPersonId: string,
    filter: IssueQueueFilter & {
      /** At most {@link ISSUES_PER_PAGE}; absent takes the whole page. */
      limit?: number;
      after?: IssueQueueCursor | null;
    },
    protectedReporters: ProtectedReporters,
  ): Promise<IssueQueuePage> {
    const limit = Math.min(filter.limit ?? ISSUES_PER_PAGE, ISSUES_PER_PAGE);
    let readFrom = filter.after ?? null;
    const handled = issuesHandledWhere(
      await this.readerScope(this.prisma, readerPersonId, new Date()),
    );

    /*
     * Each read either keeps a row or moves past the rows it read, and a read
     * that comes back short is the end of the queue, so this stops. It reads
     * once unless a reporter's data became protected during it. A second read
     * sees the queue at a later moment than the first, so an issue moved
     * between the two can come back in it, and is kept once.
     */
    const kept: { row: QueueRecord; view: QueuedIssueView }[] = [];
    const keptIds = new Set<string>();
    for (;;) {
      const take = limit + 1 - kept.length;
      const rows = await this.readQueue(
        {
          AND: [
            handled,
            queueWhere(filter),
            protectedReporters === "omit"
              ? await this.notReportedByProtectedPersons()
              : {},
          ],
        },
        meaningsOf(filter.meaning),
        readFrom,
        take,
      );
      const views = await this.queuedViews(rows, protectedReporters);
      const viewed = new Map(views.map((view) => [view.id, view]));
      for (const row of rows) {
        const view = viewed.get(row.id);
        if (view !== undefined && !keptIds.has(row.id)) {
          kept.push({ row, view });
          keptIds.add(row.id);
        }
      }

      const lastRead = rows.at(-1);
      if (kept.length > limit || rows.length < take || lastRead === undefined) {
        break;
      }
      readFrom = cursorOf(lastRead);
    }

    const page = kept.slice(0, limit);
    const last = page.at(-1);
    return {
      issues: page.map((entry) => entry.view),
      nextCursor:
        last !== undefined && kept.length > page.length
          ? issueQueueCursor(cursorOf(last.row))
          : null,
    };
  }

  /**
   * One issue from the triage queue. Reached with issues:handle.
   *
   * With `omit`, an issue a reporter with protected personal data filed is
   * answered exactly as an issue that does not exist, with the same reason and
   * the same sentence, so the answer does not say that there is one.
   */
  async queuedIssue(
    readerPersonId: string,
    issueId: string,
    protectedReporters: ProtectedReporters,
  ): Promise<QueuedIssueView> {
    const scope = await this.readerScope(
      this.prisma,
      readerPersonId,
      new Date(),
    );
    // An issue the reader does not handle is answered as one that does not
    // exist, so the answer does not say that there is one.
    const issue = await this.prisma.issue.findFirst({
      where: { id: issueId, ...issuesHandledWhere(scope) },
      include: ISSUE_INCLUDE,
    });
    const [view] =
      issue === null ? [] : await this.queuedViews([issue], protectedReporters);
    if (view === undefined) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    return view;
  }

  /**
   * Moves an issue to another of its type's statuses. Reached with
   * issues:handle.
   *
   * What the target's meaning requires comes with it (ADR 0054): a waiting
   * reason into WAITING, an outcome into DONE from another meaning. Each is
   * written with the status and cleared on the move out of its meaning, and
   * one sent with a status of another meaning is refused rather than dropped.
   * The target is one of the issue's own type's statuses and switched on; the
   * status an issue already stands in may be named again after the board
   * switched it off, to change the reason it waits for.
   */
  async setStatus(
    issueId: string,
    move: IssueStatusMove,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    /*
     * The read and the write in one transaction, under the row's own lock. The
     * closing date below is derived from what the row already holds, so a
     * reopen and a close arriving together would otherwise both read the same
     * value and the later write would commit a date neither decided on - which
     * the retention clock then runs on.
     */
    await this.mailer.ensureQueues();
    const issue = await this.prisma.$transaction(async (tx) => {
      await this.lockForAssignment(tx, issueId);

      const existing = await requireHandledIssue(tx, issueId, actorPersonId, {
        id: true,
        typeId: true,
        closedAt: true,
        waitingReason: true,
        outcome: true,
        mergedIntoIssueId: true,
        entryAnswer: true,
        status: { select: { id: true, meaning: true } },
      });

      const target = await tx.issueStatus.findFirst({
        where: {
          id: move.statusId,
          typeId: existing.typeId,
          OR: [{ active: true }, { id: existing.status.id }],
        },
        select: { id: true, meaning: true },
      });
      if (target === null) {
        throw new IssueError("No such status.", "status-not-found");
      }

      const next = nextState(existing, target, move);

      /*
       * Who moved it, between which meanings and which statuses, and the reason
       * or the outcome it carries, in the transaction that moves it. Never a
       * status's label, which is the board's own text, and never the
       * description or the location, which are the reporter's own words. A
       * request that changes nothing records nothing.
       */
      if (
        next.statusId !== existing.status.id ||
        next.waitingReason !== existing.waitingReason ||
        next.outcome !== existing.outcome
      ) {
        // Said on the entry so the timeline and the access report can show that
        // an entry permission was cleared by the closing, as a fact and not the
        // permission's content.
        const clearedEntry =
          existing.entryAnswer !== null && next.entryAnswer === null;
        await this.audit.record(
          {
            action: "ISSUE_STATUS_CHANGED",
            channel: "WEB",
            actorPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: {
              from: existing.status.meaning,
              to: target.meaning,
              fromStatusId: existing.status.id,
              toStatusId: target.id,
              ...(next.waitingReason === null
                ? {}
                : { waitingReason: next.waitingReason }),
              ...(next.outcome === null ? {} : { outcome: next.outcome }),
              ...(clearedEntry ? { entryPermissionCleared: true } : {}),
            },
          },
          tx,
        );
      }

      const moved = await tx.issue.update({
        where: { id: issueId },
        data: next,
        include: ISSUE_INCLUDE,
      });
      // Out of done is a reopening, which the assignee is told of (decision 8).
      if (existing.status.meaning === "DONE" && target.meaning !== "DONE") {
        await this.mailer.reopenedInTransaction(tx, issueId, actorPersonId);
      }
      return moved;
    });

    this.logger.log(`Issue ${issue.id} moved to ${issue.status.meaning}`);
    return this.viewOf(issue);
  }

  /**
   * Gives an issue to an assignee, to another, or to nobody. Reached with
   * issues:handle.
   *
   * The assignee is somebody who handles this issue now: its type's handlers,
   * narrowed to the board when the issue is closed to everybody else, read by
   * `issueHandlersWhere` - the rule `handlers` names them by. Anybody else is
   * refused, a person who stopped handling since the list was read included,
   * so an issue is never given to somebody who cannot open it.
   *
   * The entry names the actor, the new assignee as its target - so the
   * assignment is on their access report, where `issueAssignments` also lists
   * it - and the previous assignee in its context, as the board mailbox records
   * a thread changing hands. Nothing on a request that changes nothing.
   */
  async assign(
    issueId: string,
    assigneePersonId: string | null,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    await this.mailer.ensureQueues();
    const issue = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await this.lockForAssignment(tx, issueId);
      const existing = await this.requireHandled(tx, issueId, actorPersonId);

      if (
        assigneePersonId !== null &&
        !(await handlesIssues(
          tx,
          assigneePersonId,
          issueHandledBy(existing),
          now,
        ))
      ) {
        throw new IssueError(
          "That person does not handle this issue.",
          "assignee-not-a-handler",
        );
      }

      if (existing.assigneePersonId !== assigneePersonId) {
        await this.recordAssignment(tx, {
          issueId,
          actorPersonId,
          assigneePersonId,
          previousAssigneePersonId: existing.assigneePersonId,
        });
      }

      const assigned = await tx.issue.update({
        where: { id: issueId },
        data: { assigneePersonId },
        include: ISSUE_INCLUDE,
      });
      if (
        assigneePersonId !== null &&
        existing.assigneePersonId !== assigneePersonId
      ) {
        await this.mailer.assignedInTransaction(
          tx,
          issueId,
          assigneePersonId,
          actorPersonId,
          now,
        );
      }
      return assigned;
    });

    this.logger.log(`Issue ${issue.id} assignment changed`);
    return this.viewOf(issue);
  }

  /**
   * Sets an issue's priority (decision 11). Reached with issues:handle; a
   * reporter never sets it. The entry carries the priority either side.
   */
  async setPriority(
    issueId: string,
    priority: IssuePriority,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    await this.mailer.ensureQueues();
    const issue = await this.prisma.$transaction(async (tx) => {
      await this.lockForAssignment(tx, issueId);
      const existing = await this.requireHandled(tx, issueId, actorPersonId);
      if (existing.priority !== priority) {
        await this.audit.record(
          {
            action: "ISSUE_PRIORITY_CHANGED",
            channel: "WEB",
            actorPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: { from: existing.priority, to: priority },
          },
          tx,
        );
      }
      const prioritised = await tx.issue.update({
        where: { id: issueId },
        data: { priority },
        include: ISSUE_INCLUDE,
      });
      // Raised to Akut: every handler of the issue is told (decision 12).
      if (priority === "URGENT" && existing.priority !== "URGENT") {
        await this.mailer.raisedToUrgentInTransaction(
          tx,
          issueId,
          actorPersonId,
        );
      }
      return prioritised;
    });

    this.logger.log(`Issue ${issue.id} priority set to ${issue.priority}`);
    return this.viewOf(issue);
  }

  /**
   * Sets, moves or removes an issue's target date (senast klart, decision 10).
   * Reached with issues:handle. A calendar date and nothing more: nothing
   * counts time from it, and a date in the past is allowed, since a handler
   * recording a plan that has already slipped is telling the truth. The entry
   * carries the date either side.
   */
  async setTargetDate(
    issueId: string,
    targetDate: string | null,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    const day = targetDate === null ? null : requireCalendarDay(targetDate);
    const column = day === null ? null : dateColumnOf(day);

    await this.mailer.ensureQueues();
    const issue = await this.prisma.$transaction(async (tx) => {
      await this.lockForAssignment(tx, issueId);
      const existing = await this.requireHandled(tx, issueId, actorPersonId);
      // The target date of a finding is held to the inspection's rule, and a
      // finding is never left without one.
      if (existing.finding !== null) {
        requireFindingTargetDate(
          existing.finding.kind,
          formatDateColumn(existing.finding.inspectedOn) ?? "",
          targetDate,
        );
      }
      const from = formatDateColumn(existing.targetDate);
      const to = formatDateColumn(column);
      if (from !== to) {
        await this.audit.record(
          {
            action: "ISSUE_TARGET_DATE_CHANGED",
            channel: "WEB",
            actorPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: { from, to },
          },
          tx,
        );
      }
      const dated = await tx.issue.update({
        where: { id: issueId },
        data: { targetDate: column },
        include: ISSUE_INCLUDE,
      });
      // The overdue reminder for the new date; one for an old date finds it
      // is no longer the issue's and sends nothing.
      if (from !== to) {
        await this.mailer.targetDateSetInTransaction(tx, issueId, day);
      }
      return dated;
    });

    this.logger.log(`Issue ${issue.id} target date changed`);
    return this.viewOf(issue);
  }

  /**
   * Records who pays for an issue (decision 26): the association, the
   * tenant-owner, unclear, or null to say nothing again. Reached with
   * issues:handle, the property manager included: whose cost a repair is
   * belongs to handling it, and the value carries no amount.
   *
   * What the tenant-owner is charged is not here and never will be. It is a
   * member charge, recorded on the charges screen from this issue and linked
   * back to it, which only those holding `memberCharges:manage` read. The
   * entry carries the value either side.
   */
  async setCostResponsibility(
    issueId: string,
    costResponsibility: IssueCostResponsibility | null,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    const issue = await this.prisma.$transaction(async (tx) => {
      await this.lockForAssignment(tx, issueId);
      const existing = await this.requireHandled(tx, issueId, actorPersonId);
      if (existing.costResponsibility !== costResponsibility) {
        await this.audit.record(
          {
            action: "ISSUE_COST_RESPONSIBILITY_CHANGED",
            channel: "WEB",
            actorPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: {
              from: existing.costResponsibility,
              to: costResponsibility,
            },
          },
          tx,
        );
      }
      return tx.issue.update({
        where: { id: issueId },
        data: { costResponsibility },
        include: ISSUE_INCLUDE,
      });
    });

    this.logger.log(`Issue ${issue.id} cost responsibility changed`);
    return this.viewOf(issue);
  }

  /**
   * Closes an issue to every handler but the board, or opens it again to every
   * handler its type lets in (decision 13). Reached with issues:handle.
   *
   * Any handler of the issue may tighten it, the property manager included,
   * who then no longer reads it. Only the board loosens it, which follows from
   * the rule rather than from a check of its own: an issue closed to all but
   * the board is not found by anybody else. It is never loosened past its type,
   * because who handles it is its type's handlers narrowed by this flag.
   *
   * An assignee whom the tightened issue no longer lets in is unassigned in the
   * same transaction, with an entry of its own, so an issue is never left with
   * an assignee who cannot open it.
   */
  async setBoardOnly(
    issueId: string,
    boardOnly: boolean,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    const issue = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await this.lockForAssignment(tx, issueId);
      const existing = await this.requireHandled(tx, issueId, actorPersonId);
      if (existing.boardOnly === boardOnly) {
        return tx.issue.findUniqueOrThrow({
          where: { id: issueId },
          include: ISSUE_INCLUDE,
        });
      }

      await this.audit.record(
        {
          action: "ISSUE_ACCESS_CHANGED",
          channel: "WEB",
          actorPersonId,
          targetKind: "issue",
          targetId: issueId,
          context: { boardOnly },
        },
        tx,
      );

      const assigneePersonId =
        existing.assigneePersonId !== null &&
        !(await handlesIssues(
          tx,
          existing.assigneePersonId,
          issueHandledBy({ boardOnly, type: existing.type }),
          now,
        ))
          ? null
          : existing.assigneePersonId;
      if (assigneePersonId !== existing.assigneePersonId) {
        await this.recordAssignment(tx, {
          issueId,
          actorPersonId,
          assigneePersonId,
          previousAssigneePersonId: existing.assigneePersonId,
        });
      }

      return tx.issue.update({
        where: { id: issueId },
        data: { boardOnly, assigneePersonId },
        include: ISSUE_INCLUDE,
      });
    });

    this.logger.log(`Issue ${issue.id} access changed`);
    return this.viewOf(issue);
  }

  /**
   * Merges an issue into another as its duplicate (decision 22). Reached with
   * issues:handle, by a handler of both.
   *
   * The duplicate moves to its type's default DONE status with the outcome
   * `DUPLICATE`, which nothing else writes, and names the issue it was merged
   * into. Its reporter keeps their own report, conversation and photographs,
   * and follows the other issue from it: their report shows where that issue
   * stands, and a handler may write to every reporter of its duplicates at
   * once (`IssueConversationService.replyToDuplicates`). Nothing of either
   * report is copied onto the other, so a protected reporter of either stays
   * masked exactly as before, and neither reporter learns who the other is.
   *
   * Merged into an issue that is being handled, never one that is done: the
   * reporter of the duplicate would follow a report nobody works on, and a
   * handler who wants it there reopens that issue first (`merge-into-closed`).
   * The issue merged may itself be done already, a report closed and only then
   * found to be a duplicate: it keeps the day it closed, its outcome becomes
   * `DUPLICATE` in place of the one it had, and its reporter is told it is
   * handled with the other issue. The handler has pressed twice for that, and
   * reopening it undoes it.
   *
   * One level only. An issue is not merged into a duplicate, which would leave
   * its reporter following a report that follows another, and an issue others
   * were merged into is merged the other way round instead. A duplicate that
   * is reopened, or closed again with another outcome, leaves the issue it was
   * merged into (`nextState`).
   *
   * Recorded as the status change it is, with the issue merged into among its
   * facts, so the timeline and the access report read it where they read
   * every other closing.
   */
  async merge(
    issueId: string,
    intoIssueId: string,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    if (issueId === intoIssueId) {
      throw new IssueError(
        "An issue cannot be merged into itself.",
        "merge-into-itself",
      );
    }
    const issue = await this.prisma.$transaction(async (tx) => {
      await lockIssuesForHandling(tx, [issueId, intoIssueId]);
      // After the lock waits. A person who handles nothing is read as the
      // narrower scope, which admits every issue an every-handler type has: a
      // role withdrawn since the route's check must not merge.
      const now = new Date();
      if (!(await handlesIssues(tx, actorPersonId, "EVERY_HANDLER", now))) {
        throw new IssueError("No such issue.", "issue-not-found");
      }
      const scope = await this.readerScope(tx, actorPersonId, now);
      const [existing, into] = await Promise.all(
        [issueId, intoIssueId].map((id) =>
          tx.issue.findFirst({
            where: { id, ...issuesHandledWhere(scope) },
            select: {
              id: true,
              typeId: true,
              closedAt: true,
              mergedIntoIssueId: true,
              entryAnswer: true,
              status: { select: { id: true, meaning: true } },
              _count: { select: { duplicates: true } },
            },
          }),
        ),
      );
      if (
        existing === null ||
        existing === undefined ||
        into === null ||
        into === undefined
      ) {
        throw new IssueError("No such issue.", "issue-not-found");
      }
      if (into.mergedIntoIssueId !== null) {
        throw new IssueError(
          "That issue is itself a duplicate of another.",
          "merge-into-duplicate",
        );
      }
      if (existing._count.duplicates > 0) {
        throw new IssueError(
          "Other issues were merged into this one; merge the other way.",
          "merge-has-duplicates",
        );
      }
      if (existing.mergedIntoIssueId === intoIssueId) {
        return tx.issue.findUniqueOrThrow({
          where: { id: issueId },
          include: ISSUE_INCLUDE,
        });
      }
      if (existing.mergedIntoIssueId !== null) {
        throw new IssueError(
          "That issue is already a duplicate of another.",
          "merge-already-duplicate",
        );
      }

      if (into.status.meaning === "DONE") {
        throw new IssueError(
          "That issue is done; merge into one that is still being handled.",
          "merge-into-closed",
        );
      }

      if (into._count.duplicates >= ISSUE_LINK_LIMITS.duplicates) {
        throw new IssueError(
          "That issue already has as many duplicates as one may.",
          "merge-limit",
        );
      }

      const target = await tx.issueStatus.findFirst({
        where: { typeId: existing.typeId, meaning: "DONE", isDefault: true },
        select: { id: true, meaning: true },
      });
      if (target === null) {
        // Every type keeps a default status of each meaning (ADR 0054).
        throw new Error(`Type ${existing.typeId} has no default DONE status.`);
      }

      await this.audit.record(
        {
          action: "ISSUE_STATUS_CHANGED",
          channel: "WEB",
          actorPersonId,
          targetKind: "issue",
          targetId: issueId,
          context: {
            from: existing.status.meaning,
            to: target.meaning,
            fromStatusId: existing.status.id,
            toStatusId: target.id,
            outcome: "DUPLICATE",
            mergedIntoIssueId: intoIssueId,
            // As a status change says it (`changeStatus`): the closing cleared
            // an entry permission, as a fact and never its content.
            ...(existing.entryAnswer === null
              ? {}
              : { entryPermissionCleared: true }),
          },
        },
        tx,
      );

      // The issue merged into gains a duplicate without a column of its own
      // changing, and a handler's open panel for it reads its links again only
      // when its revision moves.
      await tx.issue.update({
        where: { id: intoIssueId },
        data: { updatedAt: new Date() },
      });

      return tx.issue.update({
        where: { id: issueId },
        data: {
          statusId: target.id,
          waitingReason: null,
          outcome: "DUPLICATE",
          // A duplicate merged after it closed keeps the day it closed, which
          // the purge clock runs on (`nextState`).
          closedAt: existing.closedAt ?? new Date(),
          mergedIntoIssueId: intoIssueId,
          ...KNOWN_FAULT_CLEARED,
          // Closing clears the entry permission (decision 29), as `nextState`
          // does for every other closing.
          ...NO_ENTRY_PERMISSION,
        },
        include: ISSUE_INCLUDE,
      });
    });

    this.logger.log(`Issue ${issue.id} merged into ${intoIssueId}`);
    return this.viewOf(issue);
  }

  /**
   * Publishes or rewrites an issue's known fault (decision 22). Reached with
   * issues:handle.
   *
   * The handler's own words, scanned for a personal identity number as every
   * text the board writes back is, and signed with the role they write in,
   * never their name (decision 19). Refused on an issue that is done, and on
   * one the board keeps to itself: those are closed to the property manager,
   * and a notice about them would tell the whole house what the board decided
   * only the board should handle (decision 32 keeps Störningar from every
   * notice).
   */
  async publishKnownFault(
    issueId: string,
    body: string,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    refusePersonalIdentityNumbers({ body });
    const issue = await this.prisma.$transaction(async (tx) => {
      await this.lockForAssignment(tx, issueId);
      // After the lock wait: a board seat that ended during it must not sign
      // the notice as BOARD.
      const now = new Date();
      const existing = await this.requireHandled(tx, issueId, actorPersonId);
      // `requireHandled` answers the narrower scope for a person who handles
      // nothing, and `signatureOf` would sign for them as the board: a role
      // withdrawn since the route's check must not publish a notice.
      if (!(await handlesIssues(tx, actorPersonId, "EVERY_HANDLER", now))) {
        throw new IssueError("No such issue.", "issue-not-found");
      }
      if (existing.status.meaning === "DONE") {
        throw new IssueError(
          "This issue is closed; a fault that is fixed is not a known fault.",
          "issue-closed",
        );
      }
      if (issueHandledBy(existing) === "BOARD") {
        throw new IssueError(
          "An issue the board keeps to itself carries no known fault.",
          "known-fault-board-only",
        );
      }

      await this.audit.record(
        {
          action: "ISSUE_KNOWN_FAULT_CHANGED",
          channel: "WEB",
          actorPersonId,
          targetKind: "issue",
          targetId: issueId,
          // Whether a notice stands, never what it says.
          context: { published: true },
        },
        tx,
      );
      return tx.issue.update({
        where: { id: issueId },
        data: {
          knownFault: body,
          knownFaultSignature: await signatureOf(tx, actorPersonId, now),
          // The day it was first published, kept when it is rewritten, so a
          // notice is not moved to the top of the list by a typo's correction.
          knownFaultPublishedAt: existing.knownFaultPublishedAt ?? now,
        },
        include: ISSUE_INCLUDE,
      });
    });

    this.logger.log(`Issue ${issue.id} known fault published`);
    return this.viewOf(issue);
  }

  /** Withdraws an issue's known fault. Reached with issues:handle. */
  async withdrawKnownFault(
    issueId: string,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    const issue = await this.prisma.$transaction(async (tx) => {
      await this.lockForAssignment(tx, issueId);
      const existing = await this.requireHandled(tx, issueId, actorPersonId);
      // As publishing does: a role withdrawn since the route's check must not
      // clear a notice the board put up.
      if (
        !(await handlesIssues(tx, actorPersonId, "EVERY_HANDLER", new Date()))
      ) {
        throw new IssueError("No such issue.", "issue-not-found");
      }
      if (existing.knownFaultPublishedAt === null) {
        return tx.issue.findUniqueOrThrow({
          where: { id: issueId },
          include: ISSUE_INCLUDE,
        });
      }
      await this.audit.record(
        {
          action: "ISSUE_KNOWN_FAULT_CHANGED",
          channel: "WEB",
          actorPersonId,
          targetKind: "issue",
          targetId: issueId,
          context: { published: false },
        },
        tx,
      );
      return tx.issue.update({
        where: { id: issueId },
        data: KNOWN_FAULT_CLEARED,
        include: ISSUE_INCLUDE,
      });
    });

    this.logger.log(`Issue ${issue.id} known fault withdrawn`);
    return this.viewOf(issue);
  }

  /**
   * The issues one issue is linked to (decisions 8 and 22). Reached with
   * issues:handle, for an issue the reader handles.
   *
   * Each linked issue is named only when the reader handles it as well, by
   * the rule every read of an issue uses, and otherwise as `hidden`: a
   * property manager reading a duplicate of an issue the board keeps to itself
   * learns that it was merged, which its outcome says anyway, and nothing
   * about the issue it was merged into. Lists name only the issues the reader
   * handles. Read from one snapshot, for the reason
   * `IssueConversationService.readHandled` gives.
   */
  async links(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueLinksView> {
    return this.prisma.$transaction(
      async (tx) => {
        const scope = await this.readerScope(tx, readerPersonId, new Date());
        const handled = issuesHandledWhere(scope);
        const issue = await tx.issue.findFirst({
          where: { id: issueId, ...handled },
          select: { mergedIntoIssueId: true, followsIssueId: true },
        });
        if (issue === null) {
          throw new IssueError("No such issue.", "issue-not-found");
        }
        const read = (where: Prisma.IssueWhereInput, take?: number) =>
          tx.issue.findMany({
            where: { AND: [where, handled] },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: REFERENCE_SELECT,
            ...(take === undefined ? {} : { take }),
          });
        const [linked, duplicates, followUps, duplicateCount, followUpCount] =
          await Promise.all([
            read({
              id: {
                in: [issue.mergedIntoIssueId, issue.followsIssueId].filter(
                  (id): id is string => id !== null,
                ),
              },
            }),
            read({ mergedIntoIssueId: issueId }),
            read(
              { followsIssueId: issueId },
              ISSUE_LINK_LIMITS.followUpsListed,
            ),
            tx.issue.count({ where: { mergedIntoIssueId: issueId } }),
            tx.issue.count({
              where: { AND: [{ followsIssueId: issueId }, handled] },
            }),
          ]);
        const named = (id: string | null): IssueReferenceView | null => {
          if (id === null) {
            return null;
          }
          const row = linked.find((candidate) => candidate.id === id);
          return row === undefined ? { kind: "hidden" } : toReference(row);
        };
        return {
          mergedInto: named(issue.mergedIntoIssueId),
          duplicates: duplicates.map(toReference),
          duplicateCount,
          follows: named(issue.followsIssueId),
          followUps: followUps.map(toReference),
          followUpCount,
        };
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  /**
   * The people an issue may be assigned to, by name and nothing else. Reached
   * with issues:handle.
   *
   * A read of its own rather than the address book, which the property manager
   * never reads (decision 11 of the product decision log): names, with a
   * protected handler's withheld, and no address, telephone or apartment.
   * Read by `issueHandlersWhere`, the rule `assign` holds an assignee to, so
   * the list and the write cannot disagree about who is offered.
   */
  async handlers(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueHandlerView[]> {
    const now = new Date();
    const issue = await this.requireHandled(
      this.prisma,
      issueId,
      readerPersonId,
    );
    return readIssueHandlers(this.prisma, issueHandledBy(issue), now);
  }

  /**
   * One issue's timeline: who did what, and when (decision 16). Reached with
   * issues:handle, for an issue the reader handles.
   *
   * The filing itself first, from the issue's own row - a report, or a
   * handler's opening - and then every act the audit log holds on the issue,
   * oldest first. See `IssueTimelineStep` for what a step carries.
   */
  async timeline(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueTimelineStep[]> {
    const issue = await this.requireHandled(
      this.prisma,
      issueId,
      readerPersonId,
    );
    const entries = await this.prisma.auditLogEntry.findMany({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: { in: [...TIMELINE_ACTIONS] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        action: true,
        actorPersonId: true,
        targetPersonId: true,
        context: true,
        createdAt: true,
      },
    });

    // The reporter's own act - answering the entry question, or a reply that
    // reopened the issue - is shown as the reporter's and never by name: the queue row says who reported the issue,
    // masked as a reporter is.
    const byReporter = (entry: (typeof entries)[number]): boolean =>
      typeof entry.context === "object" &&
      entry.context !== null &&
      !Array.isArray(entry.context) &&
      entry.context.byReporter === true;

    const workOrders = entries.some(
      (entry) => entry.action === "ISSUE_WORK_ORDER_SENT",
    )
      ? await this.prisma.workOrder.findMany({
          where: { issueId },
          select: { id: true, deliveryStatus: true, deliveryFailure: true },
        })
      : [];
    const deliveryOf = new Map(
      workOrders.map((order) => [
        order.id,
        order.deliveryStatus === "SENT"
          ? ("sent" as const)
          : order.deliveryStatus === "PENDING"
            ? ("pending" as const)
            : // Only a failure after which nothing left this instance reads
              // "not sent"; a mail driver's error (`send-failed`) and a sending
              // that may have gone out are unconfirmed, as on the work order
              // list and in the data subject report.
              workOrderKnownNotSent(order.deliveryFailure)
              ? ("failed" as const)
              : ("unconfirmed" as const),
      ]),
    );

    const viewOf = await readAuthors(this.prisma, [
      ...entries
        .filter((entry) => !byReporter(entry))
        .map((entry) => entry.actorPersonId),
      ...entries
        .filter((entry) => entry.action === "ISSUE_ASSIGNED")
        .map((entry) => entry.targetPersonId),
    ]);
    const person = (id: string | null): IssueHandlerView | null =>
      id === null ? null : viewOf(id);

    const filed: IssueTimelineStep[] = entries.some(
      (entry) => entry.action === "ISSUE_OPENED",
    )
      ? []
      : [{ kind: "reported", at: issue.createdAt.toISOString(), actor: null }];

    return [
      ...filed,
      ...entries.map((entry) =>
        timelineStep(
          entry,
          byReporter(entry) ? null : person(entry.actorPersonId),
          person,
          deliveryOf,
        ),
      ),
    ];
  }

  /**
   * What a charge made from an issue starts with ("Skapa debitering",
   * decision 26): the issue, its type's name, and the party a charge for it is
   * put on unless the board picks another.
   *
   * Read through `queuedIssue`, so an issue the reader does not handle is
   * answered as one that does not exist and a protected reporter is masked as
   * the queue masks them. The party is the issue's apartment where the queue
   * shows one - a repair charged on to the flat is what an apartment charge
   * is - and otherwise the resident who reported it. Nothing the reporter
   * wrote: the reason on a charge is the board's own words, copied into a file
   * that leaves the association.
   */
  async chargeBasis(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueChargeBasis> {
    const issue = await this.queuedIssue(readerPersonId, issueId, "show");
    return {
      issueId: issue.id,
      typeName: issue.typeName,
      costResponsibility: issue.costResponsibility,
      reporterProtected: issue.reporter.kind === "protected",
      party:
        issue.apartment !== null
          ? { kind: "apartment", apartmentId: issue.apartment.id }
          : issue.reporter.kind === "resident"
            ? { kind: "person", personId: issue.reporter.personId }
            : null,
    };
  }

  /**
   * Attaches a photograph to one's own report.
   *
   * The file goes through the media layer like every other, so it is identified
   * from its own bytes, given a generated key and served from this instance's
   * origin. It is recorded INTERNAL, which means no session, no file.
   *
   * It is narrowed to `issues:handle`, which the database requires of every
   * INTERNAL file. The media route reads it by the issue that links it
   * (`issueFileAccess`): whoever handles that issue under the board-only rule,
   * and the reporter, who holds no capability. An address handed out while the
   * issue was open to a handler stops working for them when the board keeps
   * the issue or its type to itself.
   */
  async attachPhoto(input: {
    issueId: string;
    reporterPersonId: string;
    bytes: Buffer;
    fileName: string;
  }): Promise<IssuePhotoView> {
    const issue = await this.prisma.issue.findFirst({
      where: {
        id: input.issueId,
        reporterPersonId: input.reporterPersonId,
      },
      select: { id: true, _count: { select: { photos: true } } },
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    if (issue._count.photos >= MAX_PHOTOS_PER_ISSUE) {
      throw new IssueError(
        "This report already carries as many photographs as it may.",
        "too-many-photos",
      );
    }

    const file = await this.media.upload({
      bytes: input.bytes,
      fileName: input.fileName,
      visibility: "INTERNAL",
      // Whoever handles issues, and the reporter, through the issue: see
      // MediaService.open.
      requiredCapability: "issues:handle",
      /*
       * Declared true without asking, which is the safe direction.
       *
       * The declaration is the input the publication guardrails need: a person
       * may appear on a public page only with a recorded publication consent,
       * and a file nobody declared cannot be checked against that rule. Nobody
       * knows whether a photograph of a stairwell caught a neighbour on it, and
       * an issue photograph is never published anyway - so it is recorded as if
       * it shows someone, and a later path that wanted to publish it would have
       * to answer for that.
       */
      showsIdentifiablePersons: true,
      uploadedByPersonId: input.reporterPersonId,
      channel: "WEB",
      // A name somebody gave a photograph of their home is free text, and the
      // log is append-only: the purge that removes the photograph cannot
      // remove the name (ADR 0057).
      recordFileName: false,
    });

    /*
     * Counted again under the issue's lock. The count above only spares the
     * disk an upload that was going to be refused; uploads sent together all
     * pass it, and only a count that each of them takes in turn holds the cap
     * and gives every photograph its own place in the order.
     */
    let photo: { id: string };
    try {
      photo = await this.prisma.$transaction(async (tx) => {
        await lockIssue(tx, issue.id);
        const photos = await tx.issuePhoto.count({
          where: { issueId: issue.id },
        });
        if (photos >= MAX_PHOTOS_PER_ISSUE) {
          throw new IssueError(
            "This report already carries as many photographs as it may.",
            "too-many-photos",
          );
        }
        return tx.issuePhoto.create({
          data: { issueId: issue.id, fileId: file.id, sortOrder: photos },
          select: { id: true },
        });
      });
    } catch (cause) {
      // The upload is already in the audit log, and so is this removal. That
      // pair is the honest record of what happened.
      //
      // The media service logs a failure to remove the stored file, but not
      // one of its own database transaction, which would leave the file behind
      // with nothing in the logs to say so. The original failure is still the
      // one raised.
      await this.media
        .remove(file.id, input.reporterPersonId, "WEB", {
          recordFileName: false,
        })
        .catch((removal: unknown) => {
          this.logger.error(
            `Could not remove file ${file.id} after its photograph was refused: ` +
              failureName(removal),
          );
        });
      throw cause;
    }

    return {
      id: photo.id,
      url: file.url,
      fileName: file.fileName,
      width: file.width,
      height: file.height,
    };
  }

  /**
   * Files an issue with its type's defaults (decision 12): the type's default
   * priority, and its default assignee while that person still handles the
   * type. A type with no default assignee, or one whose default no longer
   * handles it, files the issue unassigned, which is the case the type's
   * handlers are told of.
   *
   * An assignment made here has no actor and is on the system's channel:
   * nobody chose it, the type's setting did, and its entry says so.
   */
  private async file(
    tx: Prisma.TransactionClient,
    data: Omit<
      Prisma.IssueUncheckedCreateInput,
      "priority" | "assigneePersonId"
    >,
  ): Promise<{ id: string }> {
    // Under the type's lock, which a change to who handles the type takes too
    // (`IssueTypeService.update`): a default assignee the change shuts out is
    // never given an issue filed while it commits.
    await lockIssueType(tx, data.typeId);
    const type = await tx.issueType.findUnique({
      where: { id: data.typeId },
      select: {
        handledBy: true,
        defaultPriority: true,
        defaultAssigneePersonId: true,
      },
    });
    if (type === null) {
      throw new IssueError("No such issue type.", "type-not-found");
    }
    if (data.placeId != null && data.apartmentId != null) {
      throw placeWithApartment();
    }
    if (data.placeId != null) {
      // A place the board switched off is not offered, so a report naming it
      // is answered as one naming a place that is not there. Held until the
      // insert commits, so its key cannot be the one that fails.
      if (!(await holdOfferedPlace(tx, data.placeId))) {
        throw new IssueError("No such place.", "place-not-found");
      }
    }
    const assigneePersonId =
      type.defaultAssigneePersonId !== null &&
      (await handlesIssues(
        tx,
        type.defaultAssigneePersonId,
        type.handledBy,
        new Date(),
      ))
        ? type.defaultAssigneePersonId
        : null;

    const filed = await tx.issue
      .create({
        data: { ...data, priority: type.defaultPriority, assigneePersonId },
        select: { id: true },
      })
      .catch(typeRemoved);

    if (assigneePersonId !== null) {
      await this.audit.record(
        {
          action: "ISSUE_ASSIGNED",
          channel: "SYSTEM",
          actorPersonId: null,
          targetPersonId: assigneePersonId,
          targetKind: "issue",
          targetId: filed.id,
          context: { byTypeDefault: true },
        },
        tx,
      );
    }
    // Store, then tell: the mail is a job this transaction writes (decision 12).
    await this.mailer.filedInTransaction(tx, filed.id);
    return filed;
  }

  /**
   * The scope of issues this person handles (`issueReaderScope`). The caller
   * holds issues:handle - every route here is under it - so a person in
   * neither scope does not reach this.
   */
  private async readerScope(
    db: Prisma.TransactionClient | PrismaService,
    personId: string,
    now: Date,
  ): Promise<IssueHandledBy> {
    return issueReaderScope(db, personId, now);
  }

  /**
   * The issues a view of the board's screen is read from: those the reader
   * handles, narrowed by the filter. A function of the transaction the read
   * runs in, because which issues the reader handles and who has protected
   * personal data have to be read at the moment the issues are: a board seat
   * that ends just before the read does not still show the board's own
   * issues. The instant it is read at is given by the caller, who takes it
   * inside the transaction.
   */
  private boardWhere(
    readerPersonId: string,
    filter: IssueBoardFilter,
  ): (
    db: Prisma.TransactionClient,
    now: Date,
  ) => Promise<Prisma.IssueWhereInput> {
    const terms = searchTermsOf(filter.search ?? "");
    return async (db, now) => ({
      AND: [
        // One after another: a transaction runs one statement at a time.
        issuesHandledWhere(await this.readerScope(db, readerPersonId, now)),
        filter.typeId === undefined ? {} : { typeId: filter.typeId },
        filter.placeId === undefined ? {} : { placeId: filter.placeId },
        filter.priority === undefined ? {} : { priority: filter.priority },
        terms.length === 0 ? {} : await this.searchWhere(db, terms),
      ],
    });
  }

  /**
   * What a search of the queue matches: each of its words (`searchTermsOf`:
   * the first `ISSUE_SEARCH_LIMITS.terms` different ones; any after those are
   * not read) somewhere in the issue's description, its location (the free
   * text), the name of its place, its type's name, its apartment's
   * designation, its reporter's name, a message in its conversation with the
   * reporter or an internal note on it, case aside and whichever Unicode form
   * the text was stored in. The words need not all be in one place: one in a
   * note and another in the description is a match.
   *
   * Never what the reader is not shown. A reporter with protected personal data
   * is shown without their name or apartment (`IssueReporterView`), so neither
   * matches on their reports: a row that came back for a name would say who
   * filed it, one guess at a time, whatever the row itself withholds. A
   * reporter who wrote through the website's form is not matched by name or
   * address at all, because both are stored encrypted. Only the issues the
   * reader handles are searched, which is the rule for everything a later
   * change adds to an issue as well: a text the reader may not open, on an
   * issue they handle or not, is never matched, or the answer tells them it is
   * there.
   *
   * Who has protected personal data is read in the transaction the issues are
   * read in, so a person whose data became protected after their name was
   * looked up cannot be matched by it.
   */
  private async searchWhere(
    db: Prisma.TransactionClient,
    terms: readonly string[],
  ): Promise<Prisma.IssueWhereInput> {
    const notProtected = await this.notReportedByProtectedPersons(db);
    const each: Prisma.IssueWhereInput[] = [];
    // One word after another: a transaction runs one statement at a time.
    for (const term of terms) {
      // The word in either Unicode form (`unicodeFormsOf`), case aside. The
      // database matches `contains` as a LIKE pattern without escaping it,
      // so a percent sign or an underscore typed by the handler would match
      // any text, and a backslash would escape the character after it; each
      // is escaped to match itself.
      const forms = unicodeFormsOf(term).map(
        (form) =>
          ({
            contains: form.replace(/[\\%_]/g, "\\$&"),
            mode: "insensitive",
          }) as const,
      );
      const reporters = await db.person.findMany({
        where: {
          protectedPersonalData: false,
          OR: forms.flatMap((matches) => [
            { firstName: matches },
            { lastName: matches },
          ]),
        },
        select: { id: true },
      });
      each.push({
        OR: [
          ...forms.flatMap((matches) => [
            { description: matches },
            { location: matches },
            // The board's own list (decision 30), shown on every row.
            { place: { name: matches } },
            { type: { name: matches } },
            // Every handler the issue lets in reads its whole conversation
            // and every note on it (`IssueConversationService`), so the
            // issues handled below are the boundary for these as well.
            { messages: { some: { body: matches } } },
            { notes: { some: { body: matches } } },
            { AND: [{ apartment: { number: matches } }, notProtected] },
          ]),
          ...(reporters.length === 0
            ? []
            : [
                {
                  reporterPersonId: {
                    in: reporters.map((person) => person.id),
                  },
                },
              ]),
        ],
      });
    }
    return { AND: each };
  }

  /**
   * An issue this person handles, or the refusal that answers an issue that
   * does not exist: one the reader may not open is not one they may learn of
   * (`requireHandledIssue`), with what a write needs.
   */
  private async requireHandled(
    db: Prisma.TransactionClient | PrismaService,
    issueId: string,
    readerPersonId: string,
  ) {
    return requireHandledIssue(db, issueId, readerPersonId, {
      id: true,
      typeId: true,
      boardOnly: true,
      assigneePersonId: true,
      priority: true,
      targetDate: true,
      costResponsibility: true,
      createdAt: true,
      knownFaultPublishedAt: true,
      status: { select: { meaning: true } },
      type: { select: { handledBy: true } },
      finding: { select: { kind: true, inspectedOn: true } },
    });
  }

  /**
   * The locks a write takes before it decides who may handle an issue or be
   * assigned it: its type's, then its own. Every write that checks the actor's
   * scope takes them, a status, priority or target date change included, so
   * none of them commits on a scope a change of the type's handlers has since
   * withdrawn.
   *
   * Who may be assigned turns on the type's handlers and the issue's own
   * board-only flag, and both can change while the write decides. The type's
   * settings change under the type's lock, which also unassigns whoever the
   * new setting shuts out (`IssueTypeService.update`), so a write that holds
   * it reads a setting nobody is changing. The type is read first, unlocked:
   * nothing moves an issue to another type. Always the type before the issue,
   * so two writes never wait on each other in the opposite order.
   */
  private async lockForAssignment(
    tx: Prisma.TransactionClient,
    issueId: string,
  ): Promise<void> {
    await lockIssueForHandling(tx, issueId);
  }

  /** The entry for an assignment changing, by hand or by an access change. */
  private async recordAssignment(
    tx: Prisma.TransactionClient,
    act: {
      issueId: string;
      actorPersonId: string;
      assigneePersonId: string | null;
      previousAssigneePersonId: string | null;
    },
  ): Promise<void> {
    await this.audit.record(
      {
        action: "ISSUE_ASSIGNED",
        channel: "WEB",
        actorPersonId: act.actorPersonId,
        targetPersonId: act.assigneePersonId,
        targetKind: "issue",
        targetId: act.issueId,
        // Facts about the act: the previous assignee, so a board can see an
        // issue changing hands, as the board mailbox records a thread's.
        context: { previousAssigneePersonId: act.previousAssigneePersonId },
      },
      tx,
    );
  }

  /**
   * An issue a handler's write has just changed, read in that write's
   * transaction, for `viewOfWritten` once it commits. The write authorised the
   * handler under its locks, so the row is not read through the reader's scope
   * a second time: a handler who stops handling the issue just after the write
   * commits would otherwise be told `issue-not-found` about a change that is
   * stored.
   */
  async writtenIssue(
    tx: Prisma.TransactionClient,
    issueId: string,
  ): Promise<QueueRecord> {
    return tx.issue.findUniqueOrThrow({
      where: { id: issueId },
      include: ISSUE_INCLUDE,
    });
  }

  /** The queue's row for an issue `writtenIssue` read. */
  async viewOfWritten(issue: QueueRecord): Promise<QueuedIssueView> {
    return this.viewOf(issue);
  }

  /** The queue's row for one issue just written. */
  private async viewOf(issue: QueueRecord): Promise<QueuedIssueView> {
    const [view] = await this.queuedViews([issue], "show");
    if (view === undefined) {
      throw new Error(`Issue ${issue.id} could not be viewed.`);
    }
    return view;
  }

  /**
   * The apartments the reporter may file against: their own, today.
   *
   * A picker over the whole register would enumerate the building, and an issue
   * filed against somebody else's home is a report about a neighbour rather
   * than about the building. The free-text location covers everything that is
   * not an apartment.
   */
  async ownApartments(personId: string): Promise<IssueApartmentView[]> {
    const residencies = await this.prisma.residency.findMany({
      where: { personId, ...residencyHeldOn(localDayOf(new Date())) },
      select: { apartment: { select: APARTMENT_SELECT } },
      orderBy: { movedInOn: "asc" },
    });

    const seen = new Set<string>();
    const apartments: IssueApartmentView[] = [];
    for (const residency of residencies) {
      if (seen.has(residency.apartment.id)) {
        continue;
      }
      seen.add(residency.apartment.id);
      apartments.push(toApartmentView(residency.apartment));
    }
    return apartments;
  }

  private async requireOwnApartment(
    personId: string,
    apartmentId: string,
  ): Promise<string> {
    const apartments = await this.ownApartments(personId);
    if (!apartments.some((apartment) => apartment.id === apartmentId)) {
      // Deliberately the same answer as an apartment that is not in the
      // register: otherwise this endpoint enumerates the building.
      throw new IssueError("No such apartment.", "apartment-not-found");
    }
    return apartmentId;
  }

  /**
   * Issues in the queue's order, from a point in it.
   *
   * One meaning after another, in the order `ISSUE_STATUS_MEANINGS` gives,
   * rather than one query sorted on the meaning: a sort on the column would be
   * the enum's declaration order, which is the database's and not the queue's
   * (ADR 0054). Within a meaning, `QUEUE_ORDER_WITHIN_MEANING`. A meaning before
   * the cursor's is skipped, and the cursor's own is read from just after it.
   * With `take`, at most that many rows, and fewer only at the end of the
   * queue.
   *
   * The meanings are read in one REPEATABLE READ transaction, so every one of
   * them sees the queue as it stood at one moment. At READ COMMITTED each
   * statement takes its own snapshot: an issue moved from new to in progress
   * between two of them would be read in both, and one moved the other way in
   * neither.
   */
  private async readQueue(
    where: Prisma.IssueWhereInput,
    meanings: readonly IssueStatusMeaning[],
    after: IssueQueueCursor | null,
    take: number | undefined,
  ): Promise<QueueRecord[]> {
    return this.prisma.$transaction(
      async (tx) => readQueueIn(tx, where, meanings, after, take),
      { isolationLevel: "RepeatableRead" },
    );
  }

  /**
   * The reporters of these issues, with whether their personal data is
   * protected, in one query.
   *
   * A search matches reporters by name only while their data is not protected
   * (`searchWhere`), so the rows a search returned and the protection that
   * masks their reporters have to be one reading: the queue's reads call this
   * inside the transaction that read the rows. Read after it, a protection
   * that began in between would return a row that matched a name with that
   * name masked, and so say whose it is.
   */
  private async readReporters(
    db: Prisma.TransactionClient | PrismaService,
    issues: readonly { reporterPersonId: string | null }[],
  ): Promise<ReadonlyMap<string, ReporterRow>> {
    const personIds = [
      ...new Set(
        issues
          .map((issue) => issue.reporterPersonId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const persons = await db.person.findMany({
      where: { id: { in: personIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    return new Map(persons.map((person) => [person.id, person]));
  }

  /**
   * Queue rows for these issues, with their reporters read in one query.
   *
   * The one place a list of rows becomes the queue's view, so a page and the
   * screen's whole list cannot disagree about what a row carries; with `omit`,
   * the rows whose reporter has protected personal data are dropped here.
   */
  private async queuedViews(
    issues: readonly (IssueRecord & {
      reporterPersonId: string | null;
      reporterNameCipher: string | null;
      reporterEmailCipher: string | null;
      reporterLink: {
        mailedAt: Date | null;
        revokedAt: Date | null;
        expiresAt: Date;
      } | null;
    })[],
    protectedReporters: ProtectedReporters,
    today: LocalDay = localDayOf(new Date()),
    reporters?: ReadonlyMap<string, ReporterRow>,
  ): Promise<QueuedIssueView[]> {
    const byId = reporters ?? (await this.readReporters(this.prisma, issues));
    const handler = await readAuthors(
      this.prisma,
      issues.flatMap((issue) => [
        issue.assigneePersonId,
        issue.enteredByPersonId,
      ]),
    );

    const views = await Promise.all(
      issues.map(async (issue) =>
        toQueuedView(
          issue,
          await this.reporterOf(issue, byId),
          {
            assignee:
              issue.assigneePersonId === null
                ? null
                : handler(issue.assigneePersonId),
            enteredBy:
              issue.enteredByPersonId === null
                ? null
                : handler(issue.enteredByPersonId),
          },
          today,
        ),
      ),
    );
    return protectedReporters === "omit"
      ? views.filter((view) => view.reporter.kind !== "protected")
      : views;
  }

  /**
   * The issues no person with protected personal data reported.
   *
   * `reporterPersonId` is a plain column rather than a relation (see the
   * schema), so the protected persons are named rather than joined. They are
   * few in any association. A null reporter is kept explicitly, because `NOT
   * IN` is not true of a null column.
   */
  private async notReportedByProtectedPersons(
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Prisma.IssueWhereInput> {
    const persons = await db.person.findMany({
      where: { protectedPersonalData: true },
      select: { id: true },
    });
    if (persons.length === 0) {
      return {};
    }
    return {
      OR: [
        { reporterPersonId: null },
        { reporterPersonId: { notIn: persons.map((person) => person.id) } },
      ],
    };
  }

  private async reporterOf(
    issue: {
      reporterPersonId: string | null;
      reporterNameCipher: string | null;
      reporterEmailCipher: string | null;
      closedAt: Date | null;
      reporterLink: {
        mailedAt: Date | null;
        revokedAt: Date | null;
        expiresAt: Date;
      } | null;
    },
    persons: ReadonlyMap<string, ReporterRow>,
  ): Promise<IssueReporterView> {
    const personId = issue.reporterPersonId;

    if (personId !== null) {
      const person = persons.get(personId);
      if (person === undefined) {
        return { kind: "unknown" };
      }
      if (person.protectedPersonalData) {
        return { kind: "protected" };
      }
      return {
        kind: "resident",
        personId: person.id,
        name: `${person.firstName} ${person.lastName}`.trim(),
      };
    }

    if (
      issue.reporterNameCipher === null &&
      issue.reporterEmailCipher === null
    ) {
      return { kind: "unknown" };
    }

    return {
      kind: "external",
      link: reporterLinkState(
        issue.reporterLink,
        {
          closedAt: issue.closedAt,
          hasContact: issue.reporterEmailCipher !== null,
        },
        new Date(),
      ),
      name:
        issue.reporterNameCipher === null
          ? null
          : await this.encryption.decrypt(
              "issue.reporterName",
              issue.reporterNameCipher,
            ),
      email:
        issue.reporterEmailCipher === null
          ? null
          : await this.encryption.decrypt(
              "issue.reporterEmail",
              issue.reporterEmailCipher,
            ),
    };
  }
}

const APARTMENT_SELECT = {
  id: true,
  number: true,
  address: { select: { street: true, number: true } },
} as const;

const ISSUE_INCLUDE = {
  type: { select: { id: true, name: true, reporters: true, handledBy: true } },
  status: {
    select: { id: true, label: true, meaning: true, sortOrder: true },
  },
  // The meaning alone, which is what a duplicate's reporter is told of the
  // issue it was merged into (`OwnIssueView`).
  mergedInto: { select: { status: { select: { meaning: true } } } },
  apartment: { select: APARTMENT_SELECT },
  place: { select: { id: true, name: true } },
  finding: { select: FINDING_SELECT },
  photos: {
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      file: { select: { id: true, fileName: true, width: true, height: true } },
    },
  },
  reporterLink: { select: REPORTER_LINK_STATE_SELECT },
} as const;

/**
 * The order within one meaning: the board's order of the statuses, then oldest
 * first. The identifier makes the order total, which a cursor needs: rows
 * written in one transaction share an instant exactly. The meanings themselves
 * are read one after another (`IssueService.readQueue`), never in an enum's
 * declaration order.
 */
const QUEUE_ORDER_WITHIN_MEANING = [
  { status: { sortOrder: "asc" } },
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.IssueOrderByWithRelationInput[];

/** The meanings a read covers, in the queue's order. */
function meaningsOf(
  meaning: IssueStatusMeaning | undefined,
): readonly IssueStatusMeaning[] {
  return meaning === undefined ? ISSUE_STATUS_MEANINGS : [meaning];
}

/**
 * The meanings a view of the board's screen covers under its status filter,
 * in the queue's order: the open ones in `OVERDUE`, which a closed issue never
 * is, every meaning in the other three, and of those the ones the filter asks
 * for. Empty when the filter asks Försenade for closed issues.
 */
export function meaningsInView(
  view: IssueQueueView,
  filter: IssueMeaningFilter | undefined,
): readonly IssueStatusMeaning[] {
  const inView: readonly IssueStatusMeaning[] =
    view === "OVERDUE" ? ISSUE_OPEN_MEANINGS : ISSUE_STATUS_MEANINGS;
  const asked: readonly IssueStatusMeaning[] =
    filter === undefined
      ? ISSUE_STATUS_MEANINGS
      : filter === "OPEN"
        ? ISSUE_OPEN_MEANINGS
        : [filter];
  return inView.filter((meaning) => asked.includes(meaning));
}

/**
 * Whose issues, or which, a view holds beside its meanings. Overdue reads the
 * target date against the association's calendar day exactly as a row's
 * `overdue` is computed (`toQueuedView`): a date before today, never today
 * itself, and no date is never overdue.
 */
export function viewWhere(
  view: IssueQueueView,
  readerPersonId: string,
  today: LocalDay,
): Prisma.IssueWhereInput {
  switch (view) {
    case "MINE":
      return { assigneePersonId: readerPersonId };
    case "UNASSIGNED":
      return { assigneePersonId: null };
    case "OVERDUE":
      return { targetDate: { lt: dateColumnOf(today) } };
    case "ALL":
      return {};
  }
}

/**
 * Issues in the queue's order, from a point in it, read in the transaction
 * given, as `IssueService.readQueue` describes. The caller's transaction is
 * REPEATABLE READ, so every meaning sees the queue at one moment.
 */
async function readQueueIn(
  tx: Prisma.TransactionClient,
  where: Prisma.IssueWhereInput,
  meanings: readonly IssueStatusMeaning[],
  after: IssueQueueCursor | null,
  take: number | undefined,
): Promise<QueueRecord[]> {
  const from =
    after === null ? 0 : ISSUE_STATUS_MEANINGS.indexOf(after.meaning);
  const rows: QueueRecord[] = [];
  for (const meaning of meanings) {
    if (ISSUE_STATUS_MEANINGS.indexOf(meaning) < from) {
      continue;
    }
    const remaining = take === undefined ? undefined : take - rows.length;
    if (remaining === 0) {
      break;
    }
    rows.push(
      ...(await tx.issue.findMany({
        where: {
          AND: [
            where,
            { status: { meaning } },
            after !== null && meaning === after.meaning
              ? afterWithinMeaning(after)
              : {},
          ],
        },
        orderBy: QUEUE_ORDER_WITHIN_MEANING,
        ...(remaining === undefined ? {} : { take: remaining }),
        include: ISSUE_INCLUDE,
      })),
    );
  }
  return rows;
}

/**
 * How many issues each view holds of those `where` selects, counted in the
 * transaction given by the conditions each view is read by.
 */
async function countQueueIn(
  tx: Prisma.TransactionClient,
  where: Prisma.IssueWhereInput,
  readerPersonId: string,
  today: LocalDay,
  meaning: IssueMeaningFilter | undefined,
): Promise<IssueQueueCounts> {
  const count = async (view: IssueQueueView): Promise<number> => {
    const meanings = meaningsInView(view, meaning);
    return meanings.length === 0
      ? 0
      : tx.issue.count({
          where: {
            AND: [
              where,
              viewWhere(view, readerPersonId, today),
              { status: { meaning: { in: [...meanings] } } },
            ],
          },
        });
  };
  // One after another: a transaction runs one statement at a time.
  const mine = await count("MINE");
  const unassigned = await count("UNASSIGNED");
  const overdue = await count("OVERDUE");
  const all = await count("ALL");
  return { mine, unassigned, overdue, all };
}

/**
 * The words of a search, as `IssueService.searchWhere` matches them: split on
 * white space, each once, at most `ISSUE_SEARCH_LIMITS.terms` of them. Blank
 * is no words, which is no search.
 *
 * Composed (NFC), so an "ä" typed as "a" and a combining mark is one word with
 * an "ä" typed as one character; `unicodeFormsOf` then matches it against
 * stored text in either form. Invisible format characters (a zero-width space
 * pasted with a word) are dropped, so they neither make a word of their own
 * nor keep the word they cling to from matching. The zero-width joiner and
 * non-joiner stay: they change what a word is in emoji and in some scripts,
 * and stored text keeps them.
 *
 * Stored text is not cleaned the same way: a description holding a zero-width
 * space inside a word is not found by that word without it (ADR 0054).
 */
export function searchTermsOf(search: string): string[] {
  const words = search
    .slice(0, ISSUE_SEARCH_LIMITS.length)
    .normalize("NFC")
    .replace(/\p{Cf}/gu, (char) =>
      char === "\u200C" || char === "\u200D" ? char : "",
    )
    .split(/\s+/u)
    .filter((word) => word !== "");
  // Each word once whatever its case, because the match ignores case: two
  // spellings of one word would otherwise use two of the places.
  const seen = new Set<string>();
  const different = words.filter((word) => {
    const key = word.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return different.slice(0, ISSUE_SEARCH_LIMITS.terms);
}

/**
 * A search word composed (NFC) and decomposed (NFD), once each when they
 * differ. Text is stored as it was sent, and the database compares it
 * character by character, so "läcka" written with a combining mark is found
 * only by the decomposed word and written as one character only by the
 * composed one.
 *
 * Only these two uniform forms: a word that mixes a composed and a decomposed
 * accent within itself is found by neither. Finding that too would take
 * normalisation in the database or on write, which this does not do.
 */
export function unicodeFormsOf(term: string): string[] {
  return [...new Set([term.normalize("NFC"), term.normalize("NFD")])];
}

function queueWhere(filter: IssueQueueFilter): Prisma.IssueWhereInput {
  return {
    ...(filter.typeId === undefined ? {} : { typeId: filter.typeId }),
    ...(filter.placeId === undefined ? {} : { placeId: filter.placeId }),
    ...(filter.reporter === undefined
      ? {}
      : { type: { reporters: { has: filter.reporter } } }),
  };
}

/** Where in the queue a row stands, as a cursor names it. */
function cursorOf(row: QueueRecord): IssueQueueCursor {
  return {
    meaning: row.status.meaning,
    position: row.status.sortOrder,
    createdAt: row.createdAt,
    id: row.id,
  };
}

/**
 * Everything in one meaning strictly after a point in it, written out for the
 * reason `afterInQueue` in the motion service gives: the query builder's own
 * cursor names a row, and a purged row would answer a page silently empty.
 */
function afterWithinMeaning(cursor: IssueQueueCursor): Prisma.IssueWhereInput {
  return {
    OR: [
      { status: { sortOrder: { gt: cursor.position } } },
      {
        status: { sortOrder: cursor.position },
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      },
    ],
  };
}

/**
 * What an issue holds after a move, or the refusal of it.
 *
 * The closing date is written on the move into DONE and left alone on a move
 * between two DONE statuses: a board member clicking twice, or a retry, would
 * otherwise put a new date on an issue nobody reopened, and a clock that
 * resets when somebody presses the same button again is not a clock - a public
 * reporter's contact details would be kept past the window the policy states.
 * It is null again on a move out of DONE, and its own column rather than
 * updatedAt, which is what the retention clock on a public-form report would
 * otherwise run on: detaching a reporter from a neighbouring issue is an
 * update, so a clock reading updatedAt would push its own purge date away
 * every night the purge ran.
 *
 * A duplicate stays merged on a move between two DONE statuses that keeps its
 * outcome, and leaves the issue it was merged into on any other move: reopened,
 * or closed again with an outcome of its own, it is no longer a duplicate, and
 * its reporter follows it again rather than the other issue. Closing clears a
 * known fault, which a fault nobody still has stops being.
 */
function nextState(
  existing: {
    closedAt: Date | null;
    outcome: IssueOutcome | null;
    mergedIntoIssueId: string | null;
    status: { meaning: IssueStatusMeaning };
  },
  target: { id: string; meaning: IssueStatusMeaning },
  move: IssueStatusMove,
): {
  statusId: string;
  waitingReason: IssueWaitingReason | null;
  outcome: IssueOutcome | null;
  closedAt: Date | null;
  mergedIntoIssueId: string | null;
} & Partial<typeof KNOWN_FAULT_CLEARED> &
  Partial<typeof NO_ENTRY_PERMISSION> {
  if (target.meaning !== "WAITING" && move.waitingReason !== undefined) {
    throw new IssueError(
      "A waiting reason belongs to a status that means waiting.",
      "status-detail-not-applicable",
    );
  }
  if (target.meaning !== "DONE" && move.outcome !== undefined) {
    throw new IssueError(
      "An outcome belongs to a status that means done.",
      "status-detail-not-applicable",
    );
  }
  if (target.meaning === "WAITING" && move.waitingReason === undefined) {
    throw new IssueError(
      "Say what the issue is waiting for.",
      "waiting-reason-required",
    );
  }
  const closing = target.meaning === "DONE";
  const wasClosed = existing.status.meaning === "DONE";
  const outcome = closing
    ? (move.outcome ?? (wasClosed ? existing.outcome : null))
    : null;
  if (closing && !wasClosed && outcome === null) {
    throw new IssueError("Say how the issue ended.", "outcome-required");
  }
  return {
    statusId: target.id,
    waitingReason: move.waitingReason ?? null,
    outcome,
    closedAt: closing ? (existing.closedAt ?? new Date()) : null,
    mergedIntoIssueId:
      closing && outcome === "DUPLICATE" ? existing.mergedIntoIssueId : null,
    ...(closing ? KNOWN_FAULT_CLEARED : {}),
    /*
     * The entry permission is cleared in the transaction that closes the issue
     * (decision 29): what a resident said about getting into their home has no
     * business outliving the work it was given for. A move between two DONE
     * statuses finds it already gone, and a database constraint refuses a
     * closed issue that holds one.
     */
    ...(closing ? NO_ENTRY_PERMISSION : {}),
  };
}

/** The columns of a known fault, cleared. */
const KNOWN_FAULT_CLEARED = {
  knownFault: null,
  knownFaultSignature: null,
  knownFaultPublishedAt: null,
} as const;

/** What a queue row's reporter is read as: the person, protection included. */
interface ReporterRow {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
}

export type QueueRecord = Prisma.IssueGetPayload<{
  include: typeof ISSUE_INCLUDE;
}>;

/**
 * Refuses a follow-up of anything but one's own issue that is done: another
 * person's issue is answered as one that does not exist, and an open one takes
 * a reply instead.
 *
 * Under the locks a handler's reopening of the earlier issue takes, so the
 * status read here is the one the new issue is saved against: the locks of the
 * earlier issue's type and of the type being filed under, in one sorted order,
 * and then the earlier issue's own. The type before the issue is the order
 * `lockIssueForHandling` keeps, and sorting the types keeps two follow-ups
 * whose earlier and new types are swapped from waiting on each other.
 * `file` takes the new type's lock again, which a transaction already holds.
 */
async function requireFollowable(
  tx: Prisma.TransactionClient,
  issueId: string,
  reporterPersonId: string,
  newTypeId: string,
): Promise<void> {
  const own = await tx.issue.findFirst({
    where: { id: issueId, reporterPersonId },
    select: { typeId: true },
  });
  if (own === null) {
    throw new IssueError("No such issue.", "issue-not-found");
  }
  for (const typeId of [...new Set([own.typeId, newTypeId])].sort()) {
    await lockIssueType(tx, typeId);
  }
  await lockIssue(tx, issueId);
  const earlier = await tx.issue.findFirst({
    where: { id: issueId, reporterPersonId },
    select: { status: { select: { meaning: true } } },
  });
  if (earlier === null) {
    throw new IssueError("No such issue.", "issue-not-found");
  }
  if (earlier.status.meaning !== "DONE") {
    throw new IssueError(
      "That issue is still open; reply on it instead.",
      "follow-up-of-open-issue",
    );
  }
}

const REFERENCE_SELECT = {
  id: true,
  createdAt: true,
  type: { select: { name: true } },
  status: { select: { meaning: true } },
} as const;

function toReference(
  row: Prisma.IssueGetPayload<{ select: typeof REFERENCE_SELECT }>,
): Extract<IssueReferenceView, { kind: "issue" }> {
  return {
    kind: "issue",
    id: row.id,
    typeName: row.type.name,
    meaning: row.status.meaning,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ApartmentRecord {
  id: string;
  number: string;
  address: { street: string; number: string };
}

/** An apartment as the issue screens name it: designation and entrance. */
export function toApartmentView(
  apartment: ApartmentRecord,
): IssueApartmentView {
  return {
    id: apartment.id,
    number: apartment.number,
    address: `${apartment.address.street} ${apartment.address.number}`,
  };
}

/**
 * Refuses a report whose post would not take it, which takes the report back
 * with the transaction it was filed in.
 */
function refuseUnlinked(outcome: IssueLinkOutcome): void {
  switch (outcome) {
    case "linked":
      return;
    case "post-not-found":
      throw new IssueError("No such post.", "post-not-found");
    case "not-reportable":
      throw new IssueError(
        "Only its writer or the board makes a report from a post.",
        "post-not-reportable",
      );
    case "already-reported":
      throw new IssueError(
        "A report has already been made from this post.",
        "post-already-reported",
      );
  }
}

/**
 * A location as it is filed: null where none was given, and where the field
 * holds only blanks. Every way an issue is filed reads it through this, so a
 * blank location is never stored, and a handler's redaction or the purge never
 * records the removal of one nobody wrote.
 */
function locationOrNull(location: string | null | undefined): string | null {
  return location == null || location.trim() === "" ? null : location;
}

/**
 * A report whose type was removed after it was read.
 *
 * Both reporting paths read the type before they write, so a board removing it
 * at the same moment makes the insert raise P2003 against the restrictive key.
 * That is a type that does not exist, and is answered as one rather than with
 * a 500. The apartment's key cannot be the one: the reporter's residency holds
 * the apartment in the register. Nor can the place's: `holdOfferedPlace` holds
 * it until the insert commits.
 */
function typeRemoved(cause: unknown): never {
  if (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2003"
  ) {
    throw new IssueError("No such issue type.", "type-not-found");
  }
  throw cause;
}

interface IssueRecord extends EntryColumns {
  id: string;
  number: number;
  priority: IssuePriority;
  targetDate: Date | null;
  boardOnly: boolean;
  costResponsibility: IssueCostResponsibility | null;
  assigneePersonId: string | null;
  enteredByPersonId: string | null;
  enteredByHandler: boolean;
  status: {
    id: string;
    label: string;
    meaning: IssueStatusMeaning;
    sortOrder: number;
  };
  waitingReason: IssueWaitingReason | null;
  outcome: IssueOutcome | null;
  mergedIntoIssueId: string | null;
  mergedInto: { status: { meaning: IssueStatusMeaning } } | null;
  knownFault: string | null;
  knownFaultSignature: IssueSignature | null;
  knownFaultPublishedAt: Date | null;
  location: string | null;
  description: string;
  descriptionRedactedAt: Date | null;
  locationRedactedAt: Date | null;
  freeTextRemovedAt: Date | null;
  legalHoldAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  type: {
    id: string;
    name: string;
    reporters: IssueReporterGroup[];
    handledBy: IssueHandledBy;
  };
  apartment: ApartmentRecord | null;
  place: IssuePlaceRef | null;
  finding: FindingRecord | null;
  photos: {
    id: string;
    file: {
      id: string;
      fileName: string;
      width: number | null;
      height: number | null;
    };
  }[];
}

/**
 * The one way a queue row is built, so the listing and the answer to a status
 * change cannot disagree about what a protected reporter's row carries.
 */
function toQueuedView(
  issue: IssueRecord,
  reporter: IssueReporterView,
  handlers: {
    assignee: IssueHandlerView | null;
    enteredBy: IssueHandlerView | null;
  },
  today: LocalDay,
): QueuedIssueView {
  const targetDate = formatDateColumn(issue.targetDate);
  const queued = {
    ...toIssueRowView(issue, today),
    aboutApartment: issue.apartment !== null,
    status: { id: issue.status.id, label: issue.status.label },
    waitingReason: issue.waitingReason,
    outcome: issue.outcome,
    typeReporters: issue.type.reporters,
    typeHandledBy: issue.type.handledBy,
    closedAt: issue.closedAt?.toISOString() ?? null,
    priority: issue.priority,
    targetDate,
    overdue:
      issue.targetDate !== null &&
      issue.status.meaning !== "DONE" &&
      compareLocalDays(localDayOfColumn(issue.targetDate), today) < 0,
    assignee: handlers.assignee,
    enteredBy: handlers.enteredBy,
    boardOnly: issue.boardOnly,
    knownFault: knownFaultOf(issue),
    finding: toFindingView(issue.finding),
    legalHoldAt: issue.legalHoldAt?.toISOString() ?? null,
    costResponsibility: issue.costResponsibility,
  };
  if (reporter.kind === "protected") {
    return { ...queued, apartment: null, reporter };
  }
  return { ...queued, reporter };
}

/** An issue as its reporter reads it, at this moment. */
function toOwnView(issue: IssueRecord, now: Date): OwnIssueView {
  return {
    ...toIssueRowView(issue, localDayOf(now)),
    replyMode:
      issue.status.meaning !== "DONE"
        ? "MESSAGE"
        : issue.mergedIntoIssueId === null &&
            replyReopensIssue(issue.closedAt, now)
          ? "REOPENS"
          : "NEW_REPORT",
    mergedIntoMeaning:
      issue.mergedIntoIssueId === null
        ? null
        : (issue.mergedInto?.status.meaning ?? null),
  };
}

function toIssueRowView(issue: IssueRecord, today: LocalDay): IssueRowView {
  return {
    id: issue.id,
    number: issue.number,
    meaning: issue.status.meaning,
    typeId: issue.type.id,
    typeName: issue.type.name,
    location: issue.location,
    place: issue.place,
    description: issue.description,
    apartment:
      issue.apartment === null ? null : toApartmentView(issue.apartment),
    entry: toEntryView(issue, today),
    enteredByHandler: issue.enteredByHandler,
    photos: issue.photos.map((photo) => ({
      id: photo.id,
      url: mediaUrl(photo.file.id),
      fileName: photo.file.fileName,
      width: photo.file.width,
      height: photo.file.height,
    })),
    descriptionRedactedAt: issue.descriptionRedactedAt?.toISOString() ?? null,
    locationRedactedAt: issue.locationRedactedAt?.toISOString() ?? null,
    freeTextRemovedAt: issue.freeTextRemovedAt?.toISOString() ?? null,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}

/** The audit actions an issue's timeline is read from. */
const TIMELINE_ACTIONS = [
  "ISSUE_OPENED",
  "ISSUE_STATUS_CHANGED",
  "ISSUE_ASSIGNED",
  "ISSUE_PRIORITY_CHANGED",
  "ISSUE_TARGET_DATE_CHANGED",
  "ISSUE_ACCESS_CHANGED",
  "ISSUE_KNOWN_FAULT_CHANGED",
  "ISSUE_PLACE_CHANGED",
  "ISSUE_ENTRY_PERMISSION_SET",
  "ISSUE_ENTRY_PERMISSION_REMOVED",
  "ISSUE_FINDING_MARKED",
  "ISSUE_FINDING_REMOVED",
  "ISSUE_WORK_ORDER_SENT",
  "ISSUE_REDACTED",
  "ISSUE_LEGAL_HOLD_PLACED",
  "ISSUE_LEGAL_HOLD_RELEASED",
  "ISSUE_COST_RESPONSIBILITY_CHANGED",
] as const satisfies readonly AuditAction[];

/**
 * One audit entry as a step of the timeline.
 *
 * The context is read defensively, because an entry is never rewritten: one
 * written before a field existed lacks it - a status change recorded before
 * statuses were rows names only the two meanings - and the step then says it
 * does not know rather than guessing.
 */
function timelineStep(
  entry: {
    action: (typeof TIMELINE_ACTIONS)[number] | AuditAction;
    targetPersonId: string | null;
    context: Prisma.JsonValue;
    createdAt: Date;
  },
  actor: IssueHandlerView | null,
  person: (id: string | null) => IssueHandlerView | null,
  deliveryOf: ReadonlyMap<string, IssueTimelineWorkOrderDelivery>,
): IssueTimelineStep {
  const context =
    entry.context !== null &&
    typeof entry.context === "object" &&
    !Array.isArray(entry.context)
      ? entry.context
      : {};
  const text = (key: string): string | null => {
    const value = context[key];
    return typeof value === "string" ? value : null;
  };
  const at = entry.createdAt.toISOString();

  switch (entry.action) {
    case "ISSUE_OPENED":
      return { kind: "opened", at, actor, internal: context.internal === true };
    case "ISSUE_ASSIGNED":
      return {
        kind: "assigned",
        at,
        actor,
        assignee: person(entry.targetPersonId),
        byTypeDefault: context.byTypeDefault === true,
      };
    case "ISSUE_PRIORITY_CHANGED":
      return {
        kind: "priority",
        at,
        actor,
        from: oneOf(text("from"), ISSUE_PRIORITIES),
        to: oneOf(text("to"), ISSUE_PRIORITIES),
      };
    case "ISSUE_TARGET_DATE_CHANGED":
      return {
        kind: "targetDate",
        at,
        actor,
        from: text("from"),
        to: text("to"),
      };
    case "ISSUE_ACCESS_CHANGED":
      return {
        kind: "access",
        at,
        actor,
        boardOnly: context.boardOnly === true,
      };
    case "ISSUE_KNOWN_FAULT_CHANGED":
      return {
        kind: "knownFault",
        at,
        actor,
        published: context.published === true,
      };
    case "ISSUE_PLACE_CHANGED":
      return { kind: "place", at, actor, placeId: text("to") };
    case "ISSUE_ENTRY_PERMISSION_SET":
      return {
        kind: "entry",
        at,
        actor,
        answer: oneOf(text("answer"), ISSUE_ENTRY_ANSWERS),
        byReporter: context.byReporter === true,
      };
    case "ISSUE_ENTRY_PERMISSION_REMOVED":
      return {
        kind: "entry",
        at,
        actor,
        answer: null,
        byReporter: context.byReporter === true,
      };
    case "ISSUE_FINDING_MARKED":
      return {
        kind: "finding",
        at,
        actor,
        findingKind: oneOf(text("kind"), ISSUE_FINDING_KINDS),
      };
    case "ISSUE_FINDING_REMOVED":
      return { kind: "finding", at, actor, findingKind: null };
    case "ISSUE_WORK_ORDER_SENT":
      return {
        kind: "workOrder",
        at,
        actor,
        delivery: deliveryOf.get(text("workOrderId") ?? "") ?? null,
      };
    case "ISSUE_REDACTED":
      return {
        kind: "redacted",
        at,
        actor,
        target: oneOf(text("target"), ISSUE_REDACTION_TARGETS),
      };
    case "ISSUE_LEGAL_HOLD_PLACED":
    case "ISSUE_LEGAL_HOLD_RELEASED":
      return {
        kind: "legalHold",
        at,
        actor,
        held: entry.action === "ISSUE_LEGAL_HOLD_PLACED",
      };
    case "ISSUE_COST_RESPONSIBILITY_CHANGED":
      return {
        kind: "costResponsibility",
        at,
        actor,
        from: oneOf(text("from"), ISSUE_COST_RESPONSIBILITIES),
        to: oneOf(text("to"), ISSUE_COST_RESPONSIBILITIES),
      };
    default:
      return {
        kind: "status",
        at,
        actor,
        fromMeaning: oneOf(text("from"), ISSUE_STATUS_MEANINGS),
        toMeaning: oneOf(text("to"), ISSUE_STATUS_MEANINGS),
        fromStatusId: text("fromStatusId"),
        toStatusId: text("toStatusId"),
        waitingReason: oneOf(text("waitingReason"), ISSUE_WAITING_REASONS),
        outcome: oneOf(text("outcome"), ISSUE_OUTCOMES),
        byReporter: context.byReporter === true,
      };
  }
}

/** A value of a fixed list, or null when the entry held something else. */
function oneOf<T extends string>(
  value: string | null,
  values: readonly T[],
): T | null {
  return (values as readonly (string | null)[]).includes(value)
    ? (value as T)
    : null;
}
