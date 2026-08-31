import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { SystemRoleType } from "../generated/prisma/enums";
import {
  RoleChangeError,
  revokingWouldLeaveNoAdministrator,
  type SystemRoleGrantsView,
} from "./role-changes";
import { lockSystemRole } from "./role-lock";

export interface SetSystemRoleInput {
  personId: string;
  role: SystemRoleType;
  /** True grants the role, false revokes it. */
  granted: boolean;
  actorPersonId: string;
}

/**
 * The two system roles: the administrator grant, and the external property
 * manager grant.
 *
 * A grant is a fact about today rather than a period, which is what makes this
 * different from a board seat and from a publication consent: a role that was
 * held and is not any more grants nothing, and the record that it was held once
 * is the audit log's job. So a revoke removes the row, and the two entries -
 * SYSTEM_ROLE_GRANTED and SYSTEM_ROLE_REVOKED, both written in the transaction
 * that made the change - are what remain to say who held what and between when.
 * The audit log cannot be rewritten, which is why that history can live there
 * and does not need a second copy in a table that can.
 *
 * A change that changes nothing writes nothing. Granting a role that is already
 * held, or revoking one that is not, is answered with the state as it is:
 * padding the audit log with entries corresponding to no act would make the
 * entries that do harder to find, and would put dates in the record that nobody
 * chose. That is the same rule the protected personal data flag and the
 * publication consents follow.
 *
 * The last administrator cannot be revoked. See
 * {@link revokingWouldLeaveNoAdministrator} for what that guards against.
 */
@Injectable()
export class SystemRoleService {
  private readonly logger = new Logger(SystemRoleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** The roles this person holds today. */
  async forPerson(personId: string): Promise<SystemRoleGrantsView> {
    const rows = await this.prisma.systemRole.findMany({
      where: { personId },
      select: { role: true },
      orderBy: [{ role: "asc" }],
    });
    return { personId, roles: rows.map((row) => row.role) };
  }

  /**
   * Grants or revokes one system role.
   *
   * The whole decision happens in one transaction, under a lock on the role
   * being changed: the administrators counted for the lockout guard are the
   * administrators the write is about to change, and a count read outside the
   * lock is a count another revoke is free to invalidate.
   */
  async setRole(input: SetSystemRoleInput): Promise<SystemRoleGrantsView> {
    return this.prisma.$transaction(async (tx) => {
      await lockSystemRole(tx, input.role);

      const person = await tx.person.findUnique({
        where: { id: input.personId },
        select: { id: true },
      });
      if (person === null) {
        throw new RoleChangeError("No such person.", "person-not-found");
      }

      const holders = await tx.systemRole.findMany({
        where: { role: input.role },
        select: { personId: true },
      });
      const heldByTarget = holders.some(
        (holder) => holder.personId === input.personId,
      );

      if (input.granted) {
        if (heldByTarget) {
          return this.rolesOf(tx, input.personId);
        }

        await tx.systemRole.create({
          data: { personId: input.personId, role: input.role },
        });
        await this.audit.record(
          {
            action: "SYSTEM_ROLE_GRANTED",
            actorPersonId: input.actorPersonId,
            targetPersonId: input.personId,
            context: { role: input.role },
          },
          tx,
        );

        this.logger.log(
          `Granted ${input.role} to person ${input.personId} by ${input.actorPersonId}`,
        );
        return this.rolesOf(tx, input.personId);
      }

      if (!heldByTarget) {
        return this.rolesOf(tx, input.personId);
      }

      /*
       * The lockout guard, and the one place it is enforced.
       *
       * It covers an administrator revoking their own grant, which is the way
       * an instance actually loses its last one: somebody tidying up their own
       * account rather than somebody removing a colleague. The rule does not
       * care which of the two it is - the question is whether an administrator
       * would be left, and the actor's own id is in the list it is asked
       * against.
       */
      if (
        revokingWouldLeaveNoAdministrator({
          role: input.role,
          administratorPersonIds: holders.map((holder) => holder.personId),
          targetPersonId: input.personId,
        })
      ) {
        throw new RoleChangeError(
          "This is the instance's last administrator. Grant the role to " +
            "somebody else before revoking it, or the instance is left with " +
            "no way back in.",
          "last-administrator",
        );
      }

      const removed = await tx.systemRole.deleteMany({
        where: { personId: input.personId, role: input.role },
      });
      if (removed.count === 0) {
        // Another revoke committed between the read and the write. It recorded
        // the act; this call changed nothing, so by the rule above it writes
        // nothing and answers with the state as it is.
        return this.rolesOf(tx, input.personId);
      }

      await this.audit.record(
        {
          action: "SYSTEM_ROLE_REVOKED",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          context: { role: input.role },
        },
        tx,
      );

      this.logger.log(
        `Revoked ${input.role} from person ${input.personId} by ${input.actorPersonId}`,
      );
      return this.rolesOf(tx, input.personId);
    });
  }

  /** Read inside the transaction, so the answer is the state it just wrote. */
  private async rolesOf(
    tx: Prisma.TransactionClient,
    personId: string,
  ): Promise<SystemRoleGrantsView> {
    const rows = await tx.systemRole.findMany({
      where: { personId },
      select: { role: true },
      orderBy: [{ role: "asc" }],
    });
    return { personId, roles: rows.map((row) => row.role) };
  }
}
