import { describe, expect, it } from "vitest";

import i18n from "../i18n";
import {
  registerClientFailureKey,
  revokeClientFailureKey,
} from "./connected-app-failures";

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
    expect(i18n.getFixedT("en")(key)).toContain("connected app is not known");
    expect(i18n.getFixedT("sv")(key)).toContain("anslutna appen är inte känd");
  });

  it("falls back to the general sentence for a reason it does not know", () => {
    expect(
      revokeClientFailureKey({ status: 500, reason: "something-new" }),
    ).toBe("connectedApps.errors.failed");
  });
});

/**
 * A well-formed address the instance refuses answers `invalid-redirect-uri`,
 * and a malformed body stays `invalid-body`; the form must tell them apart.
 */
describe("registerClientFailureKey", () => {
  it("blames the address when the API refuses one", () => {
    expect(
      registerClientFailureKey({ status: 400, reason: "invalid-redirect-uri" }),
    ).toBe("connectedApps.register.errors.invalidRedirectUri");
  });

  it("keeps the sentence about both fields for a malformed body", () => {
    expect(
      registerClientFailureKey({ status: 400, reason: "invalid-body" }),
    ).toBe("connectedApps.register.errors.invalidBody");
  });
});
