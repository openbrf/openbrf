import { Injectable, Logger } from "@nestjs/common";
import { ISSUE_CONCERNED_PERSON_LIMIT, localDayOf } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { residencyHeldOn } from "../registers/held-on";
import {
  requireHandledIssue,
  requireHandledIssueForWrite,
} from "./issue-handlers";
import {
  HOUSEHOLD_PROTECTION_TRANSACTION,
  lockHouseholdProtection,
  lockIssueForHandling,
} from "./issue-lock";
import { IssueError } from "./issue.error";
import { revokeLinksOfProtectedHousehold } from "./work-order-link";

/**
 * One person an issue concerns, as a handler reads the list: a name, or that
 * the name is protected (ADR 0056), and nothing else.
 *
 * Keyed by the record rather than the person, as the resident picker keys a
 * resident by the residency: the record is what a handler removes, and no
 * person identifier leaves the list at all, so a protected person cannot be
 * tied to their identifier across reads. No apartment either: the picker the
 * handler chose them from said where they live, and the list is of whom the
 * case is about, not where.
 */
export type IssueConcernedPersonView =
  | { kind: "person"; id: string; name: string }
  | { kind: "protected"; id: string };

/**
 * The people an issue concerns (berörd person, ADR 0057): the neighbour a
 * disturbance report is about, the household a leak came from. A handler
 * records them on an issue of any type, from the resident picker
 * (`IssueResidentsService`), so the property manager, who never reads the
 * address book, names nobody the picker would not show them on a door.
 *
 * The record is personal data of its own, about the person named, and part of
 * the issue's free-text layer (`issue-free-text.ts`): it goes when the text
 * goes, by the clock or the reporter's granted erasure request, and a hold on
 * the issue or a hold or a restriction on its reporter or on any person it
 * concerns keeps it, as it keeps the text (`issue-concerned-persons.ts`). A
 * handler takes one off as a redaction (`IssueRedactionService`), under the
 * same refusals.
 *
 * Read by the handlers the issue lets in and by nobody else. The reporter's
 * own view, the private link, every mail, a work order and the contractor's
 * link carry none of it, and nothing on `mcp` or `ai` reads it (ADR 0056); an
 * issue concerning a person with protected personal data is left out of those
 * reads altogether, as one such a person reported is, and a contractor's link
 * to it ends (`showsProtectedHousehold`).
 *
 * Recording one is audited as `ISSUE_CONCERNED_PERSON_ADDED`, with the handler
 * as its actor and the record's identifier, and never the person: the log is
 * exempt from every purge, so an entry naming them would keep the record of
 * who a case of a disturbance was about for good, after the clock had removed
 * the record itself.
 */
@Injectable()
export class IssueConcernedPersonService {
  private readonly logger = new Logger(IssueConcernedPersonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Whom an issue the reader handles concerns, oldest record first. Not
   * audited, as reading the issue is not: it names people on a case the
   * reader already reads, never where anybody lives.
   */
  async list(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueConcernedPersonView[]> {
    await requireHandledIssue(this.prisma, issueId, readerPersonId, {
      id: true,
    });
    return this.read(this.prisma, issueId);
  }

  /**
   * Records the resident living in a residency today as a person the issue
   * concerns, and answers the list as it then stands. A person already on it
   * is answered as recorded, and nothing is written or logged.
   *
   * Under the locks a handling write takes, and then the household
   * protection's, which a person being marked protected takes too: a protected
   * person recorded here ends the issue's contractor links in this
   * transaction, and one marked protected while this waits is read as
   * protected once it has the lock (`lockHouseholdProtection`).
   */
  async add(
    handlerPersonId: string,
    issueId: string,
    residencyId: string,
  ): Promise<IssueConcernedPersonView[]> {
    let recordedId: string | null = null;
    const list = await this.prisma.$transaction(async (tx) => {
      recordedId = null;
      await lockIssueForHandling(tx, issueId);
      // After the lock wait: one instant for the writer's role and scope.
      const now = new Date();
      await requireHandledIssueForWrite(
        tx,
        issueId,
        handlerPersonId,
        { id: true },
        now,
      );

      const resident = await tx.residency.findFirst({
        where: { id: residencyId, ...residencyHeldOn(localDayOf(now)) },
        select: { personId: true },
      });
      if (resident === null) {
        throw new IssueError("No such resident.", "resident-not-found");
      }

      const recorded = await tx.issueConcernedPerson.findMany({
        where: { issueId },
        select: { personId: true },
      });
      if (recorded.some((row) => row.personId === resident.personId)) {
        return this.read(tx, issueId);
      }
      if (recorded.length >= ISSUE_CONCERNED_PERSON_LIMIT) {
        throw new IssueError(
          "This issue already names as many people as it may.",
          "too-many-concerned-persons",
        );
      }

      const row = await tx.issueConcernedPerson.create({
        data: { issueId, personId: resident.personId },
        select: { id: true },
      });
      recordedId = row.id;

      await lockHouseholdProtection(tx);
      const person = await tx.person.findUnique({
        where: { id: resident.personId },
        select: { protectedPersonalData: true },
      });
      if (person?.protectedPersonalData === true) {
        await revokeLinksOfProtectedHousehold(tx, this.audit, {
          personId: resident.personId,
          actorPersonId: handlerPersonId,
          channel: "WEB",
        });
      }

      await this.audit.record(
        {
          action: "ISSUE_CONCERNED_PERSON_ADDED",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          // The record and nothing about whom it names: the log outlives it.
          context: { id: row.id },
        },
        tx,
      );
      return this.read(tx, issueId);
    }, HOUSEHOLD_PROTECTION_TRANSACTION);

    if (recordedId !== null) {
      this.logger.log(`Issue ${issueId} recorded a person it concerns`);
    }
    return list;
  }

  private async read(
    db: Prisma.TransactionClient | PrismaService,
    issueId: string,
  ): Promise<IssueConcernedPersonView[]> {
    const rows = await db.issueConcernedPerson.findMany({
      where: { issueId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        person: {
          select: {
            firstName: true,
            lastName: true,
            protectedPersonalData: true,
          },
        },
      },
    });
    return rows.map((row) =>
      row.person.protectedPersonalData
        ? { kind: "protected", id: row.id }
        : {
            kind: "person",
            id: row.id,
            name: `${row.person.firstName} ${row.person.lastName}`.trim(),
          },
    );
  }
}
