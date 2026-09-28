import { addLocalDays, dateColumnOf, localDayOfColumn } from "@openbrf/shared";

import type { Prisma } from "../generated/prisma/client";
import { isResidencyHeldOn } from "./held-on";

/**
 * What the member register owes a person when their tenant-ownerships change.
 *
 * Membership is derived: a person is a member on every day they hold at least
 * one `MEMBER` residency, so it begins on the first day one is held after a day
 * none was, and ends on the first day none is held after a day one was. The
 * register records exactly those days, as ENTRY and EXIT rows, and refuses to
 * have a row updated or removed.
 *
 * Moves are not recorded in the order they happen. A buyer is entered before
 * they take over, a move-in is back-dated, a file lists a person's newest
 * apartment first. So whether a change begins or ends a membership cannot be
 * read off the other residencies' move-out dates alone: a residency that has
 * not ended by a day but had not begun on it held nothing that day. Counting it
 * dropped the ENTRY of a back-dated move-in, and let two move-outs recorded
 * against their date order each see the other apartment as still held, so the
 * EXIT was never written at all.
 *
 * The answer is worked out from the person's `MEMBER` residencies as they were
 * before the change and as they are after it, day by day, and is the rows that
 * make the register read as the second where it read as the first. Only the
 * days the change moved are touched, so a register the change did not reach is
 * left as it stands - including history whose residencies have since been
 * purged, which the residencies can no longer speak for.
 *
 * Shared by the move flows and the import, which are two paths into one
 * register: two copies of this rule are how the two would come to disagree.
 */

/** One `MEMBER` residency, as far as membership reads it. */
export interface MemberResidencySpan {
  apartmentId: string;
  movedInOn: Date;
  movedOutOn: Date | null;
}

/** One register row a change owes. */
export interface OwedMembershipEvent {
  eventType: "ENTRY" | "EXIT";
  eventOn: Date;
  /** The apartment whose residency begins or ends the membership that day. */
  apartmentId: string;
}

/**
 * The rows that turn the register of `before` into the register of `after`.
 *
 * Walks every day on which either set of residencies begins or ends one, and
 * keeps track of what the register reads on that day: the membership `before`
 * held, as its own ENTRY and EXIT rows left it, until a row appended here says
 * otherwise. Wherever that differs from what `after` holds, a row is owed.
 *
 * An appended row is written after every row already dated that day, and the
 * register orders one day's rows by when they were written, so it is the one
 * that settles the day. Two readings follow:
 *
 *   A move-in that bridges into a later membership needs no ENTRY at that
 *   membership's start: the register reads a second ENTRY while one is open as
 *   nothing.
 *
 *   A move-in that bridges over an EXIT already written is answered by an ENTRY
 *   on the EXIT's own day, because the EXIT cannot be taken back. The register
 *   then shows two memberships meeting on that day, which is true of every day
 *   in them.
 */
export function owedMembershipEvents(
  before: readonly MemberResidencySpan[],
  after: readonly MemberResidencySpan[],
): OwedMembershipEvent[] {
  const days = [
    ...new Set(
      [...before, ...after].flatMap((span) =>
        span.movedOutOn === null
          ? [span.movedInOn.getTime()]
          : [span.movedInOn.getTime(), span.movedOutOn.getTime()],
      ),
    ),
  ].sort((left, right) => left - right);

  const owed: OwedMembershipEvent[] = [];
  let registered = false;

  for (const time of days) {
    const day = new Date(time);
    const heldBefore = heldOn(before, day);
    // The register's own row for this day, if `before` wrote one: its
    // membership begins or ends here exactly when the day before read
    // differently.
    if (heldBefore !== heldOn(before, dayBefore(day))) {
      registered = heldBefore;
    }

    const held = heldOn(after, day);
    if (held === registered) {
      continue;
    }
    owed.push({
      eventType: held ? "ENTRY" : "EXIT",
      eventOn: day,
      apartmentId: apartmentOf(after, day, held),
    });
    registered = held;
  }

  return owed;
}

/**
 * The person's `MEMBER` residencies, read inside the transaction that is about
 * to change them. The caller holds the person's transition lock
 * (lockResidencyTransitions), or what it reads is stale by the time it writes.
 */
export async function readMemberResidencies(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<MemberResidencySpan[]> {
  return tx.residency.findMany({
    where: { personId, role: "MEMBER" },
    select: { apartmentId: true, movedInOn: true, movedOutOn: true },
  });
}

/**
 * Appends the rows a change owes the register.
 *
 * Called after the residency write, in the same transaction and under the same
 * lock, with what {@link readMemberResidencies} returned before it. Each row
 * records the person's name and postal address as they stand now: the register
 * states who was a member, as the association knew them when it wrote the row.
 */
export async function appendOwedMembershipEvents(
  tx: Prisma.TransactionClient,
  personId: string,
  before: readonly MemberResidencySpan[],
): Promise<OwedMembershipEvent[]> {
  const owed = owedMembershipEvents(
    before,
    await readMemberResidencies(tx, personId),
  );
  if (owed.length === 0) {
    return owed;
  }

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
  for (const event of owed) {
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
      },
    });
  }
  return owed;
}

function heldOn(spans: readonly MemberResidencySpan[], day: Date): boolean {
  const localDay = localDayOfColumn(day);
  return spans.some((span) => isResidencyHeldOn(span, localDay));
}

function dayBefore(day: Date): Date {
  return dateColumnOf(addLocalDays(localDayOfColumn(day), -1));
}

/**
 * The apartment a row names: for an ENTRY, one held that day, preferring one
 * whose residency begins on it; for an EXIT, one whose residency ended on it.
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
    : spans.find((span) => span.movedOutOn?.getTime() === time);
  if (match === undefined) {
    // Unreachable: a day is only owed a row when `after` begins or ends a
    // membership on it, and whichever residency does that is in `after`.
    throw new Error("A membership change with no residency behind it.");
  }
  return match.apartmentId;
}
