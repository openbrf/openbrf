import { describe, expect, it } from "vite-plus/test";

import {
  capabilitiesFor,
  type PrincipalRoles,
} from "../authorization/capabilities";
import { activeBoardSeatWhere } from "../mail/board-recipients";
import {
  issueHandledBy,
  issueHandlersWhere,
  issueRecipientsWhere,
  issuesHandledWhere,
  typesHandledWhere,
} from "./issue-handlers";

/**
 * Who handles an issue, held to the capability that opens the queue.
 *
 * The handlers are a database filter and the capability a computation over one
 * principal's roles, so nothing but this keeps the two in step: a role that came
 * to hold `issues:handle` would otherwise read the queue and never be offered
 * as an assignee, and one that lost it would go on being assigned work it can
 * no longer open.
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

const ADMIN = { systemRoles: { some: { role: "ADMIN" } } };
const PROPERTY_MANAGER = {
  systemRoles: { some: { role: "PROPERTY_MANAGER" } },
};

describe("who handles an issue", () => {
  const now = new Date("2026-11-03T10:00:00.000Z");

  it("is whoever holds issues:handle: an administrator, a board seat or the property manager", () => {
    for (const roles of everyCombination()) {
      expect(capabilitiesFor(roles).has("issues:handle")).toBe(
        roles.isAdmin || roles.isBoardMember || roles.isPropertyManager,
      );
    }
  });

  it("reads every handler as those three", () => {
    expect(issueHandlersWhere("EVERY_HANDLER", now)).toStrictEqual({
      OR: [ADMIN, activeBoardSeatWhere(now), PROPERTY_MANAGER],
    });
  });

  it("reads the board as an administrator, seat or not, or a seat, and never the property manager", () => {
    // The administrator by role alone, so one without a seat is let in (the
    // owner's answer to ADR 0054's question 4).
    expect(issueHandlersWhere("BOARD", now)).toStrictEqual({
      OR: [ADMIN, activeBoardSeatWhere(now)],
    });
  });

  it("mails the handlers of a scope and nobody else, only those with an address and no restriction", () => {
    /*
     * The mail goes to the handler rule above and narrows it, never widens it:
     * a role that came to handle issues is mailed about them, and a person
     * whose processing is restricted (GDPR art. 18) or who has no address is
     * still a handler but is mailed nothing.
     */
    for (const handledBy of ["EVERY_HANDLER", "BOARD"] as const) {
      expect(issueRecipientsWhere(handledBy, now)).toStrictEqual({
        AND: [
          issueHandlersWhere(handledBy, now),
          { emailCipher: { not: null }, processingRestrictedAt: null },
        ],
      });
    }
  });

  it("lets into the board's types exactly whoever could open them to every handler", () => {
    /*
     * Why the administrator without a seat is in: whoever holds
     * issues:configure can hand a type back to every handler, so the board's
     * scope is that holder and nobody else. Held for every combination of
     * roles, so a role that came to configure types without handling the
     * board's, or the other way round, fails here.
     */
    for (const roles of everyCombination()) {
      expect(capabilitiesFor(roles).has("issues:configure")).toBe(
        roles.isAdmin || roles.isBoardMember,
      );
    }
  });

  it("tightens an issue past its type and never loosens it", () => {
    expect(
      issueHandledBy({ boardOnly: true, type: { handledBy: "EVERY_HANDLER" } }),
    ).toBe("BOARD");
    expect(
      issueHandledBy({ boardOnly: false, type: { handledBy: "BOARD" } }),
    ).toBe("BOARD");
    expect(
      issueHandledBy({
        boardOnly: false,
        type: { handledBy: "EVERY_HANDLER" },
      }),
    ).toBe("EVERY_HANDLER");
  });

  it("keeps the issues and types the board holds from a reader it does not let in", () => {
    expect(issuesHandledWhere("BOARD")).toStrictEqual({});
    expect(issuesHandledWhere("EVERY_HANDLER")).toStrictEqual({
      boardOnly: false,
      type: { handledBy: "EVERY_HANDLER" },
    });
    expect(typesHandledWhere("BOARD")).toStrictEqual({});
    expect(typesHandledWhere("EVERY_HANDLER")).toStrictEqual({
      handledBy: "EVERY_HANDLER",
    });
  });
});
