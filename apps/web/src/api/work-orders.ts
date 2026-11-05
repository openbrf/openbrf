import { apiRequest, type ApiResult } from "./client";
import type { IssueHandler } from "./issues";

/**
 * The contractor register and the work orders handlers send from an issue.
 *
 * These types mirror the API's wire shapes rather than importing them, for the
 * reason `issues.ts` gives.
 */

/** A contractor as the board's register shows them. */
export interface Contractor {
  id: string;
  name: string;
  trade: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  workOrderCount: number;
}

/** A contractor a handler may choose for a work order. */
export type ContractorChoice = Omit<Contractor, "active" | "workOrderCount">;

export interface ContractorInput {
  name: string;
  trade: string;
  phone: string | null;
  email: string | null;
  active?: boolean;
}

/** Why a work order's mail did not go out, as the API's codes. */
export type WorkOrderDeliveryFailure =
  | "mail-not-configured"
  | "send-failed"
  | "sending-interrupted"
  | "delivery-unconfirmed"
  | "recipient-removed"
  | "recipient-unreadable"
  | "text-erased"
  | "ring-fenced";

/** What the contractor answered a work order through its link (ADR 0055). */
export type WorkOrderAnswer = "ACCEPTED" | "DECLINED" | "DONE";

/** A note a contractor wrote through a work order's link. */
export interface WorkOrderNote {
  id: string;
  /** Empty once a handler redacted it. */
  body: string;
  redactedAt: string | null;
  createdAt: string;
}

/** A photograph a contractor added through a work order's link. */
export interface WorkOrderFile {
  id: string;
  url: string;
  fileName: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/**
 * What the record shows of a work order's link (ADR 0055): where the link
 * stands, and what came through it. Listed whether or not the switch is on, so
 * what a contractor sent stays on the record after it is turned off. The
 * link's address is never here: it is shown once, when it is issued.
 */
export interface WorkOrderLinkRecord {
  link: { state: "live" | "ended" | "none"; expiresAt: string | null };
  answer: WorkOrderAnswer | null;
  answeredAt: string | null;
  /** The issue's photographs the link shows, by file. */
  chosenFileIds: string[];
  notes: WorkOrderNote[];
  files: WorkOrderFile[];
}

/** One of the issue's photographs a handler may choose for a link. */
export interface ChoosablePhoto {
  fileId: string;
  url: string;
  fileName: string;
  /** The reporter's photograph, or an image a handler attached. */
  source: "report" | "handler";
}

/** A link as issued: shown to the handler this once, and never read again. */
export interface IssuedWorkOrderLink {
  url: string;
  expiresAt: string;
}

/** One work order on an issue: whom, when, what, and whether it went out. */
export interface WorkOrder {
  id: string;
  contractorId: string | null;
  /** Null once the contractor was removed from the list, and erased with it. */
  recipientName: string | null;
  recipientEmail: string | null;
  /**
   * Null once the retention period after the issue was closed ran out, or
   * once a handler redacted it.
   */
  body: string | null;
  /** When a handler redacted the text, or null (ADR 0057). */
  redactedAt: string | null;
  sentBy: IssueHandler | null;
  sentAt: string;
  deliveryStatus: "PENDING" | "SENT" | "FAILED";
  deliveryFailure: WorkOrderDeliveryFailure | null;
  contractorLink: WorkOrderLinkRecord;
}

export interface IssueWorkOrders {
  /** Nothing about the issue may reach a contractor; no work order is offered. */
  ringFenced: boolean;
  /** The issue is done; no work order is offered until it is reopened. */
  closed: boolean;
  /**
   * Whether contractors' links are switched on for this instance. Off, no link
   * and no choice of photographs is offered, only the withdrawal of a link
   * still `live`: it opens nothing while the switch is off, and would again
   * if it were turned on before the link's end.
   */
  linksEnabled: boolean;
  /** Empty while the switch is off or the issue is ring-fenced. */
  choosablePhotos: ChoosablePhoto[];
  /**
   * Somebody the issue concerns, its reporter or a resident of its apartment,
   * has protected personal data: no link is given, and any given before is
   * ended.
   */
  protectedHousehold: boolean;
  workOrders: WorkOrder[];
}

/** One work order on one issue, as the link's calls name it. */
export interface WorkOrderRef {
  issueId: string;
  workOrderId: string;
}

/** The mail a work order would be, before it is sent. */
export interface WorkOrderPreview {
  recipient: { name: string; email: string };
  subject: string;
  text: string;
  mailConfigured: boolean;
  /** What the sending carries, so the API sends only what was previewed. */
  previewToken: string;
}

export interface WorkOrderInput {
  issueId: string;
  contractorId: string;
  body: string;
}

function workOrdersPath(issueId: string): string {
  return `/api/issue-queue/${encodeURIComponent(issueId)}/work-orders`;
}

export function fetchContractorChoices(): Promise<
  ApiResult<ContractorChoice[]>
> {
  return apiRequest("GET", "/api/issue-queue/contractors");
}

export function fetchIssueWorkOrders(
  issueId: string,
): Promise<ApiResult<IssueWorkOrders>> {
  return apiRequest("GET", workOrdersPath(issueId));
}

export function previewWorkOrder(
  input: WorkOrderInput,
): Promise<ApiResult<WorkOrderPreview>> {
  return apiRequest("POST", `${workOrdersPath(input.issueId)}/preview`, {
    contractorId: input.contractorId,
    body: input.body,
  });
}

export function sendWorkOrder(
  input: WorkOrderInput & { previewToken: string },
): Promise<ApiResult<WorkOrder>> {
  return apiRequest("POST", workOrdersPath(input.issueId), {
    contractorId: input.contractorId,
    body: input.body,
    previewToken: input.previewToken,
  });
}

function workOrderPath(ref: WorkOrderRef): string {
  return `${workOrdersPath(ref.issueId)}/${encodeURIComponent(ref.workOrderId)}`;
}

/**
 * Gives the contractor a link to the work order, replacing any link before it.
 * The answer is the only time the address is shown.
 */
export function issueWorkOrderLink(
  ref: WorkOrderRef,
): Promise<ApiResult<IssuedWorkOrderLink>> {
  return apiRequest("POST", `${workOrderPath(ref)}/link`);
}

/** Withdraws the work order's link, if it has a live one. */
export function revokeWorkOrderLink(
  ref: WorkOrderRef,
): Promise<ApiResult<undefined>> {
  return apiRequest("DELETE", `${workOrderPath(ref)}/link`);
}

/** Replaces the whole choice of photographs the work order's link shows. */
export function chooseWorkOrderPhotos(
  input: WorkOrderRef & { fileIds: readonly string[] },
): Promise<ApiResult<undefined>> {
  return apiRequest("PUT", `${workOrderPath(input)}/photos`, {
    fileIds: input.fileIds,
  });
}

export function fetchContractors(): Promise<ApiResult<Contractor[]>> {
  return apiRequest("GET", "/api/contractors");
}

export function createContractor(
  input: ContractorInput,
): Promise<ApiResult<Contractor>> {
  return apiRequest("POST", "/api/contractors", input);
}

export function updateContractor(input: {
  id: string;
  values: ContractorInput;
}): Promise<ApiResult<Contractor>> {
  return apiRequest(
    "PUT",
    `/api/contractors/${encodeURIComponent(input.id)}`,
    input.values,
  );
}

export function removeContractor(id: string): Promise<ApiResult<undefined>> {
  return apiRequest("DELETE", `/api/contractors/${encodeURIComponent(id)}`);
}
