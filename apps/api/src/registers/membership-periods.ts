/**
 * Reading the statutory member register (medlemsforteckning, EFL 5 kap. via
 * BRL 9 kap.) back out of its append-only archive.
 *
 * The archive is a log of events, not a list of members: an ENTRY when someone
 * becomes a member, an EXIT when they stop being one, and a CORRECTION when an
 * earlier row was wrong. Nothing in it is ever updated or deleted - the database
 * refuses both - so a mistake is fixed by writing a new row that supersedes the
 * old one. What the register extract has to show is the other thing: one line
 * per membership, with the date it began and the date it ended.
 *
 * Turning the first into the second is the whole of this file, and it is pure
 * on purpose. The archive is the one table in the product that cannot be
 * repaired by editing, so how it is read has to be exercised exhaustively
 * without a database in the way.
 */

export type MemberRegisterEventType = "ENTRY" | "EXIT" | "CORRECTION";

/**
 * The columns every function in this file reads.
 *
 * Which person the row is about, which event it is, the day it happened, the
 * instant it was written - the tiebreaker two events on one day are ordered by -
 * and the two identifiers the correction chain is followed through. Nothing
 * here reads the recorded name or address: a correction is matched to the row it
 * replaces by identifier, never by what either of them recorded.
 *
 * Split out of {@link MemberRegisterArchiveRow} so a caller that only has to
 * know who was a member on a day can select these six columns and no more. The
 * register holds the recorded name and postal address of everybody who has ever
 * been a member and is read whole to answer any question about it, so a
 * selection wider than the question needs carries that archive into the process
 * for nothing.
 */
export interface MemberRegisterEvent {
  id: string;
  personId: string;
  eventType: MemberRegisterEventType;
  eventOn: Date;
  /** Set on a CORRECTION: the row this one replaces. */
  correctsEntryId: string | null;
  createdAt: Date;
}

/** One row of the archive, as stored. */
export interface MemberRegisterArchiveRow extends MemberRegisterEvent {
  apartmentId: string | null;
  recordedFirstName: string;
  recordedLastName: string;
  recordedPostalStreet: string | null;
  recordedPostalCode: string | null;
  recordedPostalCity: string | null;
}

/**
 * An archive row after corrections have been applied: a CORRECTION carries the
 * event type of the row it replaced, because "corrected entry" is not a third
 * kind of membership event.
 *
 * Carries whatever columns the caller selected. The default is the whole stored
 * row, so a caller that reads the recorded name off a resolved event - the
 * register extract does - names nothing extra to get it.
 */
export type ResolvedRegisterEvent<
  Row extends MemberRegisterEvent = MemberRegisterArchiveRow,
> = Omit<Row, "eventType"> & {
  eventType: "ENTRY" | "EXIT";
  /** True when this row reached the register as a correction of an earlier one. */
  corrected: boolean;
};

/** One membership: when it began, when it ended, and what was recorded. */
export interface MembershipPeriod<
  Row extends MemberRegisterEvent = MemberRegisterArchiveRow,
> {
  personId: string;
  /**
   * Null only for an exit with no entry before it. The register still has to
   * show such a row: an exit the archive holds and the extract hides would be a
   * membership the cooperative cannot account for.
   */
  entry: ResolvedRegisterEvent<Row> | null;
  /** Null while the membership is current. */
  exit: ResolvedRegisterEvent<Row> | null;
}

/** Cycles cannot occur through the write path, but the read must not hang if one does. */
const MAX_CORRECTION_DEPTH = 32;

/**
 * Applies corrections: drops every row a later row supersedes, and gives each
 * surviving correction the event type of the row it replaced.
 *
 * A correction may itself be corrected, so the chain is followed rather than
 * looked at one link deep.
 */
export function resolveRegisterEvents<Row extends MemberRegisterEvent>(
  rows: readonly Row[],
): ResolvedRegisterEvent<Row>[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const superseded = new Set(
    rows
      .map((row) => row.correctsEntryId)
      .filter((id): id is string => id !== null),
  );

  const resolved: ResolvedRegisterEvent<Row>[] = [];
  for (const row of rows) {
    if (superseded.has(row.id)) {
      continue;
    }
    if (row.eventType !== "CORRECTION") {
      resolved.push(resolvedAs(row, row.eventType, false));
      continue;
    }

    const eventType = supersededEventType(row, byId);
    if (eventType === null) {
      // A correction of a row that is not in this archive says nothing about
      // when a membership began or ended, so it cannot become a line in the
      // extract. It stays in the archive, which is where the evidence lives.
      continue;
    }
    resolved.push(resolvedAs(row, eventType, true));
  }

  return resolved.sort(chronologically);
}

/**
 * One row with its resolved event type, keeping every other column the caller
 * selected.
 *
 * The assertion is here rather than at either call site because it is one fact
 * stated once: spreading a row of an unresolved generic shape and overriding
 * one of its properties is exactly {@link ResolvedRegisterEvent}, and the
 * compiler cannot see that through the type parameter.
 */
function resolvedAs<Row extends MemberRegisterEvent>(
  row: Row,
  eventType: "ENTRY" | "EXIT",
  corrected: boolean,
): ResolvedRegisterEvent<Row> {
  return { ...row, eventType, corrected } as ResolvedRegisterEvent<Row>;
}

function supersededEventType(
  correction: MemberRegisterEvent,
  byId: ReadonlyMap<string, MemberRegisterEvent>,
): "ENTRY" | "EXIT" | null {
  const seen = new Set<string>([correction.id]);
  let current = correction;

  for (let depth = 0; depth < MAX_CORRECTION_DEPTH; depth++) {
    const targetId = current.correctsEntryId;
    if (targetId === null || seen.has(targetId)) {
      return null;
    }
    const target = byId.get(targetId);
    if (target === undefined) {
      return null;
    }
    if (target.eventType !== "CORRECTION") {
      return target.eventType;
    }
    seen.add(targetId);
    current = target;
  }
  return null;
}

/**
 * Pairs the resolved events into membership periods, per person.
 *
 * Two readings are fixed here and both follow from the plan's rule that
 * membership is derived from member-residencies:
 *
 *   A second ENTRY while a membership is open is ignored. Someone who takes
 *   over a second apartment does not become a member twice, and treating it as
 *   a new membership would print two open lines for one person.
 *
 *   An EXIT with nothing open opens and closes a period of its own, so the row
 *   appears in the extract with an empty entry date rather than vanishing.
 */
export function membershipPeriods<Row extends MemberRegisterEvent>(
  events: readonly ResolvedRegisterEvent<Row>[],
): MembershipPeriod<Row>[] {
  const byPerson = new Map<string, ResolvedRegisterEvent<Row>[]>();
  for (const event of events) {
    const list = byPerson.get(event.personId);
    if (list === undefined) {
      byPerson.set(event.personId, [event]);
    } else {
      list.push(event);
    }
  }

  const periods: MembershipPeriod<Row>[] = [];
  for (const [personId, personEvents] of byPerson) {
    let open: ResolvedRegisterEvent<Row> | null = null;

    for (const event of [...personEvents].sort(chronologically)) {
      if (event.eventType === "ENTRY") {
        if (open === null) {
          open = event;
        }
        continue;
      }
      periods.push({ personId, entry: open, exit: event });
      open = null;
    }

    if (open !== null) {
      periods.push({ personId, entry: open, exit: null });
    }
  }

  return periods;
}

/** Whether a membership had not ended on the given day. */
export function isCurrentMembership<Row extends MemberRegisterEvent>(
  period: MembershipPeriod<Row>,
  today: Date,
): boolean {
  return (
    period.exit === null || period.exit.eventOn.getTime() > today.getTime()
  );
}

/**
 * The event whose recorded name and address describe an ended membership: the
 * exit if there is one, otherwise the entry.
 */
export function recordedAt<Row extends MemberRegisterEvent>(
  period: MembershipPeriod<Row>,
): ResolvedRegisterEvent<Row> | null {
  return period.exit ?? period.entry;
}

function chronologically(
  left: { eventOn: Date; createdAt: Date },
  right: { eventOn: Date; createdAt: Date },
): number {
  const byEventOn = left.eventOn.getTime() - right.eventOn.getTime();
  if (byEventOn !== 0) {
    return byEventOn;
  }
  // Two events on the same day are ordered by when they were written, so an
  // entry and an exit recorded on one day pair the way they happened.
  return left.createdAt.getTime() - right.createdAt.getTime();
}
