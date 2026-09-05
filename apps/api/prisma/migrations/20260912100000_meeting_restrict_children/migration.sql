-- A meeting's children refuse its delete instead of following it.
--
-- The agenda, the attendance lines, the proxy authorisations and the notice all
-- cascaded from the meeting, so a single DELETE would have taken the running
-- order the members were summoned to deal with, the list the votes were counted
-- from, the authorisations behind those votes and the document that summoned
-- them - and left nothing behind saying the meeting had ever been held. Nothing
-- in the application deletes a meeting, but that was a promise the schema did
-- not keep, and the guarantee is worth more as a constraint than as a sentence.
--
-- RESTRICT rather than NO ACTION, and RESTRICT rather than SET NULL: every one
-- of these columns is NOT NULL, and a child that could be detached from its
-- meeting would be a row nothing can read a meaning out of.
--
-- Motion.meetingId has restricted since the motions migration, so this is the
-- rule the meetings module already followed on one side of the join.
--
-- Not changed here, and deliberately: MeetingDecision and MeetingVote still
-- cascade from AgendaItem, and MeetingNoticeDelivery still cascades from
-- MeetingNotice. Replacing an agenda is a real flow - MeetingService.setAgenda
-- deletes and rewrites the items in one transaction while the meeting is being
-- arranged, refused once a notice has been issued or the meeting has been held -
-- and the cascade is what carries a decision recorded against an item that goes.
-- Restricting there would make the agenda unwritable rather than the meeting
-- undeletable.
--
-- ON UPDATE CASCADE is the client's default on every foreign key in this schema
-- and is kept for consistency; the referenced column is a cuid that is never
-- updated.
--
-- Each statement takes a brief ACCESS EXCLUSIVE lock on the child table and
-- validates the existing rows against a primary key. All four tables are small -
-- one association's meetings - so the lock is held for milliseconds.

-- DropForeignKey
ALTER TABLE "agenda_item" DROP CONSTRAINT "agenda_item_meetingId_fkey";

-- DropForeignKey
ALTER TABLE "meeting_attendance" DROP CONSTRAINT "meeting_attendance_meetingId_fkey";

-- DropForeignKey
ALTER TABLE "proxy_authorisation" DROP CONSTRAINT "proxy_authorisation_meetingId_fkey";

-- DropForeignKey
ALTER TABLE "meeting_notice" DROP CONSTRAINT "meeting_notice_meetingId_fkey";

-- AddForeignKey
ALTER TABLE "agenda_item" ADD CONSTRAINT "agenda_item_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_authorisation" ADD CONSTRAINT "proxy_authorisation_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notice" ADD CONSTRAINT "meeting_notice_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
