import { apiRequest, apiUpload, type ApiResult } from "./client";
import type { MeetingBylaws } from "./meetings";

/**
 * The instance's own endpoints, one function per route.
 *
 * These types mirror the API's response shapes. Kept here rather than shared
 * from the server package because the server's are Nest-facing and carry Prisma
 * types; what the browser needs is the wire shape and nothing else.
 */

export interface SetupState {
  /** True while the public first-boot path is open. */
  setupRequired: boolean;
}

export interface HousingCooperativeSettings {
  name: string;
  organizationNumber: string | null;
  defaultLocale: string;
  setupCompletedAt: string | null;
}

/** One uploaded logo. The url is a path on this instance's own origin. */
export interface LogoView {
  url: string;
  fileName: string;
  width: number | null;
  height: number | null;
}

/** Which logo a request means: the mark, or its dark-surface variant. */
export type LogoSlot = "light" | "dark";

export interface BrandingSettings {
  primaryColor: string | null;
  logo: LogoView | null;
  logoDark: LogoView | null;
}

export interface SmtpSettings {
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  fromAddress: string | null;
  /** Whether a password is stored. The password itself never leaves the API. */
  passwordSet: boolean;
  /** Whether the instance can send mail at all. */
  configured: boolean;
}

/** How the instance sends text messages. */
export interface SmsSettings {
  /** Which driver is selected, or null while the instance sends no SMS. */
  driver: string | null;
  gatewayUrl: string | null;
  senderName: string | null;
  /** Whether a credential is stored. The credential itself never leaves the API. */
  tokenSet: boolean;
  /** Whether the instance could actually send a text message. */
  configured: boolean;
}

export interface InstanceSettings {
  housingCooperative: HousingCooperativeSettings;
  branding: BrandingSettings;
  smtp: SmtpSettings;
  sms: SmsSettings;
  retention: { daysAfterMoveOut: number };
  selfSignup: { enabled: boolean };
  /** Whether the association's website carries an issue report form. */
  issueReporting: { publicFormEnabled: boolean };
  /**
   * The deadline the bylaws set for motions to the general meeting, or null when
   * they set none.
   *
   * Null is the ordinary state of a fresh instance rather than a setting waiting
   * to be filled in: EFL 6 kap. 15 § makes the deadline the association's own
   * clause, so a cooperative whose bylaws are silent has none and intake stays
   * open.
   */
  motionDeadline: { month: number; day: number } | null;
  /**
   * What the bylaws say about the general meeting, in the four places BRL 9 kap.
   * 14 § leaves the rule to them.
   *
   * Never null, unlike the deadline above, and the difference is the statute
   * rather than a modelling choice: each of these clauses has a rule that
   * applies unless the bylaws displace it, so an association that has recorded
   * nothing is under the statute rather than half-configured.
   *
   * The shape is mirrored from the meetings module's own wire type rather than
   * declared twice, because the same four clauses travel with every meeting the
   * board reads and two declarations of them could drift.
   */
  meetingBylaws: MeetingBylaws;
}

export interface Viewer {
  personId: string;
  firstName: string;
  lastName: string;
  preferredLocale: string;
  capabilities: string[];
  housingCooperative: {
    name: string;
    primaryColor: string | null;
    /** Null until a logo is uploaded. Always a path on this origin. */
    logoUrl: string | null;
    /** The dark-band variant, when the board uploaded one. */
    logoDarkUrl: string | null;
  } | null;
}

export interface AddressView {
  id: string;
  street: string;
  number: string;
  postalCode: string;
  city: string;
  sortOrder: number;
  apartmentCount: number;
}

export interface ApartmentView {
  id: string;
  number: string;
  floor: number | null;
}

export interface AddressInput {
  street: string;
  number: string;
  postalCode: string;
  city: string;
}

export interface ApartmentRowInput {
  number: string;
  floor?: number | null;
}

export interface SmtpInput {
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  /** Omit to keep the stored password; null to clear it. */
  password?: string | null;
  fromAddress: string | null;
}

export interface SmsInput {
  driver: string | null;
  gatewayUrl: string | null;
  senderName: string | null;
  /** Omit to keep the stored credential; null to clear it. */
  token?: string | null;
}

/** One contrast pair that stopped a colour from being saved. */
export interface ContrastFailure {
  foreground: string;
  background: string;
  ratio: number | null;
  required: number;
  statutory: boolean;
}

export function fetchSetupState(): Promise<ApiResult<SetupState>> {
  return apiRequest("GET", "/api/setup/state");
}

export function createFirstAdministrator(input: {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  preferredLocale?: string;
}): Promise<ApiResult<{ personId: string }>> {
  return apiRequest("POST", "/api/setup/administrator", input);
}

export function completeSetup(): Promise<ApiResult<{ completedAt: string }>> {
  return apiRequest("POST", "/api/setup/complete");
}

export function fetchViewer(): Promise<ApiResult<Viewer>> {
  return apiRequest("GET", "/api/me");
}

export function fetchSettings(): Promise<ApiResult<InstanceSettings>> {
  return apiRequest("GET", "/api/settings");
}

export function saveHousingCooperative(input: {
  name: string;
  organizationNumber: string | null;
  defaultLocale: string;
}): Promise<ApiResult<HousingCooperativeSettings>> {
  return apiRequest("PUT", "/api/settings/housing-cooperative", input);
}

export function saveBranding(input: {
  primaryColor: string | null;
}): Promise<ApiResult<BrandingSettings>> {
  return apiRequest("PUT", "/api/settings/branding", input);
}

export function uploadLogo(
  slot: LogoSlot,
  file: File,
): Promise<ApiResult<BrandingSettings>> {
  return apiUpload("PUT", `/api/settings/branding/logo/${slot}`, file);
}

export function removeLogo(
  slot: LogoSlot,
): Promise<ApiResult<BrandingSettings>> {
  return apiRequest("DELETE", `/api/settings/branding/logo/${slot}`);
}

export function saveSmtp(input: SmtpInput): Promise<ApiResult<SmtpSettings>> {
  return apiRequest("PUT", "/api/settings/smtp", input);
}

export function sendSmtpTest(): Promise<
  ApiResult<{ sentTo: string; host: string }>
> {
  return apiRequest("POST", "/api/settings/smtp/test");
}

export function saveSms(input: SmsInput): Promise<ApiResult<SmsSettings>> {
  return apiRequest("PUT", "/api/settings/sms", input);
}

export function sendSmsTest(): Promise<ApiResult<{ sentTo: string }>> {
  return apiRequest("POST", "/api/settings/sms/test");
}

export function saveRetention(input: {
  daysAfterMoveOut: number;
}): Promise<ApiResult<{ daysAfterMoveOut: number }>> {
  return apiRequest("PUT", "/api/settings/retention", input);
}

export function saveSelfSignup(input: {
  enabled: boolean;
}): Promise<ApiResult<{ enabled: boolean }>> {
  return apiRequest("PUT", "/api/settings/self-signup", input);
}

/**
 * Records what the association's bylaws say about the general meeting.
 *
 * All four clauses at once and never one of them, because the endpoint takes
 * them that way: they are transcribed together from one paragraph of the
 * stadgar, and a form that saved them one at a time would let an instance sit in
 * a state the bylaws do not describe.
 */
export function saveMeetingBylaws(
  input: MeetingBylaws,
): Promise<ApiResult<{ meetingBylaws: MeetingBylaws }>> {
  return apiRequest("PUT", "/api/settings/meeting-bylaws", input);
}

export function saveOwnProfile(input: {
  preferredLocale: string;
}): Promise<ApiResult<{ preferredLocale: string }>> {
  return apiRequest("PUT", "/api/settings/profile", input);
}

export function fetchAddresses(): Promise<ApiResult<AddressView[]>> {
  return apiRequest("GET", "/api/addresses");
}

export function createAddress(
  input: AddressInput,
): Promise<ApiResult<AddressView>> {
  return apiRequest("POST", "/api/addresses", input);
}

export function removeAddress(id: string): Promise<ApiResult<undefined>> {
  return apiRequest("DELETE", `/api/addresses/${encodeURIComponent(id)}`);
}

export function fetchApartments(
  addressId: string,
): Promise<ApiResult<ApartmentView[]>> {
  return apiRequest(
    "GET",
    `/api/addresses/${encodeURIComponent(addressId)}/apartments`,
  );
}

export function addApartments(
  addressId: string,
  apartments: readonly ApartmentRowInput[],
): Promise<ApiResult<{ created: number; skipped: number }>> {
  return apiRequest(
    "POST",
    `/api/addresses/${encodeURIComponent(addressId)}/apartments`,
    { apartments },
  );
}

export function removeApartment(id: string): Promise<ApiResult<undefined>> {
  return apiRequest("DELETE", `/api/apartments/${encodeURIComponent(id)}`);
}
