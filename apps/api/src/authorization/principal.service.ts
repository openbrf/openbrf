import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import {
  capabilitiesFor,
  type Principal,
  type PrincipalRoles,
} from "./capabilities";

/**
 * Builds the acting principal from the register.
 *
 * Roles are derived on every request rather than cached on the account,
 * because they change without the account being touched: a board term ends, a
 * residency gets a move-out date, an admin grant is revoked. A stale copy would
 * keep granting access after the reason for it expired.
 */
@Injectable()
export class PrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  async forPerson(personId: string): Promise<Principal | null> {
    const now = new Date();

    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        systemRoles: { select: { role: true } },
        boardPositions: {
          where: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
          select: { position: true },
        },
        residencies: {
          where: { OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }] },
          select: { role: true },
        },
      },
    });

    if (person === null) {
      return null;
    }

    const systemRoles = new Set(person.systemRoles.map((entry) => entry.role));
    const roles: PrincipalRoles = {
      isAdmin: systemRoles.has("ADMIN"),
      isPropertyManager: systemRoles.has("PROPERTY_MANAGER"),
      isBoardMember: person.boardPositions.length > 0,
      isResident: person.residencies.length > 0,
      isMember: person.residencies.some((entry) => entry.role === "MEMBER"),
    };

    return {
      personId: person.id,
      ...roles,
      capabilities: capabilitiesFor(roles),
    };
  }

  /**
   * Whether this principal holds the given apartment, which is what entitles a
   * tenant-owner to their own apartment register entry (BRL 9 kap.) without
   * holding the board-wide apartmentRegister:read capability.
   */
  async holdsApartment(
    personId: string,
    apartmentId: string,
  ): Promise<boolean> {
    const now = new Date();
    const count = await this.prisma.residency.count({
      where: {
        personId,
        apartmentId,
        role: "MEMBER",
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
      },
    });
    return count > 0;
  }
}
