import "reflect-metadata";

import { describe, expect, it } from "vitest";

import type { Capability } from "../authorization/capabilities";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import {
  ApartmentRegisterController,
  OwnApartmentRegisterController,
} from "./apartment-register.controller";

/**
 * What each route on the apartment register demands, read off the route itself.
 *
 * Asserted here because no HTTP test can distinguish it. Every role that holds
 * `apartmentRegister:read` also holds `addressBook:write` - admin and board are
 * the only two - so a request test proves only that a resident is refused, and
 * it would go on passing with the write capability removed from a route that
 * writes a statutory register. That is exactly the shape of test this repository
 * keeps finding: green through the regression it exists for.
 *
 * The rule these enforce: writing to a statutory register needs more than the
 * right to read it. It matters the moment a role is added that reads the
 * register without keeping its content - an auditor, a broker seat, an economic
 * manager - and by then the routes have to already say so.
 */

/** The capabilities declared on one route, class-level ones excluded. */
function requiredOn(
  controller: object,
  method: string,
): Capability[] | undefined {
  const handler = (controller as Record<string, unknown>)[method];
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, handler as object) as
    Capability[] | undefined;
}

/** What the class demands of every route in it. */
function requiredOnClass(target: object): Capability[] | undefined {
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, target) as
    Capability[] | undefined;
}

describe("the apartment register's capability declarations", () => {
  it("gates the whole board controller on reading the register", () => {
    // The class-level declaration is the safer default: a route added later
    // inherits it rather than arriving open.
    expect(requiredOnClass(ApartmentRegisterController)).toEqual([
      "apartmentRegister:read",
    ]);
  });

  it("demands the write capability of every statutory write", () => {
    for (const route of [
      "addLien",
      "releaseLien",
      "recordTermination",
      "recordMembershipDecision",
      "recordPropertyDesignation",
    ]) {
      expect(
        requiredOn(ApartmentRegisterController.prototype, route),
        `${route} writes the statutory register`,
      ).toEqual(["apartmentRegister:read", "addressBook:write"]);
    }
  });

  it("demands the reveal capability of the full extract and of nothing else", () => {
    expect(requiredOn(ApartmentRegisterController.prototype, "reveal")).toEqual(
      ["apartmentRegister:read", "protectedData:reveal"],
    );
    // The plain read carries no route-level declaration at all, so it is the
    // class's alone. A reveal capability creeping onto it would shut the board
    // out of its own register.
    expect(
      requiredOn(ApartmentRegisterController.prototype, "extract"),
    ).toBeUndefined();
  });

  it("leaves a tenant-owner's own entry on self:manage, with no write route on it", () => {
    // A holder's controller has no write route. A capability list would be the
    // wrong place to say so; the absence of a method is the guarantee.
    expect(requiredOnClass(OwnApartmentRegisterController)).toEqual([
      "self:manage",
    ]);
    for (const route of [
      "addLien",
      "recordTermination",
      "recordMembershipDecision",
      "recordPropertyDesignation",
    ]) {
      expect(
        (
          OwnApartmentRegisterController.prototype as unknown as Record<
            string,
            unknown
          >
        )[route],
        `${route} is not reachable from a holder's own entry`,
      ).toBeUndefined();
    }
  });
});
