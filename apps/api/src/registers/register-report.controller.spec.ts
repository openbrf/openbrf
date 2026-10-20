import "reflect-metadata";

import { describe, expect, it } from "vite-plus/test";

import {
  type Capability,
  capabilitiesFor,
  type PrincipalRoles,
} from "../authorization/capabilities";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import {
  InitialSupplyController,
  RegisterReportController,
  RegisterTransmissionController,
} from "./register-report.controller";
import {
  REGISTER_TRANSMISSION,
  UnavailableRegisterTransmission,
} from "./register-transmission";
import { RegistersModule } from "./registers.module";

/**
 * What the reporting routes demand, read off the routes themselves.
 *
 * Asserted here because no HTTP test can distinguish it. Every role that holds
 * `apartmentRegister:read` also holds `protectedData:reveal` and
 * `registerReport:export` - admin and board are the only two - so a request test
 * proves only that a resident is refused, and it would go on passing with the
 * export capability, or the reveal capability, taken off the route that decrypts
 * every holder's personal identity number. That is exactly the shape of test
 * this repository keeps finding: green through the regression it exists for.
 *
 * Two rules are being enforced. Supplying the register onward is a different act
 * from reading it, so the supply route demands a capability the queue does not.
 * And the supply is not a weaker path to a disclosure the register's own reveal
 * route refuses, so it demands that route's capability as well. Both matter the
 * moment a seat is added that reads the register without being entitled to
 * supply it, or is entitled to supply it without being entitled to see a
 * number - an auditor, a broker seat, an economic manager - and by then the
 * routes have to already say so.
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

/** A board member, which is the seat these routes exist for. */
const BOARD: PrincipalRoles = {
  isAdmin: false,
  isBoardMember: true,
  isPropertyManager: false,
  isResident: false,
  isMember: false,
};

/** What the class demands of every route in it. */
function requiredOnClass(target: object): Capability[] | undefined {
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, target) as
    Capability[] | undefined;
}

describe("the reporting queue's capability declarations", () => {
  it("gates the queue on reading the register and on nothing else", () => {
    /*
     * Not on the export capability, and not on protectedData:reveal. A duty
     * carries an apartment designation and two statutory dates and no personal
     * data at all, and this is the screen a board opens every time it meets: a
     * queue behind the disclosure capability would either be looked at too
     * rarely or hold the disclosure too widely.
     */
    expect(requiredOnClass(RegisterReportController)).toEqual([
      "apartmentRegister:read",
    ]);
  });

  it("leaves the queue read with no declaration of its own", () => {
    // The class's alone. A capability creeping onto the read would shut the
    // board out of its own deadlines.
    expect(requiredOn(RegisterReportController.prototype, "queue")).toBe(
      undefined,
    );
  });

  it("demands the write capability of recording that a report was made", () => {
    // The same pair every statutory write on the register carries. What it
    // writes is an audit entry rather than a register row, and an entry cannot
    // be corrected either.
    expect(
      requiredOn(RegisterReportController.prototype, "recordReportMade"),
    ).toEqual(["apartmentRegister:read", "addressBook:write"]);
  });
});

describe("the initial supply's capability declarations", () => {
  it("demands all three, in the order the class states them", () => {
    expect(requiredOnClass(InitialSupplyController)).toEqual([
      "apartmentRegister:read",
      "protectedData:reveal",
      "registerReport:export",
    ]);
  });

  it("is a controller of its own, so no queue route inherits the export gate", () => {
    /*
     * The reason the supply is not a route on the queue's controller. A
     * class-level declaration covers every route in the class, which is the
     * safer default in both directions: a queue route added later must not
     * arrive holding the export capability either, or the screen behind it would
     * quietly become as narrowly held as the disclosure.
     */
    expect(
      (
        RegisterReportController.prototype as unknown as Record<string, unknown>
      )["produce"],
    ).toBe(undefined);
    expect(
      (InitialSupplyController.prototype as unknown as Record<string, unknown>)[
        "queue"
      ],
    ).toBe(undefined);
  });

  it("names a capability the board actually holds", () => {
    /*
     * A route can demand a capability nothing grants, and it would then be
     * unreachable by every seat an association has rather than refused by some
     * of them. Forordning (2026:898) 5 kap. 9 § lets a styrelseledamot make the
     * association's anmalan, so the board is the seat this route exists for.
     */
    const held = capabilitiesFor(BOARD);
    const declared = requiredOnClass(InitialSupplyController) ?? [];

    expect(declared).not.toHaveLength(0);
    for (const capability of declared) {
      expect(held.has(capability), `the board holds ${capability}`).toBe(true);
    }
  });
});

describe("the transmission's capability declarations", () => {
  it("demands the initial supply's three and the register write", () => {
    /*
     * The supply's three because a report decrypts a personal identity number
     * and supplies it onward to an authority; the write because a received
     * answer discharges a statutory duty, which is what recording a report made
     * by hand already demands. Asserted here for the reason the file gives: no
     * request test can tell any of the four apart.
     */
    expect(requiredOnClass(RegisterTransmissionController)).toEqual([
      "apartmentRegister:read",
      "protectedData:reveal",
      "registerReport:export",
      "addressBook:write",
    ]);
  });

  it("names capabilities the board actually holds", () => {
    // Förordning (2026:898) 5 kap. 9 § lets a styrelseledamot make the
    // association's anmälan.
    const held = capabilitiesFor(BOARD);
    for (const capability of requiredOnClass(RegisterTransmissionController) ??
      []) {
      expect(held.has(capability), `the board holds ${capability}`).toBe(true);
    }
  });
});

describe("what the port to Lantmäteriet is bound to", () => {
  it("is bound to nothing that can answer", () => {
    /*
     * ADR 0029. The stub the integration suite binds answers "received", and on
     * an instance an association runs that would mark a duty discharged that
     * went nowhere - the queue would stop showing it and the deadline would pass
     * unwatched. Until Lantmäteriet publishes an interface and an adapter is
     * written against it, the module binds the port to a class that refuses, and
     * this is what makes binding anything else a failing build.
     */
    const providers = Reflect.getMetadata(
      "providers",
      RegistersModule,
    ) as unknown[];
    const bindings = providers.filter(
      (provider): provider is { provide: unknown; useClass: unknown } =>
        typeof provider === "object" &&
        provider !== null &&
        "provide" in provider &&
        provider.provide === REGISTER_TRANSMISSION,
    );

    expect(bindings).toEqual([
      {
        provide: REGISTER_TRANSMISSION,
        useClass: UnavailableRegisterTransmission,
      },
    ]);
    expect(new UnavailableRegisterTransmission().available).toBe(false);
  });
});
