import type { EntitlementState } from "@openbrf/plugin-sdk";

import { apiRequest, type ApiResult } from "../api/client";

/**
 * The licence screen's endpoints (ADR 0042), under `association:manage`.
 *
 * The shapes mirror the API's responses rather than restating its types, on
 * the plugin endpoints' terms. The entitlement states are the SDK's own,
 * because they are the contract a licensed plugin reads as well.
 */

/**
 * Whether a key still verifies a stored licence.
 *
 * - `verified`: a key an installed plugin declares verified it just now.
 * - `not-yet-checked`: no installed plugin declares its key id.
 * - `tampered`: the key that verified it when it was entered no longer does.
 * - `issuer-not-installed`: no installed plugin declares that key any more.
 */
export type LicenceCheck =
  "verified" | "not-yet-checked" | "tampered" | "issuer-not-installed";

export interface LicenceEntitlement {
  name: string;
  validUntil: string | null;
  updatesUntil: string | null;
}

/** One licence file entered on the instance. */
export interface LicenceView {
  id: string;
  sha256: string;
  keyId: string;
  /** An instant, as an ISO string. */
  enteredAt: string;
  check: LicenceCheck;
  /** What a key recorded when it verified the file; null while not yet checked. */
  licenceId: string | null;
  /**
   * What the file says, only while a key verifies it now. Nothing from a file
   * no key has verified is shown, so a forged one cannot put words on screen.
   */
  verified: {
    issuedOn: string;
    instanceId: string;
    instanceKey: string;
    association: { name: string; organizationNumber: string | null };
    entitlements: LicenceEntitlement[];
    /** As the verifying plugin's manifest names it, never the file. */
    issuer: { name: string; url: string };
    pluginId: string;
  } | null;
}

/** An installed plugin that reads a licence, and what it finds today. */
export interface LicensedPlugin {
  pluginId: string;
  entitlement: string;
  issuer: { name: string; url: string };
  state: EntitlementState;
}

export interface LicencesOverview {
  instance: {
    instanceId: string;
    instanceKey: string;
    /** False when the private key cannot be decrypted, so nothing is presented. */
    keyReadable: boolean;
  };
  licences: LicenceView[];
  plugins: LicensedPlugin[];
}

export function fetchLicences(): Promise<ApiResult<LicencesOverview>> {
  return apiRequest("GET", "/api/licences");
}

/** Enters a licence file, given as the text it holds. */
export function enterLicence(licence: string): Promise<ApiResult<LicenceView>> {
  return apiRequest("POST", "/api/licences", { licence });
}

export function removeLicence(id: string): Promise<ApiResult<undefined>> {
  return apiRequest("DELETE", `/api/licences/${encodeURIComponent(id)}`);
}
