-- The notice (kallelse) that summons a general meeting, the ledger of who it
-- was sent to, and the link from a motion to the meeting that takes it up.
--
-- EFL 6 kap. 22 § is what makes a notice a notice rather than a message about a
-- meeting. It requires the time and the place; where the meeting is to be held
-- digitally, how the members are to take part and to vote; and the matters to
-- be dealt with, clearly stated. The first two are columns on "meeting_notice".
-- The third is the meeting's agenda, which is why issuing a notice freezes it
-- rather than copying it: EFL 6 kap. 25 § leaves the meeting unable to decide a
-- matter the notice did not take up, so the notice is what settles which items
-- a meeting may deal with, and a second copy of them here would be a second
-- answer to one question.
--
-- Electronic notices are lawful for a housing cooperative: BRL 1 kap. 10 §
-- applies the rules on information by electronic means in EFL 1 kap. 16 § to a
-- bostadsrattsforening sending kallelser. That paragraph attaches three
-- conditions - a resolution of the general meeting, reliable routines for
-- identifying the recipient together with reliable information on how to reach
-- them, and the recipient's consent, presumed where a posted request went
-- unanswered for at least two weeks - and none of the three is a fact this
-- platform decides. The ledger records that the association sent the notice and
-- claims nothing about entitlement, which is the same distinction
-- "proxy_authorisation" draws between seeing a signed document and producing
-- one.
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql, on the same footing as the tables
-- 20260908100000_meetings created: the lasting record of a general meeting is
-- the protokoll that EFL 6 kap. 39 § has the chair keep, and these tables hold
-- how the meeting was summoned.

-- CreateEnum
--
-- One value, because this platform sends a notice one way, and its own type
-- rather than the news mailing's because a notice is not a news item.
--
-- POST is deliberately absent. EFL 6 kap. 21 § andra stycket requires a notice
-- to be posted to every member whose postal address is known in three cases,
-- and this platform posts nothing and records none of the facts those cases turn
-- on - so a POST value would be a ledger of letters nobody sent.
CREATE TYPE "MeetingNoticeChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "MeetingNoticeDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
--
-- "startsAt" is a timestamp and the meeting day is not repeated here. The day a
-- meeting is held decides who has a vote at it and lives on "meeting"."heldOn";
-- what 22 § adds is the time, and the API writes this column only where its
-- Stockholm day is that one, so the two cannot answer "which day" differently.
--
-- "digitalParticipation" is one nullable column and not a flag beside a text.
-- 22 § makes the instruction required exactly when the meeting is held
-- digitally, so the instruction being present and the meeting being digital are
-- one fact rather than two that could contradict each other.
--
-- "place" is NOT NULL even for a digital meeting: the first sentence of 22 §
-- states time and place without condition.
--
-- "issuedByPersonId" is a plain column and not a foreign key, for the reason
-- "meeting_decision"."recordedByPersonId" is one - every referential action
-- available either rewrites this row when a person is erased or vetoes the
-- erasure outright.
CREATE TABLE "meeting_notice" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "place" TEXT NOT NULL,
    "digitalParticipation" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedByPersonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_notice_pkey" PRIMARY KEY ("id")
);

-- A notice states a place and, where it states an instruction at all, states
-- one.
--
-- Blank text is refused rather than stored, because a notice with an empty
-- place has not stated the place 22 § requires, and an empty instruction is a
-- digital meeting whose members were told nothing about how to attend. The API
-- trims and refuses the same values first and with a reason code; this is what
-- stops a hand-written statement from putting a notice in the table that could
-- not be given.
ALTER TABLE "meeting_notice" ADD CONSTRAINT "meeting_notice_text_check"
  CHECK (
    length(btrim("place")) > 0
    AND ("digitalParticipation" IS NULL OR length(btrim("digitalParticipation")) > 0)
  );

-- CreateTable
--
-- The news delivery ledger's shape, on a table of its own: one row per
-- recipient, claimed conditionally from PENDING before anything is handed to a
-- mail server, so a retried job reaches nobody twice.
--
-- "failureReason" holds a code and never the mail server's own words. A
-- rejection quotes the envelope back and the envelope is a member's address.
--
-- "personId" is a plain column, like every person reference outside the
-- registers: a recipient erased before the worker runs is recorded as
-- unreachable rather than vetoing their own erasure.
CREATE TABLE "meeting_notice_delivery" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "channel" "MeetingNoticeChannel" NOT NULL DEFAULT 'EMAIL',
    "status" "MeetingNoticeDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "meeting_notice_delivery_pkey" PRIMARY KEY ("id")
);

-- AlterTable
--
-- The link the first tranche left out, nullable because a motion begins as an
-- item with the board and reaches a particular meeting only when the board puts
-- it to one.
--
-- A real foreign key, unlike every person reference in this table: a meeting is
-- the association's own act, is never purged and is erased on nobody's request,
-- so the key costs the purge nothing. ON DELETE RESTRICT and not SET NULL -
-- nothing deletes a meeting, and restricting is what keeps that true rather
-- than letting a delete silently detach the items a meeting was summoned to
-- deal with.
ALTER TABLE "motion" ADD COLUMN "meetingId" TEXT;

-- CreateIndex
--
-- One notice per meeting. A notice that went wrong is not corrected by a second
-- one: EFL 6 kap. 25 § leaves the meeting unable to decide the affected matter
-- and lets it resolve to convene an extra general meeting, which is a meeting of
-- its own with a notice of its own.
CREATE UNIQUE INDEX "meeting_notice_meetingId_key" ON "meeting_notice"("meetingId");

-- CreateIndex
--
-- One row per recipient and channel, which is what makes "exactly once per
-- recipient" mechanical rather than a property of the code that writes it.
CREATE UNIQUE INDEX "meeting_notice_delivery_noticeId_personId_channel_key" ON "meeting_notice_delivery"("noticeId", "personId", "channel");

-- CreateIndex
CREATE INDEX "meeting_notice_delivery_noticeId_channel_status_idx" ON "meeting_notice_delivery"("noticeId", "channel", "status");

-- CreateIndex
CREATE INDEX "motion_meetingId_idx" ON "motion"("meetingId");

-- AddForeignKey
--
-- The notice cascades from the meeting, because it says what it is only through
-- the meeting it summons - the argument every other table on that meeting makes.
-- Nothing deletes a meeting, which is what stands in front of the cascade.
ALTER TABLE "meeting_notice" ADD CONSTRAINT "meeting_notice_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notice_delivery" ADD CONSTRAINT "meeting_notice_delivery_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "meeting_notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "motion" ADD CONSTRAINT "motion_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
