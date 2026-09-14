import { describe, expect, it } from "vitest";

import { AuditAction } from "../generated/prisma/enums";
import { REPORT_AUDIT_ACTIONS } from "./report-audit-actions";

/**
 * The test that makes an unlabelled audit action impossible to ship.
 *
 * Before this, the report typed its action as a plain string, the browser
 * declared ninety-three of them, and the log held a hundred and five. The
 * twelve in between reached the statutory document as an empty cell: a member
 * charge, a debiting list export, a board mailbox act and a transfer reversal
 * all printed as nothing at all, with every build green.
 *
 * Set equality rather than a count, and asserted in both directions, so that the
 * next audit action added to the schema stops the build here - beside the list
 * the browser mirrors - rather than in a cooperative's access report.
 */
describe("the actions the access report can render", () => {
  it("is exactly the log's own vocabulary", () => {
    expect([...REPORT_AUDIT_ACTIONS].sort()).toEqual(
      Object.values(AuditAction).sort(),
    );
  });

  it("names each action once", () => {
    expect(new Set(REPORT_AUDIT_ACTIONS).size).toBe(
      REPORT_AUDIT_ACTIONS.length,
    );
  });
});
