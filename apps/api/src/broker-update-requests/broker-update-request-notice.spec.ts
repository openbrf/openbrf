import { describe, expect, it } from "vite-plus/test";

import {
  capabilitiesFor,
  type PrincipalRoles,
} from "../authorization/capabilities";
import { activeBoardSeatWhere } from "../mail/board-recipients";
import { siteManagerRecipientsWhere } from "./broker-update-request-notice.service";

/**
 * Who the board's notice about a broker's update request goes to, held to the
 * capability that reads the queue.
 *
 * The recipients are a database filter and the capability a computation over
 * one principal's roles, so nothing but this keeps the two in step: a role
 * that came to hold `site:manage` would otherwise read the queue and never be
 * told of a request.
 */

const ROLES = [
  "isAdmin",
  "isBoardMember",
  "isPropertyManager",
  "isResident",
  "isMember",
] as const satisfies readonly (keyof PrincipalRoles)[];

/** Every combination of the five roles. */
function everyCombination(): PrincipalRoles[] {
  return Array.from({ length: 2 ** ROLES.length }, (_, bits) => {
    const roles = {} as PrincipalRoles;
    ROLES.forEach((role, index) => {
      roles[role] = (bits & (1 << index)) !== 0;
    });
    return roles;
  });
}

describe("who is told of a broker's update request", () => {
  it("is whoever holds site:manage: an administrator or a board seat", () => {
    for (const roles of everyCombination()) {
      expect(capabilitiesFor(roles).has("site:manage")).toBe(
        roles.isAdmin || roles.isBoardMember,
      );
    }
  });

  it("is read as those two, with an address", () => {
    const now = new Date("2026-10-20T10:00:00.000Z");

    expect(siteManagerRecipientsWhere(now)).toStrictEqual({
      emailCipher: { not: null },
      OR: [
        { systemRoles: { some: { role: "ADMIN" } } },
        activeBoardSeatWhere(now),
      ],
    });
  });
});
