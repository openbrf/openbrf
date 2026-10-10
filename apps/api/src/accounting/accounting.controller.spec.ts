import "reflect-metadata";

import { describe, expect, it } from "vitest";

import type { Capability } from "../authorization/capabilities";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import { AccountingController } from "./accounting.controller";

/**
 * The accounting basis needs both capabilities, not either.
 *
 * The integration suite can only try people holding neither, because no role
 * holds exactly one of the two. So the declaration is asserted here, and that
 * the guard requires every capability a route names - rather than any one of
 * them - is asserted in `authorization.guard.spec.ts`.
 */
describe("the accounting basis's capability declaration", () => {
  it("names both halves of the money on the controller", () => {
    const required = Reflect.getMetadata(
      REQUIRED_CAPABILITIES,
      AccountingController,
    ) as Capability[] | undefined;

    expect([...(required ?? [])].sort()).toEqual([
      "fees:manage",
      "memberCharges:manage",
    ]);
  });
});
