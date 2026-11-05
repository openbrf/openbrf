import type { PrismaService } from "../database/prisma.service";
import { REPEATED_NOTICE_SECONDS } from "../issues/issue-mailer.service";
import { JOB_SCHEMA } from "../jobs/job-queue.service";

/**
 * How long one test may run, the integration config's `testTimeout`
 * (`vitest.integration.config.mts`). A test still running past it has failed.
 */
export const TEST_TIMEOUT_MS = 30_000;

/**
 * Slack kept above {@link TEST_TIMEOUT_MS} when the slot is checked: the
 * test's own timer starts only after the hook returns, and the clock is read
 * before that, so a test needs more than its timeout of the slot left.
 */
export const SLOT_MARGIN_MS = 1_000;

/**
 * Waits for the issue notice queue's throttle slot to turn when less than
 * {@link TEST_TIMEOUT_MS} plus {@link SLOT_MARGIN_MS} of it is left.
 *
 * The queue cuts the database's clock into slots of
 * {@link REPEATED_NOTICE_SECONDS}, each starting on the hour, and a repeated
 * notice (an assignment, a reopening, a contractor's notes) is dropped only
 * within the slot of the first. A test that queues a notice and then a repeat
 * expects both in one slot, and one started a second before the hour turns
 * would see the repeat queued. A test that starts with a timeout's worth of
 * its slot left, and a margin, and passes, cannot cross the turn.
 */
export async function clearOfTheSlotTurn(
  prisma: Pick<PrismaService, "$queryRawUnsafe">,
): Promise<void> {
  const slotMs = REPEATED_NOTICE_SECONDS * 1000;
  for (;;) {
    // The clock the queue reads when it cuts the slot.
    const [row] = await prisma.$queryRawUnsafe<{ nowMs: number }[]>(
      `SELECT (date_part('epoch', ${JOB_SCHEMA}.job_now()) * 1000)::float8 AS "nowMs"`,
    );
    if (row === undefined) {
      throw new Error("The database did not read the queue's clock.");
    }
    const leftMs = slotMs - (row.nowMs % slotMs);
    if (leftMs >= TEST_TIMEOUT_MS + SLOT_MARGIN_MS) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, leftMs + 100));
  }
}
