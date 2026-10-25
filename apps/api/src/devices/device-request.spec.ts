import { describe, expect, it } from "vite-plus/test";

import { LiveResponse } from "../actions/testing/live-response";
import {
  deviceRequestOf,
  isServedDeviceRequest,
  markDeviceRequest,
} from "./device-request";

const MARK = {
  pluginId: "signage",
  device: {
    id: "device-token-1",
    route: "screen",
    subject: "scr_1",
    label: "Entrance B",
    issuedAt: "2026-10-20T08:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  },
};

/**
 * Whether a device's request is still being served, which `host.audit` holds
 * an entry on it to as it holds a person's.
 */
describe("a device's request", () => {
  it.each(["finish", "close"] as const)(
    "is served until its response emits %s, and keeps naming its device",
    (event) => {
      const response = new LiveResponse();
      const request = {};
      markDeviceRequest(request, response, MARK);
      expect(isServedDeviceRequest(request)).toBe(true);

      response.emit(event);

      expect(isServedDeviceRequest(request)).toBe(false);
      expect(deviceRequestOf(request)).toEqual(MARK);
    },
  );

  it("keeps the device it names out of reach of whoever holds the mark or the summary", () => {
    // `host.devices.current` hands a plugin the summary, and `host.audit`
    // keys the device's budget on its id.
    const device = { ...MARK.device };
    const request = {};
    markDeviceRequest(request, new LiveResponse(), { ...MARK, device });
    device.id = "changed-by-the-caller";

    const mark = deviceRequestOf(request);

    expect(mark).toEqual(MARK);
    expect(Object.isFrozen(mark)).toBe(true);
    expect(Object.isFrozen(mark?.device)).toBe(true);
    expect(Reflect.set(mark?.device ?? {}, "id", "forged")).toBe(false);
    expect(deviceRequestOf(request)?.device.id).toBe("device-token-1");
  });

  it("is never served when its response was over before the mark", () => {
    // It will not finish or close again, so a mark added regardless would
    // never end.
    const sent = Object.assign(new LiveResponse(), { writableFinished: true });
    const closed = Object.assign(new LiveResponse(), { destroyed: true });
    const first = {};
    const second = {};

    markDeviceRequest(first, sent, MARK);
    markDeviceRequest(second, closed, MARK);

    expect(isServedDeviceRequest(first)).toBe(false);
    expect(isServedDeviceRequest(second)).toBe(false);
  });
});
