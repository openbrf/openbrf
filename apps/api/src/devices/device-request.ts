import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";

/**
 * The mark the guard puts on a request it let through on a device route.
 *
 * Membership of a map this module owns, for the reason the authenticated mark
 * is one (actions/authenticated-request.ts): a plugin is handed the real
 * request, so anything stored on it could be copied onto an object the plugin
 * built. `host.devices.current` reads the token from here, so a plugin is told
 * which device is asking by the guard and by nothing it could write.
 *
 * Kept apart from the authenticated mark on purpose. A device request carries
 * no person, and the action registry must refuse it (ADR 0031).
 */
export interface DeviceRequest {
  /** The plugin whose route it reached, or null on the core's display route. */
  pluginId: string | null;
  device: DeviceTokenSummary;
}

const devices = new WeakMap<object, DeviceRequest>();

/** Called by the guard once a device token has been accepted. */
export function markDeviceRequest(request: object, mark: DeviceRequest): void {
  devices.set(request, mark);
}

/** The device a request came from, or undefined for any other request. */
export function deviceRequestOf(request: object): DeviceRequest | undefined {
  return devices.get(request);
}
