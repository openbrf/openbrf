import type {
  IssueClosingOutcome,
  IssueOutcome,
  IssueReporterGroup,
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
  reportCount: number;
  /** By meaning, then in the board's order within it. */
  statuses: IssueStatusView[];
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
  description: string;
  apartment: IssueApartment | null;
  photos: IssuePhoto[];
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
  closedAt: string | null;
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

export function fetchReportableTypes(): Promise<
  ApiResult<ReportableIssueType[]>
> {
  return previewing(
    apiRequest<ReportableIssueType[]>("GET", "/api/issues/types"),
    previewedIssueTypes,
  );
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
}): Promise<ApiResult<QueuedIssue[]>> {
  const meaning = input?.meaning;
  return apiRequest(
    "GET",
    meaning === undefined
      ? "/api/issue-queue"
      : `/api/issue-queue?meaning=${encodeURIComponent(meaning)}`,
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

export function fetchIssueTypes(): Promise<ApiResult<IssueTypeView[]>> {
  return apiRequest("GET", "/api/issue-types");
}

export function createIssueType(
  input: IssueTypeInput,
): Promise<ApiResult<IssueTypeView>> {
  return apiRequest("POST", "/api/issue-types", input);
}

export function updateIssueType(input: {
  id: string;
  values: IssueTypeInput;
}): Promise<ApiResult<IssueTypeView>> {
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
}): Promise<ApiResult<IssueTypeView>> {
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
}): Promise<ApiResult<IssueTypeView>> {
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
