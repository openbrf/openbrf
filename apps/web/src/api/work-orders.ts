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
  | "text-erased";

/** One work order on an issue: whom, when, what, and whether it went out. */
export interface WorkOrder {
  id: string;
  contractorId: string | null;
  /** Null once the contractor was removed from the list, and erased with it. */
  recipientName: string | null;
  recipientEmail: string | null;
  /** Null once the retention period after the issue was closed ran out. */
  body: string | null;
  sentBy: IssueHandler | null;
  sentAt: string;
  deliveryStatus: "PENDING" | "SENT" | "FAILED";
  deliveryFailure: WorkOrderDeliveryFailure | null;
}

export interface IssueWorkOrders {
  /** Nothing about the issue may reach a contractor; no work order is offered. */
  ringFenced: boolean;
  workOrders: WorkOrder[];
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
