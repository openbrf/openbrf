import type { Prisma } from "../generated/prisma/client";

/**
 * The series' row, taken for update before anything about the series is read.
 *
 * Every writer of a series takes it first - an edit, a removal, a publication,
 * and a call-off or reinstatement of one of its dates - so each reads the
 * series after any other has finished. Without it a decision made from a read
 * another writer has since overtaken lands anyway:
 *
 * - an edit that adds a personal identity number to a draft, racing a
 *   publication that read the text before the edit, publishes the number
 *   (`refusePersonalIdentityNumbers` passed on the old text);
 * - a removal racing any of them leaves the other writing to a row that is
 *   gone, and the caller is answered with a 500 rather than told the series no
 *   longer exists.
 *
 * A row lock rather than an advisory one, because the series is a row and the
 * edit path already waits on it; one mechanism is enough. A series that does
 * not exist has no row to take, and the read after this answers it.
 */
export async function lockEvent(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM event WHERE id = ${eventId} FOR UPDATE`;
}

/**
 * The series' row of one date, so the date is read after any edit, removal or
 * publication of the series has finished.
 *
 * An edit can delete the date. A call-off or a reinstatement that read it
 * before the edit committed would then write to a row that is gone, and the
 * caller would be answered with a 500 rather than told the date no longer
 * exists. The series is found from the date without a lock, and a date already
 * gone has no series to take: the read after this answers it.
 */
export async function lockEventOfOccurrence(
  tx: Prisma.TransactionClient,
  occurrenceId: string,
): Promise<void> {
  const occurrence = await tx.eventOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { eventId: true },
  });
  if (occurrence !== null) {
    await lockEvent(tx, occurrence.eventId);
  }
}
