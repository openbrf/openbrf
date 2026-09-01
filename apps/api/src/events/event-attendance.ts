/**
 * Which occurrences somebody is standing on.
 *
 * The one question the series write path asks that the series itself cannot
 * answer. Editing a series is refused while it would move or drop an occurrence
 * people have signed up to - the same shape as the booking module's refusal to
 * reshape a resource somebody holds a booking of - and what makes an occurrence
 * held is a sign-up (anmalan).
 *
 * It is a function in a module of its own rather than a line inside the service
 * because it is the whole of the coupling between the two halves: the write path
 * collects the set of occurrences an edit would displace and refuses when the
 * answer is not empty, and this is the answer.
 *
 * ## A withdrawal does not hold a date
 *
 * The query counts sign-ups with no withdrawal date, and that is the rule rather
 * than an implementation detail. A withdrawal is a person saying they are not
 * coming; a refusal resting on one would mean a series nobody is attending could
 * never be reshaped or removed again, because the rows are never deleted. That
 * would turn a dated close into a permanent lock on the calendar, which is the
 * opposite of what recording the date instead of deleting the row is for.
 *
 * ## A called-off date is still held
 *
 * The set that is asked about includes occurrences the board has called off, and
 * a standing sign-up on one of them refuses the edit exactly as it would on any
 * other date. Nothing withdraws a sign-up when a date is called off: the row
 * stays with the date on it precisely because people may have signed up to it,
 * and calling a date off is a statement about the association's plan rather than
 * about who put their name down. So somebody who has not stood down is still
 * somebody the calendar says is expecting to be there, and an edit that moved
 * that date would move their sign-up onto a day they never chose - or, for a date
 * the new rule does not name at all, take it away without telling them.
 *
 * The way out is dated and deliberate rather than silent: the board leaves those
 * dates where they are, or withdraws the sign-ups on those people's behalf, which
 * is one recorded act per person.
 */

import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/** Either the root client or a transaction client, as the audit log takes. */
export type EventDbClient = PrismaService | Prisma.TransactionClient;

/**
 * The ids, out of those given, that somebody has a standing sign-up to.
 *
 * Runs on the client it is handed rather than on an injected one, so that the
 * series write path can ask it inside the transaction that is about to do the
 * writing, rather than across a check and a write that were two transactions.
 *
 * That is necessary and not sufficient, and the caller owes the other half. At
 * READ COMMITTED this read sees the snapshot it began with, so a sign-up that
 * committed while the board was saving the form would be invisible here and
 * still be moved or dropped by the write. What makes the answer decisive is the
 * caller having taken `lockOccurrencesSignups` over the same ids first: a claim
 * either lands before that lock and is counted, or waits for the commit and
 * finds the date already moved. Both callers do.
 *
 * `distinct` because the answer is a set of occurrence ids: a date nine people
 * have signed up to is one refusal and not nine.
 */
export async function occurrencesWithSignups(
  db: EventDbClient,
  occurrenceIds: readonly string[],
): Promise<Set<string>> {
  if (occurrenceIds.length === 0) {
    // Asked of nothing rather than asked with an empty list. An edit that only
    // corrects the wording displaces no date at all, which is the ordinary case,
    // and a query whose answer is known before it is sent is a round trip in
    // every one of those saves.
    return new Set<string>();
  }

  const rows = await db.eventSignup.findMany({
    where: { occurrenceId: { in: [...occurrenceIds] }, withdrawnAt: null },
    select: { occurrenceId: true },
    distinct: ["occurrenceId"],
  });
  return new Set(rows.map((row) => row.occurrenceId));
}
