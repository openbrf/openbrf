import { AUDIT_CHANNELS } from "@openbrf/shared";
import { describe, expect, it } from "vitest";

import { AuditChannel } from "../generated/prisma/enums";

/**
 * The channel vocabulary exists twice and has to stay one list.
 *
 * The database writes the generated enum; the browser prints the channel on the
 * data subject access report from the shared list and cannot import a server
 * type to do it. A value in the enum and not in the list is a column value
 * nothing can render; a value in the list and not in the enum is a label for
 * something that can never be written. Neither would fail to compile, so it is
 * asserted here, on the one side that can see both.
 */
describe("the audit channel vocabulary", () => {
  it("holds the same values on both sides", () => {
    expect([...AUDIT_CHANNELS].sort()).toEqual(
      Object.values(AuditChannel).sort(),
    );
  });
});
