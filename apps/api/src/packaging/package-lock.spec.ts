import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { domainResponse } from "../testing/domain-response";
import {
  PACKAGE_BUSY_RETRY_AFTER_SECONDS,
  PackageBusyError,
  PackageLockLostError,
} from "./package-lock";

/**
 * What the lock's failures answer with. The waiting itself is tested against
 * a database in package-lock.int-spec.ts.
 */

describe("the answers the package lock fails with", () => {
  it("answers a busy package as a refusal worth retrying, with its own reason", () => {
    const { status, headers, body } = domainResponse(
      new PackageBusyError("The theme nordic is being changed."),
    );

    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(headers["retry-after"]).toBe(
      String(PACKAGE_BUSY_RETRY_AFTER_SECONDS),
    );
    expect(body["reason"]).toBe("package-busy");
  });

  it("answers a lost lock as the server's failure, with its own reason", () => {
    const { status, body } = domainResponse(
      new PackageLockLostError("theme", "nordic", new Error("terminated")),
    );

    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body["reason"]).toBe("package-lock-lost");
  });
});
