import { describe, expect, it } from "vite-plus/test";

import { CAPABILITIES, isSeatBound } from "../authorization/capabilities";
import {
  SUPPORT_CAPABILITIES,
  supportCapabilities,
  WITHHELD_FROM_SUPPORT,
} from "./support-capabilities";

/**
 * That every capability is either a supporter's or withheld from one, and
 * not both (ADR 0028).
 *
 * The type of WITHHELD_FROM_SUPPORT already refuses to compile without every
 * capability the support list leaves out. This asserts the same of the values
 * at run time, in both directions, so a capability added to CAPABILITIES fails
 * here until somebody decides which side it is on.
 */
describe("the support capabilities", () => {
  it("names every capability on exactly one side", () => {
    const supported = new Set<string>(SUPPORT_CAPABILITIES);
    const withheld = new Set(Object.keys(WITHHELD_FROM_SUPPORT));

    expect([...supported].filter((name) => withheld.has(name))).toEqual([]);
    expect(
      CAPABILITIES.filter(
        (capability) => !supported.has(capability) && !withheld.has(capability),
      ),
    ).toEqual([]);
    expect(
      [...supported, ...withheld].filter(
        (name) => !(CAPABILITIES as readonly string[]).includes(name),
      ),
    ).toEqual([]);
  });

  it("is the thirteen the decision names", () => {
    expect([...SUPPORT_CAPABILITIES].sort()).toEqual(
      [
        "association:manage",
        "association:read",
        "addressBook:read",
        "memberRegister:read",
        "invitation:send",
        "signupRequest:decide",
        "systemRole:manage",
        "boardPosition:manage",
        "issues:configure",
        "bookings:configure",
        "documents:manage",
        "site:manage",
        "events:manage",
      ].sort(),
    );
  });

  it("holds nothing that discloses a number, a lien or a protected person", () => {
    for (const capability of [
      "apartmentRegister:read",
      "protectedData:reveal",
      "registerReport:export",
    ] as const) {
      expect(WITHHELD_FROM_SUPPORT[capability]).toBe("discloses");
    }
  });

  it("holds no seat-bound capability", () => {
    expect(SUPPORT_CAPABILITIES.filter((name) => isSeatBound(name))).toEqual(
      [],
    );
  });

  it("is handed out as a fresh set, so one request cannot widen the next", () => {
    const first = supportCapabilities();
    first.add("protectedData:reveal");

    expect(supportCapabilities().has("protectedData:reveal")).toBe(false);
  });
});
