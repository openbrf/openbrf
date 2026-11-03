import type {
  AuthorView,
  IssueClosingOutcome,
  IssueEntryAnswer,
  IssueFindingKind,
  IssueHandledBy,
  IssueOutcome,
  IssuePriority,
  IssueReporterGroup,
  IssueSignature,
  IssueStatusMeaning,
  IssueWaitingReason,
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
export interface OwnIssue {
  id: string;
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
  createdAt: string;
  updatedAt: string;
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
 */
export type IssueReporter =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected" }
  | { kind: "external"; name: string | null; email: string | null }
  | { kind: "unknown" };

export type QueuedIssue = OwnIssue & {
  /** The status it stands in, as the board named it for its type. */
  status: { id: string; label: string };
  waitingReason: IssueWaitingReason | null;
  /** Null while open, and on an issue closed before outcomes existed. */
  outcome: IssueOutcome | null;
  typeReporters: IssueReporterGroup[];
  typeHandledBy: IssueHandledBy;
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
  /** The inspection it is a finding of, or null. */
  finding: IssueFinding | null;
} & (
    | { reporter: Exclude<IssueReporter, { kind: "protected" }> }
    | {
        reporter: Extract<IssueReporter, { kind: "protected" }>;
        apartment: null;
      }
  );

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
    }
  | { kind: "assigned"; assignee: IssueHandler | null; byTypeDefault: boolean }
  | { kind: "priority"; from: IssuePriority | null; to: IssuePriority | null }
  | { kind: "targetDate"; from: string | null; to: string | null }
  | { kind: "access"; boardOnly: boolean }
  | { kind: "place"; placeId: string | null }
  | {
      kind: "entry";
      /** The answer given, or null when it was withdrawn. */
      answer: IssueEntryAnswer | null;
      /** Answered by the resident; then the step has no actor. */
      byReporter: boolean;
    }
  | { kind: "finding"; findingKind: IssueFindingKind | null }
);

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

export function fetchReportableTypes(): Promise<
  ApiResult<ReportableIssueType[]>
> {
  return previewing(
    apiRequest<ReportableIssueType[]>("GET", "/api/issues/types"),
    previewedIssueTypes,
  );
}

/** The common-area places a report may name. */
export function fetchIssuePlaces(): Promise<ApiResult<IssuePlaceChoice[]>> {
  return apiRequest("GET", "/api/issues/places");
}

export function fetchOwnApartments(): Promise<ApiResult<IssueApartment[]>> {
  return apiRequest("GET", "/api/issues/apartments");
}

export function fetchOwnIssues(): Promise<ApiResult<OwnIssue[]>> {
  return apiRequest("GET", "/api/issues/mine");
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
 * The queue, or the part of it whose status has one meaning.
 *
 * `meaning` absent reads the whole queue, which is what the queue screen works
 * from. The overview asks for one meaning only, to count what is waiting
 * without carrying every report the association ever had.
 */
export function fetchIssueQueue(input?: {
  meaning?: IssueStatusMeaning;
  /** Only the issues that name this common-area place (decision 30). */
  placeId?: string;
}): Promise<ApiResult<QueuedIssue[]>> {
  const query = new URLSearchParams();
  if (input?.meaning !== undefined) {
    query.set("meaning", input.meaning);
  }
  if (input?.placeId !== undefined) {
    query.set("placeId", input.placeId);
  }
  const search = query.toString();
  return apiRequest(
    "GET",
    search === "" ? "/api/issue-queue" : `/api/issue-queue?${search}`,
  );
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

/** The places with how many issues this handler may open name each. */
export function fetchIssuePlaceCounts(): Promise<ApiResult<IssuePlaceCount[]>> {
  return apiRequest("GET", "/api/issue-queue/places");
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
  body: string;
  createdAt: string;
} & ({ side: "REPORTER" } | { side: "HANDLER"; signature: IssueSignature });

/**
 * An issue message as a handler reads it: a handler's with its role and who
 * wrote it, the reporter's with no author - the queue row names the reporter,
 * masked as a reporter is.
 */
export type IssueMessage = {
  id: string;
  body: string;
  createdAt: string;
} & (
  | { side: "REPORTER" }
  | { side: "HANDLER"; signature: IssueSignature; author: IssueHandler }
);

/** An internal note, which the reporter never reads. */
export interface IssueNote {
  id: string;
  author: IssueHandler;
  body: string;
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
