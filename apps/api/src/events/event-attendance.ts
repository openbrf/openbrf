/**
 * Which occurrences somebody is standing on.
 *
 * The one question the series write path asks that this module cannot answer
 * yet. Editing a series is refused while it would move or drop an occurrence
 * people have signed up to - the same shape as the booking module's refusal to
 * reshape a resource somebody holds a booking of - and what makes an occurrence
 * held is a sign-up (anmalan), which is a table this change does not create.
 *
 * It is a function in a module of its own rather than a line inside the service
 * so that adding sign-ups is a change to one query and to nothing else. The
 * service already asks the question, already collects the set of occurrences an
 * edit would displace, and already refuses when the answer is not empty; what
 * arrives with the sign-up table is the answer.
 *
 * The set that is asked about includes occurrences the board has called off. A
 * called-off date can still carry the rows of people who had signed up before
 * it was called off, and whether those hold the date is a rule for the sign-up
 * module to state - the question here is only which ids somebody is standing on.
 */

import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/** Either the root client or a transaction client, as the audit log takes. */
export type EventDbClient = PrismaService | Prisma.TransactionClient;

/**
 * The ids, out of those given, that somebody has signed up to.
 *
 * Empty for every input, because no sign-up exists: the table arrives with the
 * sign-up endpoint. The query that replaces this body is
 *
 *     const rows = await db.eventSignup.findMany({
 *       where: { occurrenceId: { in: [...occurrenceIds] }, withdrawnAt: null },
 *       select: { occurrenceId: true },
 *       distinct: ["occurrenceId"],
 *     });
 *     return new Set(rows.map((row) => row.occurrenceId));
 *
 * and it has to run on the client it is handed, inside the caller's
 * transaction, so that a sign-up taken while a series is being edited either
 * loses the race or refuses the edit rather than slipping between the check and
 * the write.
 */
export async function occurrencesWithSignups(
  db: EventDbClient,
  occurrenceIds: readonly string[],
): Promise<Set<string>> {
  // Both parameters are the signature the query above needs and the reason it
  // is worth keeping: renaming them for the sake of an unused-argument rule
  // would leave the replacement having to rename them back.
  void db;
  void occurrenceIds;
  return new Set<string>();
}
