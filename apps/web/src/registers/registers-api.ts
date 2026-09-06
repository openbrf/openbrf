import { apiRequest, type ApiResult } from "../api/client";

/**
 * The two statutory registers, as the browser sees them.
 *
 * Two sets of types and two sets of functions, with nothing shared between
 * them. That is the point: the member register extract is public on request and
 * never carries a personal identity number, while the apartment register is
 * confidential and carries one by statute. A shared type would be one place
 * where the wrong field could reach the wrong document.
 *
 * These mirror `apps/api/src/registers/*.service.ts`. They are declared here
 * rather than imported from a shared package for the same reason the address
 * book's are: neither app depends on `@openbrf/shared` yet.
 */

export interface RegisterHousingCooperative {
  name: string;
  organizationNumber: string | null;
}

// --- The member register (medlemsforteckning, EFL 5 kap.) -------------------

export type MemberRegisterScope = "current" | "all";

export type RegisterPostalAddress =
  | {
      state: "visible";
      street: string | null;
      postalCode: string | null;
      city: string | null;
    }
  | { state: "masked"; alternativePostalAddress: string | null };

export interface MemberRegisterApartment {
  id: string;
  number: string;
  addressLabel: string;
}

export interface MemberRegisterRow {
  key: string;
  personId: string;
  name: string;
  postalAddress: RegisterPostalAddress;
  protectedPersonalData: boolean;
  enteredOn: string | null;
  exitedOn: string | null;
  apartments: MemberRegisterApartment[];
}

export interface MemberRegisterExtract {
  housingCooperative: RegisterHousingCooperative;
  scope: MemberRegisterScope;
  generatedOn: string;
  rows: MemberRegisterRow[];
}

export function fetchMemberRegister(
  scope: MemberRegisterScope,
): Promise<ApiResult<MemberRegisterExtract>> {
  return apiRequest(
    "GET",
    `/api/member-register?scope=${encodeURIComponent(scope)}`,
  );
}

// --- The apartment register (lagenhetsforteckning, BRL 9 kap.) --------------

export type RegisterIdentityNumber =
  | { state: "masked"; hasValue: boolean }
  | { state: "visible"; value: string | null };

export interface ApartmentRegisterHolder {
  personId: string;
  name: string;
  protectedPersonalData: boolean;
  personalIdentityNumber: RegisterIdentityNumber;
  heldFrom: string;
  heldUntil: string | null;
}

export interface ApartmentRegisterLien {
  id: string;
  creditor: string;
  notedOn: string;
  releasedOn: string | null;
  amount: string | null;
}

export interface ApartmentRegisterTransfer {
  id: string;
  transferredOn: string;
  /**
   * The day the association decided on the acquirer's membership, or null.
   *
   * The day the cooperative housing register's two-week reporting window opens
   * for this transfer (Lag (2026:484) 3 kap. 3 §). Null means no such decision
   * was recorded - which the statute provides for, since a transfer to a
   * sitting member has none - so the screen offers to record one and never
   * asserts that a deadline has been missed.
   */
  membershipDecidedOn: string | null;
  /**
   * An upplatelse (BRL 4 kap.) or an overgang (6 kap.), and null on a row the
   * register recorded before it said which.
   *
   * Mirrors `ApartmentRegisterTransfer` on the server. The screen needs it
   * because a missing seller means one thing on a grant and another on a
   * transfer, and because only an overgang has a membership decision to record.
   */
  kind: "GRANT" | "TRANSFER" | null;
  /**
   * Which case of Lag (2026:484) 3 kap. 3 § this overgang falls in, and null
   * where the board has not stated it.
   *
   * What separates the two meanings a null `membershipDecidedOn` carries: a
   * decision the board has not minuted yet, and a case that has none to minute.
   * The screen needs both, because one of them is offered a date field and the
   * other must not be.
   */
  reportBasis: TransferReportBasis | null;
  fromName: string | null;
  toName: string;
  price: string | null;
  agreementReference: string | null;
}

/**
 * Which case of Lag (2026:484) 3 kap. 3 § an overgang falls in.
 *
 * Mirrors the TransferReportBasis enum in `apps/api/prisma/schema.prisma`. The
 * ordinary case runs its two weeks from the day the association decided on
 * membership; the next three run from the overgang itself, because there is no
 * decision to take; and the last is not the association's report at all - forsta
 * stycket assigns it to the juridical person that acquired the bostadsratt.
 */
export type TransferReportBasis =
  | "MEMBERSHIP_DECISION"
  | "ALREADY_MEMBER"
  | "OUTSIDE_MEMBERSHIP_REQUIREMENT"
  | "TO_THE_ASSOCIATION"
  | "LIENHOLDING_JURIDICAL_PERSON";

/**
 * Which of the two things Lag (2026:484) 3 kap. 3 § tredje stycket names
 * happened to a registered overlatelse.
 */
export type TransferReversalKind = "RESCINDED" | "RETURNED_TO_SELLER";

export interface ApartmentRegisterTransferReversal {
  id: string;
  transferId: string;
  kind: TransferReversalKind;
  reversedOn: string;
  reference: string;
}

/**
 * On which ground a tenant-ownership ceased.
 *
 * Mirrors the TerminationKind enum in `apps/api/prisma/schema.prisma`: a
 * general meeting deciding that one held by the association should cease
 * (BRL 6 kap. 11 §), or the building being transferred or sold executively
 * (BRL 7 kap. 33 §).
 */
export type TerminationKind =
  "GENERAL_MEETING_DECISION" | "BUILDING_TRANSFERRED";

export interface ApartmentRegisterTermination {
  id: string;
  kind: TerminationKind;
  tookEffectOn: string;
  reference: string;
}

export interface ApartmentRegisterRow {
  apartmentId: string;
  designation: string;
  number: string;
  addressLabel: string;
  initialShareCapital: string | null;
  participationShare: string | null;
  holders: ApartmentRegisterHolder[];
  liens: ApartmentRegisterLien[];
  transfers: ApartmentRegisterTransfer[];
  transferReversals: ApartmentRegisterTransferReversal[];
  terminations: ApartmentRegisterTermination[];
}

/**
 * On what footing the association's buildings stand on their land.
 *
 * Mirrors the LandTenure enum in `apps/api/prisma/schema.prisma`. Forordning
 * (2026:898) 2 kap. 4 § andra stycket reports the fastighetsbeteckning with a
 * taxeringsenhetsnummer and a fastighetstyp, in place of the lagfarts- och
 * tomtrattsinnehav, in the third case alone.
 */
export type LandTenure = "OWNERSHIP" | "SITE_LEASEHOLD" | "OTHER";

/**
 * The association as the apartment register names it.
 *
 * One field more than the member register's, and the extra field is why this is
 * a separate type rather than the shared one widened. The property designation
 * is apartment register content - it names the property the apartments are in -
 * and the member register extract is public on request, so nothing on it should
 * grow by accident.
 */
export interface ApartmentRegisterHousingCooperative extends RegisterHousingCooperative {
  propertyDesignation: string | null;
  landTenure: LandTenure | null;
  taxAssessmentUnitNumber: string | null;
  propertyType: string | null;
}

export interface ApartmentRegisterExtract {
  housingCooperative: ApartmentRegisterHousingCooperative;
  generatedOn: string;
  identityNumbersIncluded: boolean;
  audience: "board" | "holder";
  rows: ApartmentRegisterRow[];
}

export function fetchApartmentRegister(): Promise<
  ApiResult<ApartmentRegisterExtract>
> {
  return apiRequest("GET", "/api/apartment-register");
}

/**
 * The full statutory extract, personal identity numbers included.
 *
 * A POST although it reads: it writes an audit entry naming everyone whose
 * number the copy disclosed, and those numbers must not travel in a URL.
 */
export function revealApartmentRegister(): Promise<
  ApiResult<ApartmentRegisterExtract>
> {
  return apiRequest("POST", "/api/apartment-register/reveal", {});
}

/** A tenant-owner's own entry, and only theirs. */
export function fetchOwnApartmentRegister(): Promise<
  ApiResult<ApartmentRegisterExtract>
> {
  return apiRequest("GET", "/api/apartment-register/mine");
}

export function revealOwnApartmentRegister(): Promise<
  ApiResult<ApartmentRegisterExtract>
> {
  return apiRequest("POST", "/api/apartment-register/mine/reveal", {});
}

export function noteLien(input: {
  apartmentId: string;
  creditor: string;
  notedOn: string;
  amount?: string | null;
}): Promise<ApiResult<ApartmentRegisterLien>> {
  return apiRequest("POST", "/api/apartment-register/liens", input);
}

export function releaseLien(input: {
  lienId: string;
  releasedOn: string;
}): Promise<ApiResult<ApartmentRegisterLien>> {
  return apiRequest("POST", "/api/apartment-register/liens/release", input);
}

/**
 * Records that a tenant-ownership has ceased (upphorande).
 *
 * The event the association reports to the cooperative housing register within
 * two weeks of the day it ceased (Lag (2026:484) 3 kap. 4 §).
 */
export function recordTermination(input: {
  apartmentId: string;
  kind: TerminationKind;
  tookEffectOn: string;
  reference: string;
}): Promise<ApiResult<ApartmentRegisterTermination>> {
  return apiRequest("POST", "/api/apartment-register/terminations", input);
}

/**
 * Records which case of Lag (2026:484) 3 kap. 3 § an overgang falls in, and the
 * day the association decided on membership where that case has one.
 *
 * The route keeps the path the membership decision had: it is the same act
 * widened, and the ordinary case is what it always recorded.
 */
export function recordReportBasis(input: {
  transferId: string;
  basis: TransferReportBasis;
  membershipDecidedOn?: string | null;
}): Promise<ApiResult<ApartmentRegisterTransfer>> {
  return apiRequest(
    "POST",
    "/api/apartment-register/membership-decision",
    input,
  );
}

/**
 * Records that a registered overlatelse has been havd or has gone back to the
 * seller (Lag (2026:484) 3 kap. 3 § tredje stycket).
 */
export function recordTransferReversal(input: {
  transferId: string;
  kind: TransferReversalKind;
  reversedOn: string;
  reference: string;
}): Promise<ApiResult<ApartmentRegisterTransferReversal>> {
  return apiRequest(
    "POST",
    "/api/apartment-register/transfer-reversals",
    input,
  );
}

/** Records the association's authoritative property designation. */
export function recordPropertyDesignation(input: {
  propertyDesignation: string | null;
}): Promise<ApiResult<{ propertyDesignation: string | null }>> {
  return apiRequest(
    "POST",
    "/api/apartment-register/property-designation",
    input,
  );
}

/**
 * Records on what footing the association's buildings stand on their land, and
 * the two fields Forordning (2026:898) 2 kap. 4 § andra stycket reports on the
 * strength of one of the three answers.
 */
export function recordLandTenure(input: {
  landTenure: LandTenure | null;
  taxAssessmentUnitNumber?: string | null;
  propertyType?: string | null;
}): Promise<
  ApiResult<{
    landTenure: LandTenure | null;
    taxAssessmentUnitNumber: string | null;
    propertyType: string | null;
  }>
> {
  return apiRequest("POST", "/api/apartment-register/land-tenure", input);
}

// --- Reporting to the cooperative housing register (bostadsrattsregistret) ---

/**
 * The duty ledger, as the browser sees it.
 *
 * A third set of types with nothing shared with the two registers above, for the
 * reason this file's header gives about those two: the reporting duty is a third
 * thing under a third act, and a shared type is one place where the wrong field
 * could reach the wrong document. Mirrors
 * `apps/api/src/registers/register-report.service.ts` and
 * `initial-supply.service.ts`.
 */

/** Which register event a duty is about. */
export type RegisterReportKind =
  "GRANT" | "TRANSFER" | "TERMINATION" | "TRANSFER_REVERSAL";

/**
 * Where one duty stands today.
 *
 * `outstanding` is a duty the statute sets no deadline for. There is one - the
 * anmalan that a registered overlatelse has been havd or gone back to the seller
 * (Lag (2026:484) 3 kap. 3 § tredje stycket), which says the association "ska
 * anmala" where every other reporting sentence in the chapter says "inom tva
 * veckor".
 */
export type RegisterReportState =
  "reported" | "overdue" | "due" | "outstanding";

export interface RegisterReportDuty {
  id: string;
  kind: RegisterReportKind;
  apartmentId: string;
  designation: string;
  transferId: string | null;
  terminationId: string | null;
  reversalId: string | null;
  triggeredOn: string;
  /** Null where the section imposing the duty sets no period. */
  dueOn: string | null;
  state: RegisterReportState;
  /**
   * Calendar days from today to the deadline, negative once it has passed.
   *
   * From the server rather than computed here, so the count and the state cannot
   * disagree. A browser clock a day out would otherwise render a duty as still
   * due with "1 day past the deadline" beside it.
   */
  daysUntilDue: number | null;
  reportedOn: string | null;
}

/**
 * An overgang the association does not report, and who does.
 *
 * Lag (2026:484) 3 kap. 3 § forsta stycket puts the anmalan on a juridical
 * person that acquired the bostadsratt at an executive or forced sale while
 * holding a lien in it (BRL 6 kap. 1 § andra stycket). No duty is entered in the
 * ledger for one, because the association owes none and could never discharge
 * it, so the queue states it separately rather than showing the board nothing.
 */
export interface RegisterReportElsewhere {
  transferId: string;
  apartmentId: string;
  designation: string;
  transferredOn: string;
}

export interface RegisterReportQueue {
  generatedOn: string;
  counts: {
    overdue: number;
    due: number;
    outstanding: number;
    reported: number;
  };
  duties: RegisterReportDuty[];
  reportedElsewhere: RegisterReportElsewhere[];
}

export function fetchRegisterReportQueue(): Promise<
  ApiResult<RegisterReportQueue>
> {
  return apiRequest("GET", "/api/register-reports");
}

/**
 * Records that the anmalan for one duty reached Lantmateriet.
 *
 * What it writes is an audit entry rather than a register row: the obligation
 * ledger is append-only and a discharged duty has no later state to reach there.
 * An entry cannot be corrected either, so a duty that already carries a date is
 * refused rather than overwritten.
 */
export function recordRegisterReportMade(input: {
  obligationId: string;
  reportedOn: string;
}): Promise<ApiResult<RegisterReportDuty>> {
  return apiRequest("POST", "/api/register-reports/reported", input);
}

/** Which kind of thing one row of the initial supply is about. */
export type SupplyRecordType = "ASSOCIATION" | "APARTMENT" | "HOLDER" | "LIEN";

/**
 * One row of the initial supply, as the columns it fills.
 *
 * A record keyed by column name rather than a named field per column, because
 * the file's own shape is a header and rows read by position: a row leaves the
 * columns of the other record types empty, and a type with twenty optional
 * fields would be the same thing spelled out twice.
 */
export type SupplyRow = { recordType: SupplyRecordType } & Record<
  string,
  string | undefined
>;

export interface InitialSupply {
  generatedOn: string;
  fileName: string;
  columns: string[];
  rows: SupplyRow[];
  counts: Record<SupplyRecordType, number>;
  /** The file itself, as the one serialiser on the API produced it. */
  csv: string;
}

/**
 * Produces the initial supply (Lag (2026:485) 3 §).
 *
 * A POST although it reads, for the reasons the register's own reveal route
 * gives: it writes an audit entry, and the response carries a personal identity
 * number for every current holder, which must not sit in a URL, a proxy log or
 * a browser history. It also needs a permission of its own, so a 403 here is the
 * ordinary answer for a caller who may read the register and not supply it.
 */
export function produceInitialSupply(): Promise<ApiResult<InitialSupply>> {
  return apiRequest("POST", "/api/register-reports/initial-supply", {});
}
