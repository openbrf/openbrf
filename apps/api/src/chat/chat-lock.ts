import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it writes in a room or erases one.
 *
 * A group with nothing in it is erased by the nightly sweep, and a message can
 * be written into that room at the same moment. Both sides of the decision are a
 * read taken before the row that would change its answer exists: the sweep reads
 * "this room holds no message" and then deletes, and the write reads "this room
 * is mine to write in" and then inserts. At READ COMMITTED - the isolation
 * everything in this application runs at - the insert can commit in the gap
 * between the sweep's read and its delete, and the delete then cascades the
 * message away. The writer is told their message was stored, and the room and
 * the message are both gone.
 *
 * The foreign key does not close it. A child insert takes FOR KEY SHARE on the
 * parent row, so the delete waits for the writer to commit - and then proceeds
 * and cascades. Waiting is not refusing.
 *
 * An advisory lock rather than an isolation level, for the reason
 * `legal-hold-lock.ts` gives: the invariant is derived from a set of rows - "no
 * message points at this room" - and no single row carries it, so no constraint
 * can state it. Serializable would state it, at the price of retry handling on
 * every message anybody writes, for a contention this application never has: the
 * sweep runs once a night and only ever reaches a room nobody has written in for
 * a year.
 *
 * Held here rather than beside either writer because the lock only works if
 * every writer uses the same key. A second spelling of this string would be two
 * locks that never meet, which is worse than no lock at all: it reads as
 * serialised and is not.
 *
 * The key is namespaced and hashed to the int4 the lock space is addressed in. A
 * collision between two rooms costs one of them a short wait and nothing else.
 * Taken for the transaction, so the commit or the rollback releases it with
 * nothing left to remember to unlock.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockChat(
  tx: Prisma.TransactionClient,
  chatId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat:${chatId}`}))`;
}

/**
 * The lock the board takes before it answers a report.
 *
 * Keyed on the message rather than on the report, because what the board decides
 * is about the message: striking one report through closes every other report of
 * the same message, and so does leaving it standing. Two answers arriving
 * together - one press on each of two reports of one line - would otherwise both
 * pass their own check, and the record would say the board left a message
 * standing while the message carries a strike. That is worse than either answer,
 * because the log of what the board decided would be false.
 *
 * The claim on the report is a conditional update and settles a second press on
 * the same report by itself. This is what settles two presses on two reports,
 * which no single row can: the invariant is across the set of reports about one
 * message, and `legal-hold-lock.ts` gives the argument for an advisory lock over
 * an isolation level in that case.
 *
 * Taken for the transaction, like every other lock here, and hashed into the
 * same int4 space: a collision costs one board member a short wait.
 */
export async function lockChatMessage(
  tx: Prisma.TransactionClient,
  messageId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-message:${messageId}`}))`;
}
