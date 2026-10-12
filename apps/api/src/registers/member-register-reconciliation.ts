import { Injectable } from "@nestjs/common";
import { formatDateColumn, localDayOfColumn } from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import { isResidencyHeldOn } from "./held-on";
import {
  type MemberRegisterEvent,
  resolveRegisterEvents,
} from "./membership-periods";
import {
  type MemberResidencySpan,
  type OwedMembershipEvent,
  readMemberResidencies,
} from "./membership-transitions";
import { lockResidencyTransitions } from "./residency-lock";

/**
 * Checking the member register against the tenant-ownerships it is derived
 * from, and appending what it is missing.
 *
 * Since the moves and the import write register rows by move date rather than
 * in the order moves are recorded, a register they write agrees with the
 * residencies. A register written before then may not: an import that listed a
 * person's apartment A [2010, 2015) before B [2012, -) wrote an EXIT in 2015
 * and no ENTRY for B, so the extract shows somebody who still holds B as having
 * left. This is the one-off repair for such registers.
 *
 * The register is append-only by law and by trigger, so a disagreement is
 * answered by a row and never by an edit. A wrong EXIT cannot be taken back;
 * an ENTRY on the same day is what makes the register read as a membership
 * that continued, which is the same answer the move flows give a move-in that
 * bridges an EXIT already written. A CORRECTION row would not help: it
 * re-dates or re-attributes the row it corrects and never removes it.
 *
 * Only what the residencies can speak for is compared. A register row dated
 * before the person's first MEMBER residency, and the register of a person
 * with no MEMBER residency at all, are reported as unverifiable and left as
 * they stand: an ENTRY in 2004 with no residency behind it is more likely
 * history the residencies never held than a membership that never was.
 */

/** A row appended because the register disagreed with the residencies. */
export const RECONCILIATION_NOTE =
  "Appended when the member register was checked against the tenant-ownerships held.";

/** What one person's register needs, as the comparison found it. */
export interface PersonReconciliation {
  personId: string;
  /** The rows that make the register read as the residencies do, in order. */
  owed: OwedMembershipEvent[];
  /**
   * Register rows the residencies cannot speak for: dated before the first
   * MEMBER residency, or held by a person with none.
   */
  unverifiableRows: number;
}

/**
 * The rows a register owes so that, from the person's first MEMBER residency
 * on, it reads as a member exactly on the days one is held.
 *
 * Walks every day on which a residency begins or ends or the register records
 * an event, keeping what the register reads on that day: the state its last
 * row on or before the day leaves, until a row appended here says otherwise.
 * An appended row is written after every row already dated that day, and the
 * register orders one day's rows by when they were written, so it settles the
 * day.
 */
export function reconcileMembership(
  register: readonly (MemberRegisterEvent & { apartmentId: string | null })[],
  residencies: readonly MemberResidencySpan[],
): Omit<PersonReconciliation, "personId"> {
  const events = resolveRegisterEvents(register);
  const firstHeld = residencies.reduce<number | null>(
    (earliest, span) =>
      earliest === null
        ? span.movedInOn.getTime()
        : Math.min(earliest, span.movedInOn.getTime()),
    null,
  );
  if (firstHeld === null) {
    return { owed: [], unverifiableRows: events.length };
  }

  const days = [
    ...new Set([
      ...residencies.flatMap((span) =>
        span.movedOutOn === null
          ? [span.movedInOn.getTime()]
          : [span.movedInOn.getTime(), span.movedOutOn.getTime()],
      ),
      ...events.map((event) => event.eventOn.getTime()),
    ]),
  ]
    .filter((time) => time >= firstHeld)
    .sort((left, right) => left - right);

  const owed: OwedMembershipEvent[] = [];
  let registered = false;
  const pending = [...events];
  for (const time of days) {
    // The register's own rows up to and including this day, in the order it
    // reads them; the last one on the day is what the day reads as.
    for (
      let event = pending.at(0);
      event !== undefined && event.eventOn.getTime() <= time;
      event = pending.at(0)
    ) {
      registered = event.eventType === "ENTRY";
      pending.shift();
    }

    const day = new Date(time);
    const held = residencies.some((span) =>
      isResidencyHeldOn(span, localDayOfColumn(day)),
    );
    if (held === registered) {
      continue;
    }
    owed.push({
      eventType: held ? "ENTRY" : "EXIT",
      eventOn: day,
      apartmentId: apartmentOf(residencies, day, held),
    });
    registered = held;
  }

  return {
    owed,
    unverifiableRows: events.filter(
      (event) => event.eventOn.getTime() < firstHeld,
    ).length,
  };
}

/**
 * The apartment an appended row names: for an ENTRY, one held that day,
 * preferring one whose residency begins on it; for an EXIT, the one whose
 * residency ended latest on or before the day, which is the tenant-ownership
 * the membership ended with.
 */
function apartmentOf(
  spans: readonly MemberResidencySpan[],
  day: Date,
  entry: boolean,
): string {
  const time = day.getTime();
  const localDay = localDayOfColumn(day);
  const match = entry
    ? (spans.find(
        (span) =>
          span.movedInOn.getTime() === time &&
          isResidencyHeldOn(span, localDay),
      ) ?? spans.find((span) => isResidencyHeldOn(span, localDay)))
    : spans
        .filter(
          (span) =>
            span.movedOutOn !== null && span.movedOutOn.getTime() <= time,
        )
        .sort(
          (left, right) =>
            (right.movedOutOn?.getTime() ?? 0) -
            (left.movedOutOn?.getTime() ?? 0),
        )[0];
  if (match === undefined) {
    // Unreachable: an ENTRY is owed only on a day a residency is held, and an
    // EXIT only on or after the first residency's move-in on a day none is
    // held, which means one has ended by then.
    throw new Error("A membership change with no residency behind it.");
  }
  return match.apartmentId;
}

/** What a whole run found, and what it wrote. */
export interface ReconciliationReport {
  /** Whether the rows were written, or only reported. */
  applied: boolean;
  /** People whose register was compared. */
  checked: number;
  /** People whose register disagreed, with the rows each one is owed. */
  disagreements: PersonReconciliation[];
  /** People with register rows the residencies cannot speak for. */
  unverifiable: { personId: string; rows: number }[];
}

/**
 * Runs the comparison over every person with a MEMBER residency or a register
 * row, one person at a time.
 *
 * Each person is read and, in apply mode, written in a transaction of their
 * own under their residency transition lock - the lock every move and import
 * takes before it reads a person's residencies to write register rows - so a
 * move recorded while this runs is either seen whole or waits. Running it again
 * finds nothing to append: the rows it wrote are what the comparison reads.
 */
@Injectable()
export class MemberRegisterReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param options.personIds Only these people, when given: for an operator
   *   checking one person before running the whole register, and for a test
   *   sharing its database with others.
   */
  async reconcile(options: {
    apply: boolean;
    personIds?: readonly string[];
  }): Promise<ReconciliationReport> {
    const people = await this.prisma.person.findMany({
      where: {
        ...(options.personIds === undefined
          ? {}
          : { id: { in: [...options.personIds] } }),
        OR: [
          { residencies: { some: { role: "MEMBER" } } },
          { memberRegisterEntries: { some: {} } },
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    const report: ReconciliationReport = {
      applied: options.apply,
      checked: 0,
      disagreements: [],
      unverifiable: [],
    };
    for (const { id: personId } of people) {
      const found = await this.prisma.$transaction(async (tx) => {
        await lockResidencyTransitions(tx, personId);

        const register = await tx.memberRegisterEntry.findMany({
          where: { personId },
          select: {
            id: true,
            personId: true,
            apartmentId: true,
            eventType: true,
            eventOn: true,
            correctsEntryId: true,
            createdAt: true,
          },
          orderBy: [{ eventOn: "asc" }, { createdAt: "asc" }],
        });
        const result = reconcileMembership(
          register,
          await readMemberResidencies(tx, personId),
        );

        if (options.apply && result.owed.length > 0) {
          const person = await tx.person.findUniqueOrThrow({
            where: { id: personId },
            select: {
              firstName: true,
              lastName: true,
              postalStreet: true,
              postalCode: true,
              postalCity: true,
            },
          });
          for (const event of result.owed) {
            await tx.memberRegisterEntry.create({
              data: {
                personId,
                apartmentId: event.apartmentId,
                eventType: event.eventType,
                eventOn: event.eventOn,
                recordedFirstName: person.firstName,
                recordedLastName: person.lastName,
                recordedPostalStreet: person.postalStreet,
                recordedPostalCode: person.postalCode,
                recordedPostalCity: person.postalCity,
                note: RECONCILIATION_NOTE,
              },
            });
          }
        }
        return result;
      });

      report.checked++;
      if (found.owed.length > 0) {
        report.disagreements.push({ personId, ...found });
      }
      if (found.unverifiableRows > 0) {
        report.unverifiable.push({ personId, rows: found.unverifiableRows });
      }
    }
    return report;
  }
}

/** One owed row as an operator reads it. */
export function describeOwed(event: OwedMembershipEvent): string {
  return `${event.eventType} ${formatDateColumn(event.eventOn)} apartment ${event.apartmentId}`;
}
