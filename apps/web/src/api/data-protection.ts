import type {
  DataSubjectCategory,
  PersonalDataCategory,
} from "@openbrf/shared";

import { apiRequest, type ApiResult } from "./client";

/**
 * The association's own data protection records, as the board keeps them.
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * Two base paths and two capabilities, and the split is the point. Everything
 * under `/api/data-protection` is the association's account of itself - what it
 * processes, who receives it, what went wrong - and is gated on
 * `dataProtection:manage`. What one named person asked about their own data is
 * a register decision of the same weight as a move-out, so it lives under
 * `/api/data-subject-requests` behind the address book's own gate and is
 * recorded on that person's page rather than here.
 *
 * Three properties of the contract are load-bearing and invisible in the types.
 *
 * **Every derived value arrives derived.** The 72-hour bound of GDPR art. 33(1),
 * the hours left on it, the state of a breach or a request, the month art. 12(3)
 * gives - none of these is stored, and none is recomputed here. A screen that
 * did its own arithmetic would eventually disagree with the job that acts on it.
 *
 * **"Not recorded" is the absence of a row.** A recipient the board has not
 * classified has no agreement and a state of `notRecorded`; there is no stored
 * status meaning "unanswered", because that would be a claim rather than the
 * lack of one.
 *
 * **A write answers with the row it wrote, and the screens re-read anyway** where
 * one act changes another's counts - classifying a recipient moves the overview,
 * appending headings moves the notice's coverage.
 */

export type BreachRisk = "UNLIKELY" | "LIKELY" | "HIGH";

export type BreachState = "awaitingDecision" | "overdue" | "decided" | "closed";

export interface BreachSubject {
  personId: string;
  informedAt: string | null;
}

export interface BreachView {
  breachId: string;
  title: string;
  description: string;
  occurredAt: string | null;
  discoveredAt: string;
  personalDataCategories: string[];
  dataSubjectCategories: string[];
  dataDescription: string;
  affectedCount: number | null;
  effects: string;
  measures: string;
  risk: BreachRisk | null;
  imyNotificationRequired: boolean | null;
  imyDecisionGround: string | null;
  imyNotifiedAt: string | null;
  imyReference: string | null;
  /** Required once a notification is later than the bound (art. 33(1)). */
  delayReasons: string | null;
  subjectsInformationRequired: boolean | null;
  subjectsDecisionGround: string | null;
  subjectsInformedAt: string | null;
  decidedAt: string | null;
  decidedByPersonId: string | null;
  closedAt: string | null;
  closedByPersonId: string | null;
  recordedByPersonId: string;
  /** Derived from the discovery, never stored. */
  imyNotifyBy: string;
  remindAt: string;
  hoursLeft: number;
  state: BreachState;
  subjects: BreachSubject[];
}

export interface RecordBreachInput {
  title: string;
  description: string;
  occurredAt?: string;
  discoveredAt: string;
  personalDataCategories: string[];
  dataSubjectCategories: string[];
  dataDescription: string;
  affectedCount?: number;
  effects: string;
  measures: string;
  subjectPersonIds: string[];
}

export interface DecideBreachInput {
  risk: BreachRisk;
  imyNotificationRequired: boolean;
  imyDecisionGround: string;
  imyNotifiedAt?: string | null;
  imyReference?: string | null;
  delayReasons?: string | null;
  subjectsInformationRequired: boolean;
  subjectsDecisionGround?: string | null;
}

export type LegalBasis =
  | "CONSENT"
  | "CONTRACT"
  | "LEGAL_OBLIGATION"
  | "VITAL_INTERESTS"
  | "PUBLIC_TASK"
  | "LEGITIMATE_INTEREST";

export interface ProcessingActivityView {
  activityId: string;
  name: string;
  purpose: string;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  /*
   * The shared vocabulary and not `string[]`, because the screen renders each
   * of them through a translation key: a value outside the list would be a key
   * that does not exist, and the type is what says so at build time.
   */
  dataSubjectCategories: DataSubjectCategory[];
  personalDataCategories: PersonalDataCategory[];
  recipients: string | null;
  thirdCountryTransfer: boolean;
  thirdCountrySafeguards: string | null;
  retention: string;
  securityMeasures: string | null;
  source: string;
  sourceKey: string | null;
  endedAt: string | null;
  /** True while the seed still refreshes this row's fact-derived fields. */
  seeded: boolean;
}

export interface ProcessingRecord {
  controller: {
    name: string;
    organizationNumber: string | null;
    contactEmail: string | null;
    postalAddress: string | null;
    officer: {
      name: string | null;
      email: string;
      phone: string | null;
    } | null;
    jointController: { name: string; contact: string } | null;
  };
  activities: ProcessingActivityView[];
}

export type ProcessorClassification =
  "PROCESSOR" | "NOT_A_PROCESSOR" | "INDEPENDENT_CONTROLLER";

export type ProcessorAgreementState =
  | "inPlace"
  | "pending"
  | "notAProcessor"
  | "independentController"
  | "notRecorded";

export type ProcessorKind =
  "SMTP" | "SMS" | "STORAGE" | "HOSTING" | "PLUGIN" | "EXTERNAL";

export interface ProcessorView {
  processorKey: string;
  processorKind: ProcessorKind;
  /** Null where the instance has no name for the recipient; see the panel. */
  identity: string | null;
  detail: string | null;
  /** The classification the instance's own configuration already settles. */
  seededClassification: ProcessorClassification | null;
  state: ProcessorAgreementState;
  agreement: {
    agreementId: string;
    classification: ProcessorClassification;
    status: "IN_PLACE" | "PENDING" | null;
    counterparty: string | null;
    reference: string | null;
    signedOn: string | null;
    termsConfirmed: boolean | null;
    subProcessorsAuthorised: boolean | null;
    subProcessorNote: string | null;
    note: string | null;
  } | null;
}

export interface ProcessorAgreementInput {
  classification: ProcessorClassification;
  status?: "IN_PLACE" | "PENDING" | null;
  counterparty?: string | null;
  reference?: string | null;
  signedOn?: string | null;
  termsConfirmed?: boolean | null;
  subProcessorsAuthorised?: boolean | null;
  subProcessorNote?: string | null;
  note?: string | null;
}

export type PrivacyNoticeSection =
  | "controller"
  | "dataProtectionOfficer"
  | "data"
  | "purpose"
  | "legalBasis"
  | "legitimateInterest"
  | "recipients"
  | "thirdCountryTransfers"
  | "retention"
  | "rights"
  | "withdrawConsent"
  | "provisionRequirement"
  | "automatedDecisions"
  | "complaint"
  | "contact";

export interface PrivacyNoticeCoverage {
  exists: boolean;
  published: boolean;
  sections: { section: PrivacyNoticeSection; present: boolean }[];
  controllerContactBlock: boolean;
}

export interface DataProtectionOverview {
  breaches: {
    awaitingDecision: number;
    overdue: number;
    nearestDeadline: string | null;
  };
  requests: { open: number; overdue: number };
  processors: { notRecorded: number; pending: number };
  notice: { missingHeadings: number; published: boolean };
}

export function fetchDataProtectionOverview(): Promise<
  ApiResult<DataProtectionOverview>
> {
  return apiRequest("GET", "/api/data-protection/overview");
}

export function fetchBreaches(): Promise<ApiResult<BreachView[]>> {
  return apiRequest("GET", "/api/data-protection/breaches");
}

export function recordBreach(
  input: RecordBreachInput,
): Promise<ApiResult<BreachView>> {
  return apiRequest("POST", "/api/data-protection/breaches", input);
}

export function decideBreach(
  breachId: string,
  input: DecideBreachInput,
): Promise<ApiResult<BreachView>> {
  return apiRequest(
    "POST",
    `/api/data-protection/breaches/${breachId}/decision`,
    input,
  );
}

export function addBreachSubject(
  breachId: string,
  personId: string,
): Promise<ApiResult<BreachView>> {
  return apiRequest(
    "POST",
    `/api/data-protection/breaches/${breachId}/subjects`,
    { personId },
  );
}

export function markBreachSubjectInformed(
  breachId: string,
  personId: string,
): Promise<ApiResult<BreachView>> {
  return apiRequest(
    "POST",
    `/api/data-protection/breaches/${breachId}/subjects/${personId}/informed`,
    {},
  );
}

export function closeBreach(breachId: string): Promise<ApiResult<BreachView>> {
  return apiRequest(
    "POST",
    `/api/data-protection/breaches/${breachId}/close`,
    {},
  );
}

export function fetchProcessingRecord(): Promise<ApiResult<ProcessingRecord>> {
  return apiRequest("GET", "/api/data-protection/processing-activities");
}

export function updateProcessingActivity(
  activityId: string,
  input: Partial<{
    name: string;
    purpose: string;
    legalBasis: LegalBasis;
    legalBasisNote: string | null;
    recipients: string | null;
    thirdCountryTransfer: boolean;
    thirdCountrySafeguards: string | null;
    retention: string;
    securityMeasures: string | null;
  }>,
): Promise<ApiResult<ProcessingActivityView>> {
  return apiRequest(
    "PUT",
    `/api/data-protection/processing-activities/${activityId}`,
    input,
  );
}

export function fetchProcessors(): Promise<ApiResult<ProcessorView[]>> {
  return apiRequest("GET", "/api/data-protection/processors");
}

export function recordProcessorAgreement(
  processorKey: string,
  input: ProcessorAgreementInput,
): Promise<ApiResult<ProcessorView>> {
  return apiRequest(
    "PUT",
    `/api/data-protection/processor-agreements/${processorKey}`,
    input,
  );
}

export function fetchPrivacyNoticeCoverage(): Promise<
  ApiResult<PrivacyNoticeCoverage>
> {
  return apiRequest("GET", "/api/data-protection/privacy-notice");
}

export function appendPrivacyNoticeHeadings(): Promise<
  ApiResult<PrivacyNoticeCoverage>
> {
  return apiRequest("POST", "/api/data-protection/privacy-notice/headings", {});
}

/**
 * What one person asked about their own data (GDPR art. 17, 18 and 21).
 *
 * Under the address book's own gate rather than the data protection screen's,
 * because deciding whether a named person's data is erased or stops being used
 * is a register decision of the same weight as entering a move-out. The board's
 * overview of every open request is on the data protection screen; this is what
 * changes one.
 */
export type DataSubjectRequestKind = "ERASURE" | "OBJECTION" | "RESTRICTION";

export type ErasureGround =
  | "NO_LONGER_NECESSARY"
  | "CONSENT_WITHDRAWN"
  | "OBJECTION_UPHELD"
  | "UNLAWFUL_PROCESSING"
  | "LEGAL_OBLIGATION_TO_ERASE";

export type ErasureException =
  "NONE" | "LEGAL_OBLIGATION_TO_KEEP" | "LEGAL_CLAIMS";

export interface DataSubjectRequestView {
  requestId: string;
  personId: string;
  kind: DataSubjectRequestKind;
  requestedOn: string | null;
  /** The month art. 12(3) gives, derived from the request date. */
  dueOn: string | null;
  ground: string;
  erasureGround: ErasureGround | null;
  issueId: string | null;
  decision: "GRANTED" | "REFUSED" | null;
  erasureException: ErasureException | null;
  decisionGround: string | null;
  decidedAt: string | null;
  decidedByPersonId: string | null;
  executedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  recordedByPersonId: string | null;
  state: "open" | "overdue" | "granted" | "refused" | "executed" | "closed";
}

export function fetchDataSubjectRequests(
  personId: string,
): Promise<ApiResult<DataSubjectRequestView[]>> {
  return apiRequest("GET", `/api/data-subject-requests/persons/${personId}`);
}

export function recordDataSubjectRequest(
  personId: string,
  input: {
    kind: DataSubjectRequestKind;
    requestedOn: string;
    ground: string;
    erasureGround?: ErasureGround;
    issueId?: string;
  },
): Promise<ApiResult<DataSubjectRequestView>> {
  return apiRequest(
    "POST",
    `/api/data-subject-requests/persons/${personId}`,
    input,
  );
}

export function decideDataSubjectRequest(
  requestId: string,
  input: {
    decision: "GRANTED" | "REFUSED";
    ground: string;
    erasureException?: ErasureException;
  },
): Promise<ApiResult<DataSubjectRequestView>> {
  return apiRequest(
    "POST",
    `/api/data-subject-requests/${requestId}/decision`,
    input,
  );
}

export function closeDataSubjectRequest(
  requestId: string,
  input: { reason?: string },
): Promise<ApiResult<DataSubjectRequestView>> {
  return apiRequest(
    "POST",
    `/api/data-subject-requests/${requestId}/close`,
    input,
  );
}
