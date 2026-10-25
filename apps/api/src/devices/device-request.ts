import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";

import type { MarkedResponse } from "../actions/authenticated-request";

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
 *
 * Whether the request is still being served is held beside the mark, and ends
 * with the response as the authenticated mark does. `host.audit` reads it: an
 * entry written on a device's request is spent from that device's budget, and a
 * request the plugin kept past its response must not spend it, or a job could
 * write on a request it kept and escape the budget that stops the plugin.
 */
export interface DeviceRequest {
  /** The plugin whose route it reached, or null on the core's display route. */
  pluginId: string | null;
  device: DeviceTokenSummary;
}

const devices = new WeakMap<object, DeviceRequest>();
const served = new WeakSet<object>();

/**
 * Called by the guard once a device token has been accepted.
 *
 * A response already over leaves the request marked but never served, for the
 * reason `markAuthenticated` gives: it will not finish or close again.
 */
export function markDeviceRequest(
  request: object,
  response: MarkedResponse,
  mark: DeviceRequest,
): void {
  devices.set(request, mark);
  if (response.writableFinished || response.destroyed) {
    return;
  }
  served.add(request);
  const end = (): void => {
    served.delete(request);
  };
  response.once("finish", end);
  response.once("close", end);
}

/** The device a request came from, or undefined for any other request. */
export function deviceRequestOf(request: object): DeviceRequest | undefined {
  return devices.get(request);
}

/** Whether a device's request is still being served. */
export function isServedDeviceRequest(request: object): boolean {
  return served.has(request);
}
