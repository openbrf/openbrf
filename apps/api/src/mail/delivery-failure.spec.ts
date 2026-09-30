import { describe, expect, it } from "vitest";

import { isDeliveryFailure } from "./delivery-failure";
import { MailApiError } from "./http-api-mail.driver";
import { MailNotConfiguredError } from "./mail.service";

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("a failure that is the mail not leaving", () => {
  it.each([
    ["no mail configured", new MailNotConfiguredError()],
    ["the mail API refusing", new MailApiError("refused", 503)],
    ["the mail API not answering", new MailApiError("timeout", null)],
    ["a refused envelope", coded("EENVELOPE")],
    ["a connection that timed out", coded("ETIMEDOUT")],
    ["a refused login", coded("EAUTH")],
    ["a server that is not there", coded("ECONNREFUSED")],
  ])("counts %s", (_name, cause) => {
    expect(isDeliveryFailure(cause)).toBe(true);
  });

  it.each([
    ["a type error", new TypeError("x is not a function")],
    ["a unique violation", coded("P2002")],
    ["a missing file", coded("ENOENT")],
    ["a refused file", coded("EACCES")],
    ["too many open files", coded("EMFILE")],
    ["a transport set up wrong", coded("ECONFIG")],
    ["a string", "EENVELOPE"],
    ["nothing at all", undefined],
  ])("does not count %s", (_name, cause) => {
    expect(isDeliveryFailure(cause)).toBe(false);
  });
});
