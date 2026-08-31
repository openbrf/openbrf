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
