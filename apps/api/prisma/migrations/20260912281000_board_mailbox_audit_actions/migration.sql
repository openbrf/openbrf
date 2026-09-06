-- What the board did with a thread in its shared mailbox.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- All five are added here rather than in five migrations: the restriction is on
-- using a new value, not on adding another beside it.
--
-- Collecting the mailbox is deliberately not among them. The poll runs on a
-- schedule and finds nothing most times it runs, and an entry per run - into a
-- table that is append-only and outside every purge - would be a permanent log
-- of a clock ticking. What arrival is recorded by is the thread itself, which is
-- the record the board actually reads.
--
-- None of these entries names the correspondent. The address on a thread is
-- whatever the envelope asserted and is never resolved to a person, so a
-- targetPersonId here would be the attribution this module refuses to make
-- everywhere else; the entries point at the thread with targetKind and targetId
-- instead, and the subject line is read from the thread while the thread exists.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOARD_MAILBOX_THREAD_TAKEN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOARD_MAILBOX_THREAD_RELEASED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOARD_MAILBOX_REPLY_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOARD_MAILBOX_THREAD_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOARD_MAILBOX_THREAD_REOPENED';
