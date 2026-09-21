import { Injectable } from "@nestjs/common";
import { localDayOf } from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import { boardSeatHeldOn, residencyHeldOn } from "../registers/held-on";
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
 *
 * A residency or a seat counts on the days it is held, which is decided on the
 * association's calendar by `registers/held-on.ts`: from its first day, so a
 * move-in or an election recorded ahead of time grants nothing until the day
 * arrives, and up to the day before its end date.
 */
@Injectable()
export class PrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  async forPerson(personId: string): Promise<Principal | null> {
    const today = localDayOf(new Date());

    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        systemRoles: { select: { role: true } },
        boardPositions: {
          where: boardSeatHeldOn(today),
          select: { position: true },
        },
        residencies: {
          where: residencyHeldOn(today),
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
    const count = await this.prisma.residency.count({
      where: {
        personId,
        apartmentId,
        role: "MEMBER",
        ...residencyHeldOn(localDayOf(new Date())),
      },
    });
    return count > 0;
  }
}
