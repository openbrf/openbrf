import { Injectable } from "@nestjs/common";
import { localDayOf } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { residencyHeldOn } from "../registers/held-on";
import { handlesIssues } from "./issue-handlers";
import { IssueError } from "./issue.error";
import { type IssueApartmentView, toApartmentView } from "./issue.service";

/**
 * One resident a handler may name on an issue they open, as the picker shows
 * them: a name, or that the name is protected, and nothing else.
 *
 * Keyed by the residency rather than the person. The residency is what the
 * handler picks - this person, living in this apartment today - and it is what
 * `IssueService.open` takes back, so no person identifier leaves the picker at
 * all: not a protected resident's, which would let a handler tie them to their
 * apartment across reads, and not anybody else's, which the property manager,
 * who never reads the address book, has no use for.
 */
export type IssueResidentChoice =
  | { kind: "person"; residencyId: string; name: string }
  | { kind: "protected"; residencyId: string };

/**
 * The resident picker a handler names a resident from, on an issue they open
 * (decision 14, ADR 0054).
 *
 * Two reads and no search. The apartments of the house, by designation, and
 * then the residents of one of them living there today. There is no free-text
 * query and no read of former or future residents, so the picker answers the
 * question "who lives in 1501" and never "where does Rune live" or "who lived
 * here before": a handler without the address book, the property manager,
 * learns no more of the register than a list of names on a door would tell
 * them. The threat review over that is in ADR 0054.
 *
 * Not `addressBook:read`, which the property manager never holds (decision 11
 * of the product decision log). The routes sit under `issues:handle`, and each
 * read asks the database again whether the person asking handles issues today,
 * the question `IssueService` asks for every read of an issue: a seat that
 * ended or a grant taken back stops the picker on the next read, whatever the
 * request's roles said.
 */
@Injectable()
export class IssueResidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Every apartment of the house, as a handler picks one.
   *
   * Designations and addresses, which name nobody, so the read is not audited,
   * as the apartment binder's chooser is not. Empty for a person who does not
   * handle issues today.
   */
  async apartments(readerPersonId: string): Promise<IssueApartmentView[]> {
    if (!(await this.handles(readerPersonId))) {
      return [];
    }
    const apartments = await this.prisma.apartment.findMany({
      orderBy: [
        { address: { street: "asc" } },
        { address: { number: "asc" } },
        { number: "asc" },
        { id: "asc" },
      ],
      select: {
        id: true,
        number: true,
        address: { select: { street: true, number: true } },
      },
    });
    return apartments.map((apartment) => toApartmentView(apartment));
  }

  /**
   * The residents of one apartment today, named, with a protected resident's
   * name withheld (ADR 0056), each once.
   *
   * Today is the association's calendar day: a resident whose move-out date is
   * ahead still lives here and is listed, one who moves out today is not, and
   * one moving in later is not yet, as `residencyHeldOn` reads every residency.
   *
   * Audited, because it is the read that tells a handler who lives where. The
   * entry names the apartment and how many residents were listed, never who:
   * the log is append-only and outlives the residency. The answer and the
   * entry share a transaction, so a list served without its entry cannot
   * happen.
   *
   * An apartment that is not in the register, and a person who does not handle
   * issues today, get the same refusal and write no entry: nothing was
   * disclosed.
   */
  async residents(
    readerPersonId: string,
    apartmentId: string,
  ): Promise<IssueResidentChoice[]> {
    const apartment = (await this.handles(readerPersonId))
      ? await this.prisma.apartment.findUnique({
          where: { id: apartmentId },
          select: { id: true },
        })
      : null;
    if (apartment === null) {
      throw new IssueError("No such apartment.", "apartment-not-found");
    }

    const today = localDayOf(new Date());
    return this.audit.withAuditedRead(
      (listed: IssueResidentChoice[]) => ({
        action: "ISSUE_RESIDENTS_LISTED",
        channel: "WEB",
        actorPersonId: readerPersonId,
        targetKind: "apartment",
        targetId: apartment.id,
        context: { residents: listed.length },
      }),
      async (tx) => {
        const residencies = await tx.residency.findMany({
          where: { apartmentId: apartment.id, ...residencyHeldOn(today) },
          orderBy: [
            { person: { firstName: "asc" } },
            { person: { lastName: "asc" } },
            { movedInOn: "asc" },
            { id: "asc" },
          ],
          select: {
            id: true,
            personId: true,
            person: {
              select: {
                firstName: true,
                lastName: true,
                protectedPersonalData: true,
              },
            },
          },
        });

        // A person on two residencies of the apartment at once is one
        // resident, offered by the first.
        const seen = new Set<string>();
        const named: IssueResidentChoice[] = [];
        const shielded: IssueResidentChoice[] = [];
        for (const residency of residencies) {
          if (seen.has(residency.personId)) {
            continue;
          }
          seen.add(residency.personId);
          if (residency.person.protectedPersonalData) {
            shielded.push({ kind: "protected", residencyId: residency.id });
          } else {
            named.push({
              kind: "person",
              residencyId: residency.id,
              name: `${residency.person.firstName} ${residency.person.lastName}`.trim(),
            });
          }
        }
        /*
         * A protected resident after the named ones, in the order of their
         * residencies' identifiers, which say nothing. Left among the others,
         * their place in an alphabetical list would hint at the name the
         * entry withholds.
         */
        shielded.sort((a, b) => (a.residencyId < b.residencyId ? -1 : 1));
        return [...named, ...shielded];
      },
    );
  }

  /** Whether the person asking handles issues today, asked of the database. */
  private async handles(readerPersonId: string): Promise<boolean> {
    return handlesIssues(
      this.prisma,
      readerPersonId,
      "EVERY_HANDLER",
      new Date(),
    );
  }
}
