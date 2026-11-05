import { describe, expect, it } from "vite-plus/test";

import {
  WORK_ORDER_DELIVERY_FAILURES,
  WORK_ORDER_NEVER_LEFT,
  workOrderKnownNotSent,
} from "./work-order-delivery";

describe("workOrderKnownNotSent", () => {
  it("says not sent only for a failure after which nothing left the instance", () => {
    expect([...WORK_ORDER_NEVER_LEFT].sort()).toEqual(
      [
        WORK_ORDER_DELIVERY_FAILURES.mailNotConfigured,
        WORK_ORDER_DELIVERY_FAILURES.interrupted,
        WORK_ORDER_DELIVERY_FAILURES.recipientRemoved,
        WORK_ORDER_DELIVERY_FAILURES.recipientUnreadable,
        WORK_ORDER_DELIVERY_FAILURES.textErased,
        WORK_ORDER_DELIVERY_FAILURES.ringFenced,
      ].sort(),
    );
    for (const failure of Object.values(WORK_ORDER_DELIVERY_FAILURES)) {
      expect(workOrderKnownNotSent(failure), failure).toBe(
        WORK_ORDER_NEVER_LEFT.includes(failure),
      );
    }
  });

  it("leaves a mail that may have gone out unconfirmed", () => {
    expect(workOrderKnownNotSent("send-failed")).toBe(false);
    expect(workOrderKnownNotSent("delivery-unconfirmed")).toBe(false);
    expect(workOrderKnownNotSent(null)).toBe(false);
    expect(workOrderKnownNotSent("a code from a later version")).toBe(false);
  });
});
