import type {
  AuthorView,
  IssueClosingOutcome,
  IssueEntryAnswer,
  IssueFindingKind,
  IssueCostResponsibility,
  IssueDamageCause,
  IssueHandledBy,
  IssueMeaningFilter,
  IssueOutcome,
  IssuePriority,
  IssueReplyMode,
  IssueQueueView,
  IssueRedactionTarget,
  IssueReporterGroup,
  IssueSignature,
  IssueStatusMeaning,
  IssueWaitingReason,
  MaintenanceResponsibility,
} from "@openbrf/shared";

import { apiRequest, apiUpload, type ApiResult } from "./client";
import { previewedIssueTypes, previewing } from "./viewer-preview";

/**
 * The issue endpoints.
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * One property of the contract is load-bearing and invisible in the types.
 * `fetchReportableTypes` returns the types this account may report under, and
 * that filter is the SERVER's - it is not a hint the form is free to widen. A
 * type identifier that did not come back from this call is refused by the API
 * as if it did not exist, which is what keeps the board's internal categories
 * out of a resident's reach. The resident preview only narrows it further,
 * keeping the types residents may report (see viewer-preview.ts).
 *
 * The vocabulary of statuses - the four meanings, the waiting reasons, the
 * outcomes and the groups who may report a type - comes from `@openbrf/shared`
 * rather than being spelled here, so the two applications cannot drift
 * (ADR 0054).
 */

/** A status of one type, as the board configures it. */
export interface IssueStatusView {
  id: string;
  meaning: IssueStatusMeaning;
  /** The board's own text, stored as written. */
  label: string;
  /** The status of its meaning an issue enters when none is named. */
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  /** How many issues stand in it now. */
  issueCount: number;
}

/** A type as the board configures it, and as a handler moves issues by it. */
export interface IssueTypeView {
  id: string;
  name: string;
  reporters: IssueReporterGroup[];
  active: boolean;
  sortOrder: number;
  /** Who handles its issues: every handler, or the board only. */
  handledBy: IssueHandledBy;
  /** The priority its issues are filed with. */
  defaultPriority: IssuePriority;
  /**
   * Read by the board alone, with nothing about its issues leaving it, and
   * their free text removed a year after closing (decision 32).
   */
  ringFenced: boolean;
  reportCount: number;
  /** By meaning, then in the board's order within it. */
  statuses: IssueStatusView[];
}

/**
 * A handler as an issue names them: by name, or by identifier alone where the
 * name is withheld (protected personal data), or unknown once purged. The
 * feed's `AuthorView`, which the server builds by the feed's one mapping.
 */
export type IssueHandler = AuthorView;

/** A type on the board's configuration screen, with its default assignee. */
export type ConfiguredIssueType = IssueTypeView & {
  defaultAssignee: IssueHandler | null;
};

/** Somebody a type's issues may be given to by default. */
export interface IssueHandlerChoice {
  handler: IssueHandler;
  /** Kept on a type the board handles alone. */
  board: boolean;
}

/** A type as this account is offered it. */
export interface ReportableIssueType {
  id: string;
  name: string;
  reporters: IssueReporterGroup[];
  /** Ring-fenced: the form warns before the reporter writes (decision 32). */
  ringFenced: boolean;
}

export interface IssueApartment {
  id: string;
  number: string;
  address: string;
}

/** A common-area place, as a reporter or a handler picks it (decision 30). */
export interface IssuePlaceChoice {
  id: string;
  name: string;
}

/** A place with how many of the issues this handler may open name it. */
export interface IssuePlaceCount extends IssuePlaceChoice {
  active: boolean;
  issues: number;
  open: number;
}

/** A place as the board edits it. */
export interface ConfiguredIssuePlace extends IssuePlaceChoice {
  active: boolean;
  sortOrder: number;
  issueCount: number;
}

export interface IssuePlaceInput {
  name: string;
  active?: boolean;
  sortOrder?: number;
}

/** The resident's entry permission on an issue (decision 29). */
export interface IssueEntry {
  answer: IssueEntryAnswer;
  note: string | null;
  pets: boolean | null;
  masterKey: boolean | null;
  /** `YYYY-MM-DD`, or null for no end. */
  until: string | null;
  /** Past its last day; still shown until the issue closes. */
  expired: boolean;
}

/** What the resident, or a handler for them, answers. */
export interface IssueEntryInput {
  answer: IssueEntryAnswer;
  note?: string | null;
  pets?: boolean;
  masterKey?: boolean;
  until?: string | null;
}

/** The mark of an inspection finding on an issue (decision 31). */
export interface IssueFinding {
  kind: IssueFindingKind;
  /** `YYYY-MM-DD`. */
  inspectedOn: string;
  /** One of the issue's handler files, or null once it has been removed. */
  protocol: { attachmentId: string; fileName: string } | null;
}

export interface IssueFindingInput {
  kind: IssueFindingKind;
  inspectedOn: string;
  protocolAttachmentId: string;
  targetDate: string;
}

export interface IssuePhoto {
  id: string;
  url: string;
  fileName: string;
  width: number | null;
  height: number | null;
}

/**
 * An issue as its reporter reads it: where it stands as the meaning of its
 * status, never the board's label for it.
 */
export interface IssueRow {
  id: string;
  /** The issue number (ärendenummer), which every mail about it names. */
  number: number;
  meaning: IssueStatusMeaning;
  typeId: string;
  typeName: string;
  location: string | null;
  /** The common-area place it is about, or null. */
  place: IssuePlaceChoice | null;
  description: string;
  apartment: IssueApartment | null;
  /** The resident's answer about entering the apartment, or null. */
  entry: IssueEntry | null;
  photos: IssuePhoto[];
  /** Whether a handler opened it on the reporter's behalf; never which one. */
  enteredByHandler: boolean;
  /**
   * When a handler redacted the description or the location (ADR 0057). The
   * text is then empty, and the screen says it was removed instead.
   */
  descriptionRedactedAt: string | null;
  locationRedactedAt: string | null;
  /**
   * When the nightly purge removed the free text, the conversation and the
   * photographs after the issue closed, or null while they stand. A
   * photograph attached while the purge ran can stand after this is set, until
   * the next run takes it and moves the date.
   */
  freeTextRemovedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OwnIssue extends IssueRow {
  /**
   * What a reply does, as the server decided it: a message on an open issue,
   * a reopening within the window after it closed, and after that, or once it
   * was merged, a new report linked to it instead (ADR 0054).
   */
  replyMode: IssueReplyMode;
  /** Where the issue it was merged into stands, while it is a duplicate. */
  mergedIntoMeaning: IssueStatusMeaning | null;
}

/**
 * A known fault (känt fel): a handler's notice about a fault the house already
 * knows of, signed with a role and never a person, with the type's name.
 */
export interface KnownFault {
  body: string;
  signature: IssueSignature;
  publishedAt: string;
  /** Null on a type only handlers report, whose name is the board's own. */
  typeName: string | null;
}

/**
 * Another issue an issue is linked to, as a handler is told of it, or
 * `hidden` when the reader does not handle it or it is gone.
 */
export type IssueReference =
  | {
      kind: "issue";
      id: string;
      typeName: string;
      meaning: IssueStatusMeaning;
      createdAt: string;
    }
  | { kind: "hidden" };

/** The issues one issue is linked to (decisions 8 and 22). */
export interface IssueLinks {
  mergedInto: IssueReference | null;
  duplicates: Extract<IssueReference, { kind: "issue" }>[];
  /**
   * How many issues are merged into this one, those the reader does not
   * handle included: merging this one into another is refused while there are
   * any.
   */
  duplicateCount: number;
  follows: IssueReference | null;
  /** The first follow-ups the reader handles, a page of them. */
  followUps: Extract<IssueReference, { kind: "issue" }>[];
  /** How many follow-ups the reader handles, those not listed included. */
  followUpCount: number;
}

/**
 * Who reported an issue.
 *
 * `protected` carries no name: a person with protected personal data is masked
 * in this view, which an external property manager reads. The queued issue's
 * apartment is null with it, because on their report it is where they live.
 * `unknown` is a
 * reporter the register no longer holds - issue data outlives nobody, and the
 * queue says so rather than inventing a name.
 *
 * `external` is a reporter without an account, from the website's form. Their
 * `link` is where the private link mailed to them stands (ADR 0055): `live`
 * opens the issue, so a handler's message reaches them; `ended` was mailed and
 * no longer opens it (withdrawn, expired, or the issue closed 30 days ago);
 * `none` was never mailed, because they left no address or none could be sent.
 */
export type IssueReporter =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected" }
  | {
      kind: "external";
      name: string | null;
      email: string | null;
      link: ReporterLinkState;
    }
  | { kind: "unknown" };

/** Where an external reporter's private link stands. */
export type ReporterLinkState = "live" | "ended" | "pending" | "none";

export type QueuedIssue = IssueRow & {
  /**
   * Filed against an apartment, true also while `apartment` is withheld for a
   * protected reporter. Decides between the entry permission and a place.
   */
  aboutApartment: boolean;
  /** The status it stands in, as the board named it for its type. */
  status: { id: string; label: string };
  waitingReason: IssueWaitingReason | null;
  /** Null while open, and on an issue closed before outcomes existed. */
  outcome: IssueOutcome | null;
  typeReporters: IssueReporterGroup[];
  typeHandledBy: IssueHandledBy;
  /** Its type is ring-fenced: the board's alone, and nothing leaves it. */
  typeRingFenced: boolean;
  closedAt: string | null;
  priority: IssuePriority;
  /** `YYYY-MM-DD`, or null. */
  targetDate: string | null;
  /** Past its target date and not done, on the association's calendar. */
  overdue: boolean;
  assignee: IssueHandler | null;
  /** The handler who opened it, or null when its reporter filed it. */
  enteredBy: IssueHandler | null;
  /** Closed to every handler but the board on its own. */
  boardOnly: boolean;
  /** Its known fault, while one is published. */
  knownFault: Omit<KnownFault, "typeName"> | null;
  /** The inspection it is a finding of, or null. */
  finding: IssueFinding | null;
  /** Since when a legal hold stands on the issue, or null. */
  legalHoldAt: string | null;
  /** The insurance damage it is marked as, or null (decision 28). */
  damageCase: IssueDamageCase | null;
  /**
   * Who pays, or null while nobody has said. Never an amount: a charge made
   * from the issue is read from the charges, by those who may read them.
   */
  costResponsibility: IssueCostResponsibility | null;
} & (
    | { reporter: Exclude<IssueReporter, { kind: "protected" }> }
    | {
        reporter: Extract<IssueReporter, { kind: "protected" }>;
        apartment: null;
      }
  );

/** An issue's damage case (skadeärende), as a handler marks and reads it. */
export interface IssueDamageCase {
  insurer: string;
  claimNumber: string;
  /** `YYYY-MM-DD`. */
  occurredOn: string;
  cause: IssueDamageCause;
}

export interface ReportIssueInput {
  typeId: string;
  apartmentId?: string | null;
  location?: string | null;
  placeId?: string | null;
  description: string;
  /**
   * The post in the feed this report is made from ("Gör felanmälan"), which
   * the server links to it in the same write. Only its author or a board seat
   * holder who may read it may name it; anybody else is refused, and a post
   * somebody already reported from is refused too.
   */
  postId?: string;
  /**
   * One's own closed issue this report follows up: what the reply field offers
   * once a reply no longer reopens it (ADR 0054).
   */
  followsIssueId?: string;
}

export interface IssueTypeInput {
  name: string;
  reporters: readonly IssueReporterGroup[];
  active?: boolean;
  sortOrder?: number;
  handledBy?: IssueHandledBy;
  defaultPriority?: IssuePriority;
  /** Null for none; absent leaves it as it is. */
  defaultAssigneePersonId?: string | null;
}

/** An issue a handler opens: for a named resident, or with no reporter. */
export interface OpenIssueInput {
  typeId: string;
  /** A residency the resident picker offered; absent for an internal issue. */
  residencyId?: string;
  location?: string;
  placeId?: string;
  description: string;
}

/**
 * One resident the picker offers a handler, keyed by residency: a name, or
 * that the name is protected. Never a person identifier.
 */
export type IssueResidentChoice =
  | { kind: "person"; residencyId: string; name: string }
  | { kind: "protected"; residencyId: string };

/**
 * One step of an issue's timeline: who did what, and when. Never a reporter's
 * name, and never text anybody wrote.
 */
export type IssueTimelineStep = {
  at: string;
  /** Null where nobody acted by hand: the type's default assigned it. */
  actor: IssueHandler | null;
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
      /** Reopened by the reporter's reply, who is never named here. */
      byReporter: boolean;
    }
  | { kind: "assigned"; assignee: IssueHandler | null; byTypeDefault: boolean }
  | { kind: "priority"; from: IssuePriority | null; to: IssuePriority | null }
  | { kind: "targetDate"; from: string | null; to: string | null }
  | { kind: "access"; boardOnly: boolean }
  | { kind: "knownFault"; published: boolean }
  | { kind: "place"; placeId: string | null }
  | {
      kind: "entry";
      /** The answer given, or null when it was withdrawn. */
      answer: IssueEntryAnswer | null;
      /** Answered by the resident; then the step has no actor. */
      byReporter: boolean;
    }
  | { kind: "finding"; findingKind: IssueFindingKind | null }
  | { kind: "redacted"; target: IssueRedactionTarget | null }
  | { kind: "legalHold"; held: boolean }
  | { kind: "damageCase"; marked: boolean; cause: IssueDamageCause | null }
  | {
      kind: "workOrder";
      delivery: "pending" | "sent" | "failed" | "unconfirmed" | null;
    }
  /**
   * The contractor answered a work order through its link (ADR 0055). No
   * actor: whoever held the link answered.
   */
  | { kind: "workOrderAnswer"; answer: "ACCEPTED" | "DECLINED" | "DONE" | null }
  | {
      kind: "costResponsibility";
      from: IssueCostResponsibility | null;
      to: IssueCostResponsibility | null;
    }
);

/** One line of the association's responsibility guide (ansvarsfördelning). */
export interface ResponsibilityGuideItem {
  /** "Golvbrunn, rensning": the board's own text, stored as written. */
  part: string;
  responsibility: MaintenanceResponsibility;
  note: string | null;
}

/**
 * The association's responsibility guide. `adoptedAt` is null while it is an
 * example the board has not said follows its bylaws, and every screen that
 * shows it then says so.
 */
export interface ResponsibilityGuide {
  adoptedAt: string | null;
  items: ResponsibilityGuideItem[];
  /** When it was last saved, or null if never: sent back with the next save. */
  version: string | null;
}

/** A move to another status, with what its meaning requires. */
export interface IssueStatusMoveInput {
  issueId: string;
  statusId: string;
  /** Required into a status that means WAITING. */
  waitingReason?: IssueWaitingReason;
  /** Required into a status that means DONE from one that does not. */
  outcome?: IssueClosingOutcome;
}

/** A change to one status of a type. */
export interface IssueStatusChangeInput {
  label: string;
  active?: boolean;
  /** Only true: a default stops being one when another takes its place. */
  isDefault?: true;
  sortOrder?: number;
}

/**
 * How long a read the report form waits for may take, body included. The form
 * is drawn when its reads have all answered, so one that never settles would
 * hold it behind the loading notice; a read that is given up comes back as the
 * same failure as one that got no answer, which the screen offers a retry for.
 */
const READ_TIMEOUT_MS = 10_000;

export function fetchReportableTypes(): Promise<
  ApiResult<ReportableIssueType[]>
> {
  return previewing(
    apiRequest<ReportableIssueType[]>("GET", "/api/issues/types", undefined, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }),
    previewedIssueTypes,
  );
}

/** The common-area places a report may name. */
/**
 * The places a reporter may name. Bounded as the place counts are, by
 * `ISSUE_PLACES_TIMEOUT_MS`: the issues screen waits for this read with the
 * others before it shows the report form, and files a report without a place
 * when it fails.
 */
export function fetchIssuePlaces(): Promise<ApiResult<IssuePlaceChoice[]>> {
  return readPlaces("/api/issues/places");
}

export function fetchOwnApartments(): Promise<ApiResult<IssueApartment[]>> {
  return apiRequest("GET", "/api/issues/apartments", undefined, {
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}

export function fetchOwnIssues(): Promise<ApiResult<OwnIssue[]>> {
  return apiRequest("GET", "/api/issues/mine", undefined, {
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}

export function reportIssue(
  input: ReportIssueInput,
): Promise<ApiResult<{ id: string }>> {
  return apiRequest("POST", "/api/issues", input);
}

export function attachIssuePhoto(
  issueId: string,
  file: File,
): Promise<ApiResult<IssuePhoto>> {
  return apiUpload(
    "POST",
    `/api/issues/${encodeURIComponent(issueId)}/photos`,
    file,
  );
}

/**
 * What the queue screen narrows a view to (decision 15): one meaning or every
 * open one, a type, a priority, and a search. The server reads the meaning,
 * never a board's label, and searches only what the reader may read.
 */
export interface IssueQueueFilter {
  meaning?: IssueMeaningFilter;
  typeId?: string;
  /** Only the issues that name this common-area place (decision 30). */
  placeId?: string;
  priority?: IssuePriority;
  /** What the handler typed; blank is no search. */
  search?: string;
}

/**
 * How many issues each view holds under one filter, counted on the server by
 * the conditions the views are read by.
 */
export type IssueQueueCounts = Record<
  "mine" | "unassigned" | "overdue" | "all",
  number
>;

/** The filter as the query string of the queue's reads. */
function queueQuery(filter: IssueQueueFilter, view?: IssueQueueView): string {
  const query = new URLSearchParams();
  if (view !== undefined) {
    query.set("view", view);
  }
  if (filter.meaning !== undefined) {
    query.set("meaning", filter.meaning);
  }
  if (filter.typeId !== undefined) {
    query.set("typeId", filter.typeId);
  }
  if (filter.placeId !== undefined) {
    query.set("placeId", filter.placeId);
  }
  if (filter.priority !== undefined) {
    query.set("priority", filter.priority);
  }
  const search = filter.search?.trim() ?? "";
  if (search !== "") {
    query.set("q", search);
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/** One view of the queue and every view's count, read at one moment. */
export interface IssueQueueSnapshot {
  issues: QueuedIssue[];
  counts: IssueQueueCounts;
}

/**
 * One view of the queue, narrowed by the filter, with how many issues each
 * view holds under the same filter. The server reads both in one transaction,
 * so a count never disagrees with the list read beside it.
 */
export function fetchIssueQueueSnapshot(
  input: { view: IssueQueueView } & IssueQueueFilter,
): Promise<ApiResult<IssueQueueSnapshot>> {
  const { view, ...filter } = input;
  return apiRequest(
    "GET",
    `/api/issue-queue/snapshot${queueQuery(filter, view)}`,
  );
}

/**
 * How many issues each view holds under the filter. The board's front page
 * asks with `meaning: "OPEN"` alone, and reads `all` as the open issues.
 */
export function fetchIssueQueueCounts(
  filter: IssueQueueFilter = {},
): Promise<ApiResult<IssueQueueCounts>> {
  return apiRequest("GET", `/api/issue-queue/counts${queueQuery(filter)}`);
}

/**
 * Every type with its statuses, as whoever handles issues moves issues by
 * them. Under issues:handle, so the property manager reads it too.
 */
export function fetchHandlerIssueTypes(): Promise<ApiResult<IssueTypeView[]>> {
  return apiRequest("GET", "/api/issue-queue/types");
}

export function setIssueStatus(
  input: IssueStatusMoveInput,
): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/status`,
    {
      statusId: input.statusId,
      ...(input.waitingReason === undefined
        ? {}
        : { waitingReason: input.waitingReason }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    },
  );
}

/**
 * Every apartment, by designation, for the resident picker on an issue a
 * handler opens. Under issues:handle, so the property manager reads it too.
 */
export function fetchIssueApartments(): Promise<ApiResult<IssueApartment[]>> {
  return apiRequest("GET", "/api/issue-queue/apartments");
}

/** Who lives in one apartment today, as the picker offers them. Audited. */
export function fetchIssueResidents(
  apartmentId: string,
): Promise<ApiResult<IssueResidentChoice[]>> {
  return apiRequest(
    "GET",
    `/api/issue-queue/apartments/${encodeURIComponent(apartmentId)}/residents`,
  );
}

/** Opens an issue as a handler (decision 14). */
export function openIssue(
  input: OpenIssueInput,
): Promise<ApiResult<QueuedIssue>> {
  return apiRequest("POST", "/api/issue-queue", input);
}

/** Who the issue may be assigned to: names, and nothing else. */
export function fetchIssueHandlers(
  issueId: string,
): Promise<ApiResult<IssueHandler[]>> {
  return apiRequest(
    "GET",
    `/api/issue-queue/${encodeURIComponent(issueId)}/handlers`,
  );
}

export function fetchIssueTimeline(
  issueId: string,
): Promise<ApiResult<IssueTimelineStep[]>> {
  return apiRequest(
    "GET",
    `/api/issue-queue/${encodeURIComponent(issueId)}/timeline`,
  );
}

export function assignIssue(input: {
  issueId: string;
  assigneePersonId: string | null;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/assignee`,
    { assigneePersonId: input.assigneePersonId },
  );
}

export function setIssuePriority(input: {
  issueId: string;
  priority: IssuePriority;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/priority`,
    { priority: input.priority },
  );
}

export function setIssueTargetDate(input: {
  issueId: string;
  targetDate: string | null;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/target-date`,
    { targetDate: input.targetDate },
  );
}

/** Merges the issue into another as its duplicate (decision 22). */
export function mergeIssue(input: {
  issueId: string;
  intoIssueId: string;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/merge`,
    { intoIssueId: input.intoIssueId },
  );
}

/** The issues this one is merged into, merged from, follows or is followed by. */
export function fetchIssueLinks(
  issueId: string,
): Promise<ApiResult<IssueLinks>> {
  return apiRequest(
    "GET",
    `/api/issue-queue/${encodeURIComponent(issueId)}/links`,
    undefined,
    { signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
  );
}

/** Publishes or rewrites the issue's known fault. */
export function publishKnownFault(input: {
  issueId: string;
  body: string;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "PUT",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/known-fault`,
    { body: input.body },
  );
}

/** Withdraws the issue's known fault. */
export function withdrawKnownFault(
  issueId: string,
): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "DELETE",
    `/api/issue-queue/${encodeURIComponent(issueId)}/known-fault`,
  );
}

/** The known faults the house is told of, for the report form. */
export function fetchKnownFaults(): Promise<ApiResult<KnownFault[]>> {
  // Bounded, body included, for the reason the responsibility guide's read is:
  // the report form waits for this with its other reads.
  return apiRequest("GET", "/api/issues/known-faults", undefined, {
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}

/**
 * Writes to the reporters of every issue merged into this one, one message on
 * each duplicate's own conversation.
 */
export function sendToDuplicateReporters(input: {
  issueId: string;
  body: string;
}): Promise<ApiResult<{ sent: number; skipped: number }>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/duplicate-messages`,
    { body: input.body },
  );
}

/** Who pays for the issue, or null to say nothing again. Never an amount. */
export function setIssueCostResponsibility(input: {
  issueId: string;
  costResponsibility: IssueCostResponsibility | null;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/cost-responsibility`,
    { costResponsibility: input.costResponsibility },
  );
}

/**
 * The responsibility guide as a handler reads it when deciding who pays:
 * adopted or not. Under issues:handle, so the property manager reads it too.
 */
export function fetchHandlerResponsibilityGuide(): Promise<
  ApiResult<ResponsibilityGuide>
> {
  return apiRequest("GET", "/api/issue-queue/responsibility-guide");
}

/**
 * The guide a reporter is shown before filing: the adopted one, or null while
 * it is an example. The server decides which, not this form.
 */
export function fetchReporterResponsibilityGuide(): Promise<
  ApiResult<{ guide: ResponsibilityGuide | null }>
> {
  /*
   * Bounded, body included: the screen waits for this read with the others
   * before it shows the report form, and a form is filed without the guide
   * when it fails. A timeout on the answer alone would leave a stalled body
   * unbounded.
   */
  return apiRequest("GET", "/api/issues/responsibility-guide", undefined, {
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}

/** The guide as the board configures it. Under issues:configure. */
export function fetchResponsibilityGuide(): Promise<
  ApiResult<ResponsibilityGuide>
> {
  return apiRequest("GET", "/api/responsibility-guide");
}

/**
 * Replaces the whole guide, and adopts it or withdraws the adoption. `version`
 * is the one the editor read: a save made from an older one is refused.
 */
export function saveResponsibilityGuide(input: {
  items: readonly ResponsibilityGuideItem[];
  adopted: boolean;
  version: string | null;
}): Promise<ApiResult<ResponsibilityGuide>> {
  return apiRequest("PUT", "/api/responsibility-guide", input);
}

/** Closes the issue to all but the board, or opens it again. */
export function setIssueBoardOnly(input: {
  issueId: string;
  boardOnly: boolean;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/access`,
    { boardOnly: input.boardOnly },
  );
}

/** Answers the entry question on one's own report. */
export function answerOwnEntry(input: {
  issueId: string;
  entry: IssueEntryInput;
}): Promise<ApiResult<{ entry: IssueEntry | null }>> {
  return apiRequest(
    "PUT",
    `/api/issues/${encodeURIComponent(input.issueId)}/entry-permission`,
    input.entry,
  );
}

export function withdrawOwnEntry(
  issueId: string,
): Promise<ApiResult<{ entry: IssueEntry | null }>> {
  return apiRequest(
    "DELETE",
    `/api/issues/${encodeURIComponent(issueId)}/entry-permission`,
  );
}

/**
 * How long a screen waits for the whole of a places read, body included. The
 * issues screen reads the places with the reporter's lists, and the queue reads
 * the place counts with the issues, and neither draws until all are in, so a
 * server that never answers, or stops halfway through the answer, would leave
 * it loading with no retry; past this the read comes back as a failed one and
 * the screen goes on without places. The whole read is bounded, not only the
 * wait for the headers as `answerTimeoutMs` would: the answer is a short list,
 * so one still arriving after this is one that has stalled.
 */
export const ISSUE_PLACES_TIMEOUT_MS = 10_000;

/** A GET of a places list under `ISSUE_PLACES_TIMEOUT_MS`. */
async function readPlaces<T>(path: string): Promise<ApiResult<T>> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, ISSUE_PLACES_TIMEOUT_MS);
  try {
    return await apiRequest("GET", path, undefined, {
      signal: deadline.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The places with how many issues this handler may open name each. */
export function fetchIssuePlaceCounts(): Promise<ApiResult<IssuePlaceCount[]>> {
  return readPlaces("/api/issue-queue/places");
}

export function setIssuePlace(input: {
  issueId: string;
  placeId: string | null;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "PUT",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/place`,
    { placeId: input.placeId },
  );
}

/** A handler records the resident's answer to the entry question. */
export function answerEntry(input: {
  issueId: string;
  entry: IssueEntryInput;
}): Promise<ApiResult<{ entry: IssueEntry | null }>> {
  return apiRequest(
    "PUT",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/entry-permission`,
    input.entry,
  );
}

export function withdrawEntry(
  issueId: string,
): Promise<ApiResult<{ entry: IssueEntry | null }>> {
  return apiRequest(
    "DELETE",
    `/api/issue-queue/${encodeURIComponent(issueId)}/entry-permission`,
  );
}

export function markIssueFinding(input: {
  issueId: string;
  finding: IssueFindingInput;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "PUT",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/finding`,
    input.finding,
  );
}

export function removeIssueFinding(
  issueId: string,
): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "DELETE",
    `/api/issue-queue/${encodeURIComponent(issueId)}/finding`,
  );
}

/** The places, as the board edits them. */
export function fetchConfiguredPlaces(): Promise<
  ApiResult<ConfiguredIssuePlace[]>
> {
  return apiRequest("GET", "/api/issue-places");
}

export function createIssuePlace(
  input: IssuePlaceInput,
): Promise<ApiResult<ConfiguredIssuePlace>> {
  return apiRequest("POST", "/api/issue-places", input);
}

export function updateIssuePlace(input: {
  id: string;
  values: IssuePlaceInput;
}): Promise<ApiResult<ConfiguredIssuePlace>> {
  return apiRequest(
    "PUT",
    `/api/issue-places/${encodeURIComponent(input.id)}`,
    input.values,
  );
}

export function removeIssuePlace(id: string): Promise<ApiResult<undefined>> {
  return apiRequest("DELETE", `/api/issue-places/${encodeURIComponent(id)}`);
}

/**
 * What a handler redacts (ADR 0057): the description or the location, or a
 * message, a note, a photograph or a handler's file by its identifier. A
 * redaction takes no replacement text.
 */
export type IssueRedaction =
  | { target: Extract<IssueRedactionTarget, "description" | "location"> }
  | {
      target: Exclude<IssueRedactionTarget, "description" | "location">;
      id: string;
    };

/** Empties a text, or removes a file from storage. It cannot be undone. */
export function redactIssue(input: {
  issueId: string;
  redaction: IssueRedaction;
}): Promise<ApiResult<undefined>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/redactions`,
    input.redaction,
  );
}

/** Places or releases the legal hold on an issue. */
export function setIssueLegalHold(input: {
  issueId: string;
  held: boolean;
}): Promise<ApiResult<{ legalHoldAt: string | null }>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/legal-hold`,
    { held: input.held },
  );
}

/**
 * Marks an issue as a damage case, or changes the mark. The first mark places
 * a legal hold on the issue. `replaces` is the mark the change was made from,
 * `null` for none: the API refuses the change when the mark is another by
 * then, rather than write over it.
 */
export function markIssueDamageCase(input: {
  issueId: string;
  damageCase: IssueDamageCase;
  replaces: IssueDamageCase | null;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "PUT",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/damage-case`,
    { ...input.damageCase, replaces: input.replaces },
  );
}

/**
 * Takes the damage-case mark off. The legal hold it placed stays. `replaces`
 * is the mark taken off: the API refuses the removal when the mark is another
 * by then, rather than delete one nobody saw.
 */
export function removeIssueDamageCase(input: {
  issueId: string;
  replaces: IssueDamageCase;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "DELETE",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/damage-case`,
    { replaces: input.replaces },
  );
}

/** How many years after closing an issue's free text is kept. */
export function fetchIssueRetention(): Promise<ApiResult<{ years: number }>> {
  return apiRequest("GET", "/api/issue-retention");
}

export function saveIssueRetention(input: {
  years: number;
}): Promise<ApiResult<{ years: number }>> {
  return apiRequest("PUT", "/api/issue-retention", input);
}

export function fetchIssueTypes(): Promise<ApiResult<ConfiguredIssueType[]>> {
  return apiRequest("GET", "/api/issue-types");
}

/** Who a type's issues may be given to by default. */
export function fetchIssueTypeHandlers(): Promise<
  ApiResult<IssueHandlerChoice[]>
> {
  return apiRequest("GET", "/api/issue-types/handlers");
}

export function createIssueType(
  input: IssueTypeInput,
): Promise<ApiResult<ConfiguredIssueType>> {
  return apiRequest("POST", "/api/issue-types", input);
}

export function updateIssueType(input: {
  id: string;
  values: IssueTypeInput;
}): Promise<ApiResult<ConfiguredIssueType>> {
  return apiRequest(
    "PUT",
    `/api/issue-types/${encodeURIComponent(input.id)}`,
    input.values,
  );
}

/**
 * Ring-fences a type, or lifts its ring-fence from a type nobody has reported
 * under.
 */
export function setIssueTypeRingFence(input: {
  id: string;
  ringFenced: boolean;
}): Promise<ApiResult<ConfiguredIssueType>> {
  return apiRequest(
    "PUT",
    `/api/issue-types/${encodeURIComponent(input.id)}/ring-fence`,
    { ringFenced: input.ringFenced },
  );
}

export function removeIssueType(id: string): Promise<ApiResult<undefined>> {
  return apiRequest("DELETE", `/api/issue-types/${encodeURIComponent(id)}`);
}

/** Adds a status to a type, under one of the four meanings. */
export function addIssueStatus(input: {
  typeId: string;
  meaning: IssueStatusMeaning;
  label: string;
}): Promise<ApiResult<ConfiguredIssueType>> {
  return apiRequest(
    "POST",
    `/api/issue-types/${encodeURIComponent(input.typeId)}/statuses`,
    { meaning: input.meaning, label: input.label },
  );
}

/**
 * Renames a status, switches it on or off, or makes it the default of its
 * meaning. There is no removal: a status is switched off.
 */
export function changeIssueStatus(input: {
  typeId: string;
  statusId: string;
  values: IssueStatusChangeInput;
}): Promise<ApiResult<ConfiguredIssueType>> {
  return apiRequest(
    "PUT",
    `/api/issue-types/${encodeURIComponent(input.typeId)}/statuses/${encodeURIComponent(input.statusId)}`,
    input.values,
  );
}

export function saveIssueReporting(input: {
  publicFormEnabled: boolean;
}): Promise<ApiResult<{ publicFormEnabled: boolean }>> {
  return apiRequest("PUT", "/api/settings/issue-reporting", input);
}

/**
 * An issue message as its reporter reads it: a handler's signed with a role,
 * the board or the property manager, and never with a name (decision 19).
 */
export type OwnIssueMessage = {
  id: string;
  /** Empty once a handler redacted it. */
  body: string;
  redactedAt: string | null;
  createdAt: string;
} & ({ side: "REPORTER" } | { side: "HANDLER"; signature: IssueSignature });

/**
 * An issue message as a handler reads it: a handler's with its role and who
 * wrote it, the reporter's with no author - the queue row names the reporter,
 * masked as a reporter is.
 */
export type IssueMessage = {
  id: string;
  /** Empty once a handler redacted it. */
  body: string;
  redactedAt: string | null;
  createdAt: string;
} & (
  | { side: "REPORTER" }
  | { side: "HANDLER"; signature: IssueSignature; author: IssueHandler }
);

/** An internal note, which the reporter never reads. */
export interface IssueNote {
  id: string;
  author: IssueHandler;
  /** Empty once a handler redacted it. */
  body: string;
  redactedAt: string | null;
  createdAt: string;
}

/** A file the handlers attached to an issue for each other. */
export interface IssueAttachment {
  id: string;
  url: string;
  fileName: string;
  contentType: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/** A saved reply a handler starts a message from (decision 17). */
export interface IssueSavedReply {
  id: string;
  title: string;
  body: string;
  sortOrder: number;
}

export interface IssueSavedReplyInput {
  title: string;
  body: string;
  sortOrder?: number;
}

/** The conversation on one's own issue. */
export function fetchOwnIssueMessages(
  issueId: string,
): Promise<ApiResult<OwnIssueMessage[]>> {
  return apiRequest(
    "GET",
    `/api/issues/${encodeURIComponent(issueId)}/messages`,
  );
}

export function sendOwnIssueMessage(input: {
  issueId: string;
  body: string;
}): Promise<ApiResult<OwnIssueMessage>> {
  return apiRequest(
    "POST",
    `/api/issues/${encodeURIComponent(input.issueId)}/messages`,
    { body: input.body },
  );
}

/** The conversation with the reporter, as a handler reads it. */
export function fetchIssueMessages(
  issueId: string,
): Promise<ApiResult<IssueMessage[]>> {
  return apiRequest(
    "GET",
    `/api/issue-queue/${encodeURIComponent(issueId)}/messages`,
  );
}

export function sendIssueMessage(input: {
  issueId: string;
  body: string;
}): Promise<ApiResult<IssueMessage>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/messages`,
    { body: input.body },
  );
}

/**
 * Withdraws the private link mailed to an issue's reporter (ADR 0055). It opens
 * nothing from the next request on; nobody is mailed.
 */
export function revokeIssueReporterLink(
  issueId: string,
): Promise<ApiResult<void>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(issueId)}/reporter-link/revoke`,
  );
}

export function fetchIssueNotes(
  issueId: string,
): Promise<ApiResult<IssueNote[]>> {
  return apiRequest(
    "GET",
    `/api/issue-queue/${encodeURIComponent(issueId)}/notes`,
  );
}

export function addIssueNote(input: {
  issueId: string;
  body: string;
}): Promise<ApiResult<IssueNote>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/notes`,
    { body: input.body },
  );
}

export function fetchIssueAttachments(
  issueId: string,
): Promise<ApiResult<IssueAttachment[]>> {
  return apiRequest(
    "GET",
    `/api/issue-queue/${encodeURIComponent(issueId)}/attachments`,
  );
}

export function attachIssueFile(input: {
  issueId: string;
  file: File;
}): Promise<ApiResult<IssueAttachment>> {
  return apiUpload(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/attachments`,
    input.file,
  );
}

/** The saved replies, as a handler picks one. */
export function fetchIssueSavedReplies(): Promise<
  ApiResult<IssueSavedReply[]>
> {
  return apiRequest("GET", "/api/issue-queue/saved-replies");
}

/** The saved replies, as the board edits them. */
export function fetchConfiguredSavedReplies(): Promise<
  ApiResult<IssueSavedReply[]>
> {
  return apiRequest("GET", "/api/issue-saved-replies");
}

export function createIssueSavedReply(
  input: IssueSavedReplyInput,
): Promise<ApiResult<IssueSavedReply>> {
  return apiRequest("POST", "/api/issue-saved-replies", input);
}

export function updateIssueSavedReply(input: {
  id: string;
  values: IssueSavedReplyInput;
}): Promise<ApiResult<IssueSavedReply>> {
  return apiRequest(
    "PUT",
    `/api/issue-saved-replies/${encodeURIComponent(input.id)}`,
    input.values,
  );
}

export function removeIssueSavedReply(
  id: string,
): Promise<ApiResult<undefined>> {
  return apiRequest(
    "DELETE",
    `/api/issue-saved-replies/${encodeURIComponent(id)}`,
  );
}
