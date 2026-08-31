-- Motions to the general meeting (motion till stamman): the item a member puts
-- to the meeting, and the deadline the bylaws set for putting one.
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql, because the table holds no statutory
-- register content: a motion is a member's own proposal, held to run the queue
-- the board works from, and the motion purge erases it once it has been closed
-- long enough. What a meeting decided about the proposal is minuted in the
-- document archive, which is where the lasting record of it lives.
--
-- Deliberately no "meetingId". Meetings are a later module; a column
-- referencing a table that does not exist would be a foreign key to nothing.

-- CreateEnum
CREATE TYPE "MotionStatus" AS ENUM ('SUBMITTED', 'ACKNOWLEDGED', 'WITHDRAWN');

-- AlterTable
--
-- The bylaws' motion deadline, as a recurring month and day. No default: EFL
-- 6 kap. 15 § makes the deadline the association's own clause, so null means
-- the bylaws state none rather than that nobody has typed one in yet, and a
-- default here would be the platform contradicting a document it has not read.
ALTER TABLE "association" ADD COLUMN "motionDeadlineMonth" INTEGER;
ALTER TABLE "association" ADD COLUMN "motionDeadlineDay" INTEGER;

-- Both columns or neither, and a month and day a bylaws clause could name.
--
-- The two columns are one setting, and half of it is a rule nothing can resolve
-- to a date: readMotionDeadline in src/motions/motion-deadline.ts answers "no
-- deadline" for a half-written pair, which is the reading that cannot turn a
-- member away for a clause nobody can see, but it should never have a row to
-- answer for. The settings write is the only writer today, so without this the
-- invariant lives in one function rather than in the table.
--
-- The day is bounded by the month rather than a flat 1 to 31, which is
-- isWritableDeadline's rule in the same file: 31 February is not a date in any
-- year, so a clause could not say it. February takes 29, which is a date in a
-- leap year and what nextMotionDeadline's clamp exists for. A flat upper bound
-- of 31 would look like the table validating the date while still accepting one
-- that does not exist.
--
-- The API refuses all of this first and with a reason code, so a violation here
-- is reachable only by a hand-written statement - which is exactly the case the
-- constraint is for, and why losing the reason to SQLSTATE 23514 costs nothing.
ALTER TABLE "association" ADD CONSTRAINT "association_motionDeadline_check"
  CHECK (
    ("motionDeadlineMonth" IS NULL) = ("motionDeadlineDay" IS NULL)
    AND ("motionDeadlineMonth" IS NULL OR "motionDeadlineMonth" BETWEEN 1 AND 12)
    AND (
      "motionDeadlineDay" IS NULL
      OR "motionDeadlineDay" BETWEEN 1 AND CASE "motionDeadlineMonth"
        WHEN 2 THEN 29
        WHEN 4 THEN 30
        WHEN 6 THEN 30
        WHEN 9 THEN 30
        WHEN 11 THEN 30
        ELSE 31
      END
    )
  );

-- CreateTable
--
-- submittedByPersonId and closedByPersonId are plain columns and not foreign
-- keys, for the reason issue."reporterPersonId" and booking."bookedByPersonId"
-- are: every referential action available either rewrites this row when a
-- person is erased or vetoes the erasure outright, and service-tier data must
-- be purgeable without the purge having to negotiate with the motion queue.
CREATE TABLE "motion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "submittedByPersonId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "MotionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "closedAt" TIMESTAMP(3),
    "closedByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "motion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- The board's queue, a member's own motions, and the purge scan, in that order.
CREATE INDEX "motion_status_submittedAt_idx" ON "motion"("status", "submittedAt");
CREATE INDEX "motion_submittedByPersonId_submittedAt_idx" ON "motion"("submittedByPersonId", "submittedAt");
CREATE INDEX "motion_closedAt_idx" ON "motion"("closedAt");
