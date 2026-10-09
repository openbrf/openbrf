import { describe, expect, it } from "vitest";

import i18n from "../i18n";
import { revokeClientFailureKey } from "./connected-app-failures";

/**
 * The API answers a turn-away of an unknown client with the code
 * `client-not-found`. It has to read as a sentence about the client in both
 * languages, and a code this build has not heard of must not be printed.
 */

describe("revokeClientFailureKey", () => {
  it("maps client-not-found to its own connected-app sentence", () => {
    const key = revokeClientFailureKey({
      status: 404,
      reason: "client-not-found",
    });

    expect(key).toBe("connectedApps.errors.clientNotFound");
    expect(i18n.getFixedT("en")(key)).toContain("not known to this instance");
    expect(i18n.getFixedT("sv")(key)).toContain("inte känd");
  });

  it("falls back to the general sentence for a reason it does not know", () => {
    expect(
      revokeClientFailureKey({ status: 500, reason: "something-new" }),
    ).toBe("connectedApps.errors.failed");
  });
});
