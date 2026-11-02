import type { Prisma } from "../generated/prisma/client";

/**
 * What keeps a person in the register while it stands, whatever they asked for
 * and however long ago they moved out: a role the association gave them that
 * has not ended.
 *
 * A board seat that has not ended, and a system role. Neither is a residency,
 * and neither depends on one: an external board member and an administrator
 * who never lived here are kept by them as much as a resident is. A legal hold
 * and a restriction keep a person too, but for another reason - somebody asked
 * for the data to be kept - and they also stop the other purges, so they are
 * answered in `withheld-persons.ts`. A residency is the retention period's
 * anchor as well as a tie, so each place reads it on its own terms: today for
 * an erasure request, the retention cutoff for the scheduled purge.
 *
 * One definition for the five places that decide whether a person is kept:
 * `DataSubjectRequestService.assertErasable`, which declines to record a
 * grant; `purgeRefusal`, which the service-data purge asks with the rows
 * locked; `computePersonPurgeDate`, which the person's page shows; the
 * scheduled purge's scan in `purge.service.ts`; and `nothingRefusesErasure`,
 * which every job that erases on a request selects on. Written out in each,
 * they could come to disagree, and a tie one of them missed would be a person
 * erased whom the others keep. A new kind of tie is added here, with its lock
 * in `erasure-lock.ts`, and all five ask it.
 */
export type StandingTie = "board-position-current" | "system-role-current";

/** What a person's row has to answer for {@link standingTie}. */
export interface StandingTieFacts {
  /** Every seat, ended or not, or only those not ended: either answers. */
  boardPositions: readonly { endedOn: Date | null }[];
  /** Granted system roles. */
  systemRoles: readonly unknown[];
}

/** The fields of a person {@link standingTie} reads. */
export const STANDING_TIE_SELECT = {
  boardPositions: { select: { endedOn: true } },
  systemRoles: { select: { role: true } },
} as const satisfies Prisma.PersonSelect;

/**
 * The tie that keeps this person at this instant, or null where none does.
 *
 * A seat is held until the instant it ends, compared the way the queries below
 * compare it, so the check on the rows and the scan cannot disagree about the
 * day a term ends. A seat recorded from a day to come keeps the person as much
 * as one held today.
 */
export function standingTie(
  person: StandingTieFacts,
  now: Date,
): StandingTie | null {
  if (
    person.boardPositions.some(
      (position) =>
        position.endedOn === null || position.endedOn.getTime() > now.getTime(),
    )
  ) {
    return "board-position-current";
  }
  if (person.systemRoles.length > 0) {
    return "system-role-current";
  }
  return null;
}

/** {@link standingTie} as a query: the person holds no tie at this instant. */
export function holdsNoStandingTie(now: Date): Prisma.PersonWhereInput {
  return {
    boardPositions: {
      none: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
    },
    systemRoles: { none: {} },
  };
}
