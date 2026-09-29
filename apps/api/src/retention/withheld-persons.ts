import type { Prisma } from "../generated/prisma/client";

/**
 * The questions every purge in the product has to ask about a person before it
 * erases anything, kept in one file so the jobs cannot answer them differently.
 *
 * A legal hold suspends purging for one person (GDPR art. 17(3)), and so does a
 * restriction of processing - art. 18(2) permits the association to keep
 * storing the data and little else, which means the one thing it must not do is
 * erase it. The two arrive from opposite directions: a hold is the board
 * deciding it needs the data, a restriction is the person asking that it be
 * kept and left alone. Their effect on the purge is identical, so the purge
 * asks one question.
 *
 * The other direction is the erasure request: a person the board has granted
 * erasure to is purged on the next run whatever their retention window says.
 * That is the whole of what "brings the purge forward" means - the same job
 * erases the same data, only sooner. It brings it forward only where nothing
 * refuses: a hold or restriction, a seat on the board, a system role or a
 * residency held today. Every job that erases on a request, and the person
 * panel that promises the erasure, asks that one question.
 *
 * All take a client rather than a service, so a purge can call them on its own
 * transaction and get the answer that is true inside it.
 */

interface PersonClient {
  person: {
    findMany(args: {
      where: Prisma.PersonWhereInput;
      select: { id: true };
    }): Promise<{ id: string }[]>;
  };
}

/**
 * What makes a person withheld from every purge: a standing legal hold, or a
 * standing restriction.
 *
 * Not "and": either one alone is enough, and a person can be under both for
 * unrelated reasons - a dispute the board is defending and a request the person
 * made about something else. One predicate for both questions below, so the
 * list and the single answer cannot come to disagree.
 */
const WITHHELD: Prisma.PersonWhereInput = {
  OR: [
    { legalHolds: { some: { releasedAt: null } } },
    { processingRestrictedAt: { not: null } },
  ],
};

/** People no purge may touch. */
export async function withheldPersonIds(
  client: PersonClient,
): Promise<string[]> {
  const persons = await client.person.findMany({
    where: WITHHELD,
    select: { id: true },
  });

  return persons.map((person) => person.id);
}

/**
 * Whether one person is withheld, as the purge that is about to erase their
 * rows asks it.
 *
 * Asked on the purge's own transaction and after it has taken the person's
 * legal hold key (`legal-hold-lock.ts`), which the hold placement and the
 * restriction grant both take before they write. Read under that key, the
 * answer cannot change before the transaction commits; read without it, a hold
 * committed a moment later loses the rows it was placed to keep.
 */
export async function isPersonWithheld(
  client: PersonClient,
  personId: string,
): Promise<boolean> {
  const persons = await client.person.findMany({
    where: { id: personId, ...WITHHELD },
    select: { id: true },
  });

  return persons.length > 0;
}

/**
 * Whether anybody in a set of people is withheld, for the purge whose rows
 * lead back to more than one of them - an apartment's charges and fees are
 * read through everybody who has ever lived there.
 *
 * Asked under the same conditions as {@link isPersonWithheld}: on the purge's
 * own transaction, after it has taken the legal hold key of every person in
 * the set.
 */
export async function isAnyPersonWithheld(
  client: PersonClient,
  personIds: readonly string[],
): Promise<boolean> {
  if (personIds.length === 0) {
    return false;
  }
  const persons = await client.person.findMany({
    where: { id: { in: [...personIds] }, ...WITHHELD },
    select: { id: true },
  });

  return persons.length > 0;
}

/**
 * A granted erasure request the purge has not yet carried out.
 *
 * Three conditions and each is load-bearing. Granted, because a request the
 * board has not decided is not authority to erase anything. Not executed,
 * because a request already carried out must not select the person a second
 * time on a later night. Not closed, because a request withdrawn or overtaken -
 * by the person moving back in, say - has stopped being an instruction.
 */
const GRANTED_ERASURE = {
  kind: "ERASURE",
  decision: "GRANTED",
  executedAt: null,
  closedAt: null,
} as const satisfies Prisma.DataSubjectRequestWhereInput;

/**
 * Nothing stands in the way of carrying out a granted erasure at this moment.
 *
 * The request brings the purge forward and lifts the retention window; it lifts
 * nothing else. So a person under a hold or a restriction, one who sits on the
 * board, holds a system role or still lives here is not erased because they
 * asked - the same five refusals the service-data purge applies before it
 * closes the request (`purge.service.ts`, `purgeRefusal`).
 *
 * Every job that erases on a request asks this and not merely whether a
 * request stands. Otherwise the domain jobs would erase a person the closing
 * job then refuses, and the request would be logged as blocked - ADR 0016's
 * word for an erasure that has not started - after the bookings, messages and
 * motions of a sitting board member had gone. A person refused here stays on
 * each domain's own retention window.
 *
 * Seats and residencies are compared with the instant the way the closing job
 * compares them, so the two cannot disagree about the day a term or a
 * residency ends.
 */
function nothingRefusesErasure(now: Date): Prisma.PersonWhereInput {
  return {
    NOT: WITHHELD,
    residencies: {
      none: { OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }] },
    },
    boardPositions: {
      none: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
    },
    systemRoles: { none: {} },
  };
}

/**
 * People whose erasure the board has granted, the purge has not yet carried
 * out, and nothing stops it carrying out now.
 *
 * What every job that erases on a request selects on. {@link
 * grantedErasurePersonIds} is the wider list, for the account of requests left
 * open.
 */
export async function erasureRequestedPersonIds(
  client: PersonClient,
  now: Date,
): Promise<string[]> {
  const persons = await client.person.findMany({
    where: {
      dataSubjectRequests: { some: GRANTED_ERASURE },
      ...nothingRefusesErasure(now),
    },
    select: { id: true },
  });

  return persons.map((person) => person.id);
}

interface RequestClient {
  dataSubjectRequest: {
    findFirst(args: {
      where: Prisma.DataSubjectRequestWhereInput;
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/**
 * Whether one person's granted erasure may be carried out now, as the job
 * about to erase their rows asks it.
 *
 * Asked on the job's own transaction after it has taken the person's legal
 * hold key, for the reason {@link isPersonWithheld} gives.
 */
export async function isErasureInForce(
  client: RequestClient,
  personId: string,
  now: Date,
): Promise<boolean> {
  const request = await client.dataSubjectRequest.findFirst({
    where: { personId, ...GRANTED_ERASURE, person: nothingRefusesErasure(now) },
    select: { id: true },
  });

  return request !== null;
}

/**
 * Everybody with a granted erasure request still open, whether or not anything
 * stands in its way - the list the service-data purge accounts for at the end
 * of a run, saying why each request is still open.
 */
export async function grantedErasurePersonIds(
  client: PersonClient,
): Promise<string[]> {
  const persons = await client.person.findMany({
    where: { dataSubjectRequests: { some: GRANTED_ERASURE } },
    select: { id: true },
  });

  return persons.map((person) => person.id);
}
