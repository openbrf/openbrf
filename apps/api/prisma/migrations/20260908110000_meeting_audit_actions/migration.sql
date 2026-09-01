-- What happened around a general meeting: the board arranged one, set its
-- agenda and recorded that it had been held; somebody was recorded as present
-- or struck off the list again; a member's written authority for a proxy holder
-- was registered or withdrawn; and the chair recorded what the meeting decided
-- on an item.
--
-- Each is an act the association answers for. Four of the eight are also acts a
-- person's own data subject access report has to be able to show - being
-- recorded in the room, being struck off it, giving somebody a proxy
-- authorisation and taking it back - so each is written to the audit log with
-- the person as the subject and whoever acted as the actor.
--
-- The four that name no subject say so deliberately. Arranging a meeting,
-- setting an agenda, recording that a meeting was held and minuting a decision
-- are the association's business rather than acts about a person, even where the
-- item on the agenda was somebody's motion: what the meeting resolved is the
-- meeting's record, and the motion module already writes the entry that names
-- the member who put it.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The tables these actions are written about are created by
-- 20260908100000_meetings, which uses none of these values.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEETING_ARRANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEETING_HELD';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEETING_AGENDA_SET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEETING_ATTENDANCE_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEETING_ATTENDANCE_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEETING_PROXY_REGISTERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEETING_PROXY_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEETING_DECISION_RECORDED';
