import { apiRequest, apiUpload, type ApiResult } from "./client";

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
 * out of a resident's reach.
 */

export type IssueAudience = "NON_MEMBER" | "MEMBER" | "BOARD";

export type IssueStatus = "NEW" | "IN_PROGRESS" | "DONE";

export const ISSUE_AUDIENCES: readonly IssueAudience[] = [
  "NON_MEMBER",
  "MEMBER",
  "BOARD",
];

/** A type as the board configures it. */
export interface IssueTypeView {
  id: string;
  name: string;
  audience: IssueAudience;
  active: boolean;
  sortOrder: number;
  reportCount: number;
}

/** A type as this account is offered it. */
export interface ReportableIssueType {
  id: string;
  name: string;
  audience: IssueAudience;
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

export interface OwnIssue {
  id: string;
  status: IssueStatus;
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
 * in this view, which an external property manager reads. `unknown` is a
 * reporter the register no longer holds - issue data outlives nobody, and the
 * queue says so rather than inventing a name.
 */
export type IssueReporter =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "external"; name: string | null; email: string | null }
  | { kind: "unknown" };

export interface QueuedIssue extends OwnIssue {
  audience: IssueAudience;
  reporter: IssueReporter;
}

export interface ReportIssueInput {
  typeId: string;
  apartmentId?: string | null;
  location?: string | null;
  description: string;
}

export interface IssueTypeInput {
  name: string;
  audience: IssueAudience;
  active?: boolean;
  sortOrder?: number;
}

export function fetchReportableTypes(): Promise<
  ApiResult<ReportableIssueType[]>
> {
  return apiRequest("GET", "/api/issues/types");
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

export function fetchIssueQueue(): Promise<ApiResult<QueuedIssue[]>> {
  return apiRequest("GET", "/api/issue-queue");
}

export function setIssueStatus(input: {
  issueId: string;
  status: IssueStatus;
}): Promise<ApiResult<QueuedIssue>> {
  return apiRequest(
    "POST",
    `/api/issue-queue/${encodeURIComponent(input.issueId)}/status`,
    { status: input.status },
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

export function saveIssueReporting(input: {
  publicFormEnabled: boolean;
}): Promise<ApiResult<{ publicFormEnabled: boolean }>> {
  return apiRequest("PUT", "/api/settings/issue-reporting", input);
}
