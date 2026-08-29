import type { ResolvedRegisterEvent } from "../registers/membership-periods";

/**
 * Which tenant-ownership a person held, when, and which lien notes were theirs.
 *
 * This exists for the data subject access report (registerutdrag, GDPR art.
 * 15). A lien note (pantnotering) is recorded against an apartment and carries
 * no person at all - only `apartmentId`, `notedOn` and `releasedOn` - so
 * answering "which of these is about the person asking" is an inference, and
 * the inference has to be made carefully or the report discloses somebody
 * else's finances.
 *
 * ## The asymmetry that decides every edge case
 *
 * GDPR art. 15(4): the copy provided to a data subject "shall not adversely
 * affect the rights and freedoms of others". A previous holder's pledge on this
 * person's report is a third party's financial position, disclosed on a
 * document the association hands over. A missing note is an omission the
 * association can correct on request.
 *
 * Those are not the same size of mistake, so where the archive cannot say
 * unambiguously that a note was about a tenant-ownership this person held, the
 * note is left out. Every rule below resolves that way.
 *
 * ## Why not the residency, and why not the membership period
 *
 * Not the residency: that is service-tier operational data, it covers residents
 * who hold nothing, and it is erased by the purge. A pledge is on the
 * tenant-ownership, so the membership decision is what says whose it was.
 *
 * Not `membershipPeriods` either, though it reads the same archive. That
 * function answers the register extract's question - one line per membership
 * per person - and it deliberately ignores a second ENTRY while a membership is
 * open, because taking a second apartment does not make somebody a member
 * twice. Here the apartment is the whole point, so the events are paired per
 * apartment instead. Corrections are still applied by `resolveRegisterEvents`,
 * which is the only correct way to read this archive.
 */

/** One period during which a person held one tenant-ownership. */
export interface HoldingPeriod {
  apartmentId: string;
  /** The day the membership decision gave them the tenant-ownership. */
  from: Date;
  /** Null while they still hold it. */
  until: Date | null;
}

/** A lien note, as much of it as the bounding needs. */
export interface DatedLienNote {
  apartmentId: string;
  notedOn: Date;
  releasedOn: Date | null;
}

/**
 * The apartments this person held, paired from the member register archive.
 *
 * Two rows are dropped rather than guessed at, both by the asymmetry above:
 *
 *   An event with no apartment. The register allows one - an entry can predate
 *   the apartment being recorded - but it cannot say which tenant-ownership was
 *   given, so nothing can be attributed to it.
 *
 *   An EXIT with no ENTRY before it. The register extract shows such a row on
 *   purpose, because a membership the cooperative cannot account for must still
 *   appear. Here it would mean an unbounded start, and a note from any year
 *   before the exit would qualify - including the previous holder's.
 *
 * A second ENTRY while the same apartment is already open is ignored: it is the
 * same holding, and treating it as a new one would only duplicate notes.
 */
export function holdingPeriods(
  events: readonly ResolvedRegisterEvent[],
): HoldingPeriod[] {
  const byApartment = new Map<string, ResolvedRegisterEvent[]>();
  for (const event of events) {
    if (event.apartmentId === null) {
      continue;
    }
    const list = byApartment.get(event.apartmentId);
    if (list === undefined) {
      byApartment.set(event.apartmentId, [event]);
    } else {
      list.push(event);
    }
  }

  const periods: HoldingPeriod[] = [];
  for (const [apartmentId, apartmentEvents] of byApartment) {
    let open: ResolvedRegisterEvent | null = null;

    for (const event of [...apartmentEvents].sort(chronologically)) {
      if (event.eventType === "ENTRY") {
        open ??= event;
        continue;
      }
      if (open !== null) {
        periods.push({ apartmentId, from: open.eventOn, until: event.eventOn });
        open = null;
      }
    }

    if (open !== null) {
      periods.push({ apartmentId, from: open.eventOn, until: null });
    }
  }

  return periods;
}

/**
 * The notes that stood against a tenant-ownership while this person held it.
 *
 * The test is an overlap of two periods, with both boundaries half-open, and
 * the half-openness is the whole safeguard rather than a detail:
 *
 *   A note released on the day the holding began belongs to whoever held the
 *   apartment before. Redeeming the pledge is how a transfer completes, so the
 *   release and the entry landing on one day is the ordinary case, not an edge
 *   one - and the creditor on it is the previous holder's.
 *
 *   A note recorded on the day a holding ended belongs to whoever took over,
 *   for the mirror reason: a new pledge on the transfer day is the buyer's.
 *
 * What remains is a note that stood against the apartment on some day this
 * person held it and neither party's transfer day. A note recorded before they
 * took the apartment is included when it was still open afterwards, because a
 * pledge that survived the transfer encumbered the tenant-ownership they then
 * owned - it is a fact about their property, whoever first recorded it. A note
 * released during their holding is included too, with its release date: that it
 * ended is part of the same fact, and dropping it would leave the report
 * silently thinner than the register.
 */
export function lienNotesDuringHolding<Note extends DatedLienNote>(
  notes: readonly Note[],
  periods: readonly HoldingPeriod[],
): Note[] {
  return notes.filter((note) =>
    periods.some((period) => {
      if (period.apartmentId !== note.apartmentId) {
        return false;
      }
      const startedBeforeItEnded =
        period.until === null ||
        note.notedOn.getTime() < period.until.getTime();
      const endedAfterItStarted =
        note.releasedOn === null ||
        note.releasedOn.getTime() > period.from.getTime();
      return startedBeforeItEnded && endedAfterItStarted;
    }),
  );
}

function chronologically(
  left: { eventOn: Date; createdAt: Date },
  right: { eventOn: Date; createdAt: Date },
): number {
  const byEventOn = left.eventOn.getTime() - right.eventOn.getTime();
  if (byEventOn !== 0) {
    return byEventOn;
  }
  // Two events on one day are ordered by when they were written, so an entry
  // and an exit recorded together pair the way they happened.
  return left.createdAt.getTime() - right.createdAt.getTime();
}
