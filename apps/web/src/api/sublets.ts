import { apiRequest, type ApiResult } from "./client";

/**
 * The subletting endpoints (andrahandsupplatelse).
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * Two properties of the contract are load-bearing and invisible in the types.
 *
 * Asking for the board's consent is the bostadsrattshavare's act under BRL
 * 7 kap. 10 § and not a resident's, so `sublets:apply` is derived from
 * membership on the server - and the server asks the register again about the
 * apartment named in the request, because an administrator holds every
 * capability and no tenant-ownership. A screen that hid the form would be a
 * courtesy; the refusal is the rule.
 *
 * The rent tribunal's permission is recorded and never derived. BRL 7 kap. 11 §
 * lets the member let anyway if the hyresnamnden permits after a refusal, and
 * the platform cannot know what it decided - so the row carries the board's
 * refusal and the permission side by side, and nothing recomputes a consent from
 * one.
 */

export type SubletApplicationStatus =
  "SUBMITTED" | "CONSENTED" | "REFUSED" | "WITHDRAWN";

/** An apartment as the applicant and the board are told which one it is. */
export interface SubletApartment {
  id: string;
  number: string;
  /** "Storgatan 12", so a household with two entrances can tell them apart. */
  address: string;
}

/** What the rent tribunal permitted after the board refused. */
export interface SubletTribunalPermission {
  /** "YYYY-MM-DD". */
  permittedOn: string;
  /**
   * "YYYY-MM-DD", or null where the recorded decision named no end.
   *
   * BRL 7 kap. 11 § requires one, so an absent end is a gap in what was recorded
   * rather than a permission without a limit - which is why the screen states it
   * as absent instead of inventing a date.
   */
  permittedUntil: string | null;
}

/** An application as the member who made it reads it back. */
export interface OwnSubletApplication {
  id: string;
  /** Null where the apartment has since been corrected out of the register. */
  apartment: SubletApartment | null;
  /** "YYYY-MM-DD". */
  periodFrom: string;
  /** "YYYY-MM-DD", inclusive. */
  periodTo: string;
  reason: string;
  status: SubletApplicationStatus;
  submittedAt: string;
  closedAt: string | null;
  decisionNote: string | null;
  tribunalPermission: SubletTribunalPermission | null;
}

/**
 * Who applied, as the board is told.
 *
 * `protected` is a member with protected personal data, whose name the queue
 * withholds even though the board's own address book prints it. `unknown` is a
 * reference that no longer resolves to a person, which a service-tier table has
 * to be able to say rather than break.
 */
export type SubletApplicant =
  | { kind: "member"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** An application as the board reads it in the queue. */
export interface QueuedSubletApplication extends OwnSubletApplication {
  applicant: SubletApplicant;
  closedByPersonId: string | null;
}

export interface SubletIntake {
  /** The apartments this caller holds as a member, today. */
  apartments: SubletApartment[];
  applications: OwnSubletApplication[];
}

export interface SubletQueue {
  applications: QueuedSubletApplication[];
}

// --- a member's own intake ---------------------------------------------------

export function fetchSubletIntake(): Promise<ApiResult<SubletIntake>> {
  return apiRequest("GET", "/api/sublet-applications/mine");
}

export function applyForSublet(input: {
  apartmentId: string;
  periodFrom: string;
  periodTo: string;
  reason: string;
}): Promise<ApiResult<{ id: string }>> {
  return apiRequest("POST", "/api/sublet-applications", input);
}

/**
 * Changes what one's own application asks for, while it is still open.
 *
 * The period and the reason and not the apartment: an application about a
 * different flat is a different request, and the server refuses to rewrite one.
 * Every edit goes through the same personal identity number scan the first
 * submission did.
 */
export function reviseSubletApplication(input: {
  applicationId: string;
  periodFrom: string;
  periodTo: string;
  reason: string;
}): Promise<ApiResult<OwnSubletApplication>> {
  const { applicationId, ...body } = input;
  return apiRequest(
    "PUT",
    `/api/sublet-applications/${encodeURIComponent(applicationId)}`,
    body,
  );
}

export function withdrawSubletApplication(input: {
  applicationId: string;
}): Promise<ApiResult<OwnSubletApplication>> {
  return apiRequest(
    "POST",
    `/api/sublet-applications/${encodeURIComponent(input.applicationId)}/withdrawal`,
  );
}

// --- the queue the board works ----------------------------------------------

export function fetchSubletQueue(): Promise<ApiResult<SubletQueue>> {
  return apiRequest("GET", "/api/sublet-queue");
}

/**
 * Records the board's consent, or its refusal, with the date it was given.
 *
 * One call with a boolean rather than two, because BRL 7 kap. 10 § makes it one
 * decision: the board either gives its samtycke or it does not.
 */
export function decideSubletApplication(input: {
  applicationId: string;
  consent: boolean;
  note: string | null;
}): Promise<ApiResult<QueuedSubletApplication>> {
  const { applicationId, ...body } = input;
  return apiRequest(
    "POST",
    `/api/sublet-queue/${encodeURIComponent(applicationId)}/decision`,
    body,
  );
}

/**
 * Records what the rent tribunal permitted after a refusal, or clears that
 * record.
 *
 * Null clears one entered wrongly, which is the same act rather than a second
 * call. The server refuses it against anything but a refused application, which
 * is the condition BRL 7 kap. 11 § opens the route on - and recording one
 * changes no status, because the association did not consent.
 */
export function recordSubletTribunalPermission(input: {
  applicationId: string;
  permission: { permittedOn: string; permittedUntil: string | null } | null;
}): Promise<ApiResult<QueuedSubletApplication>> {
  return apiRequest(
    "PUT",
    `/api/sublet-queue/${encodeURIComponent(input.applicationId)}/tribunal-permission`,
    { permission: input.permission },
  );
}
