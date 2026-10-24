import { apiRequest, type ApiResult } from "../api/client";

/**
 * The board's devices screen: every live device token on the instance, and
 * revoking one (ADRs 0031 and 0050).
 *
 * The shapes mirror the API's answers rather than restating its types, as the
 * connected apps' do. Instants arrive as ISO strings and are formatted where
 * they are shown.
 */

/** One live device token, as the board reads it. Never the token. */
export interface DeviceToken {
  id: string;
  /** The plugin whose device route it reaches, or null for the display mode. */
  pluginId: string | null;
  /** The id of that route in the plugin's manifest. */
  route: string;
  /** The plugin's own handle on the device, such as a screen's id. */
  subject: string;
  /** The board's name for the device, such as "Entrance B, ground floor". */
  label: string;
  issuedAt: string;
  /** Null for a device that has not called since it was issued. */
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Null for a person no longer in the register. */
  issuedBy: { personId: string; name: string } | null;
}

export function fetchDeviceTokens(): Promise<
  ApiResult<{ devices: DeviceToken[] }>
> {
  return apiRequest("GET", "/api/devices");
}

/** Revokes a token. The device's next call is refused. */
export function revokeDeviceToken(
  id: string,
): Promise<ApiResult<{ revoked: true }>> {
  return apiRequest("DELETE", `/api/devices/${encodeURIComponent(id)}`);
}
