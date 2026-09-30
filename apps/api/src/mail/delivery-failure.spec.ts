import { describe, expect, it } from "vitest";

import { InvitationError } from "../invitations/invitation.service";
import { isDeliveryFailure } from "./delivery-failure";
import { MailApiError } from "./http-api-mail.driver";
import { MailNotConfiguredError } from "./mail.service";

describe("a failure that is the mail not leaving", () => {
  it.each([
    ["no mail configured", new MailNotConfiguredError()],
    ["the mail API refusing", new MailApiError("refused", 503)],
    ["the mail API not answering", new MailApiError("timeout", null)],
    ["an invitation with no address", new InvitationError("x", "no-email")],
    [
      "a refused envelope",
      Object.assign(new Error("550"), { code: "EENVELOPE" }),
    ],
    [
      "a connection that timed out",
      Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    ],
  ])("counts %s", (_name, cause) => {
    expect(isDeliveryFailure(cause)).toBe(true);
  });

  it.each([
    ["a type error", new TypeError("x is not a function")],
    ["a unique violation", Object.assign(new Error("dup"), { code: "P2002" })],
    ["a string", "EENVELOPE"],
    ["nothing at all", undefined],
  ])("does not count %s", (_name, cause) => {
    expect(isDeliveryFailure(cause)).toBe(false);
  });
});
