import type { Prisma } from "../generated/prisma/client";

/**
 * The two questions every purge in the product has to ask about a person before
 * it erases anything, kept in one file so five jobs cannot answer them
 * differently.
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
 * erases the same data, only sooner.
 *
 * Both take a client rather than a service, so a purge can call them on its own
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
 * People whose erasure the board has granted and the purge has not yet carried
 * out.
 *
 * Three conditions and each is load-bearing. Granted, because a request the
 * board has not decided is not authority to erase anything. Not executed,
 * because a request already carried out must not select the person a second
 * time on a later night. Not closed, because a request withdrawn or overtaken -
 * by the person moving back in, say - has stopped being an instruction.
 *
 * A restriction still wins over this: a person who asked for erasure and later
 * for a restriction is in both lists, and the purge reads the withheld list
 * too.
 */
export async function erasureRequestedPersonIds(
  client: PersonClient,
): Promise<string[]> {
  const persons = await client.person.findMany({
    where: {
      dataSubjectRequests: {
        some: {
          kind: "ERASURE",
          decision: "GRANTED",
          executedAt: null,
          closedAt: null,
        },
      },
    },
    select: { id: true },
  });

  return persons.map((person) => person.id);
}
