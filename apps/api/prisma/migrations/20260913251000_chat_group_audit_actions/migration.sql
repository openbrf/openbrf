-- Making a group chat, who is in it, and striking a message in one through.
--
-- The four acts that change who can read something. Writing a message is not
-- among them and is deliberately not recorded: a message is on its author's
-- access report in full, carrying its author and its instant, so an entry would
-- restate what the row already says. Reporting a message is not recorded either,
-- because the report row is itself the record - it says who reported what, when,
-- and what the board did about it, and unlike an entry it is erased with the
-- message it is about.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The tables these actions are written about are created by
-- 20260913230000_board_chat and 20260913250000_chat_groups, which use none of
-- the four values.
--
-- There is no action for clearing a strike-through. The strike is a dated close
-- on the row and nothing clears it, so there is no such act to record.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CHAT_GROUP_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CHAT_GROUP_MEMBER_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CHAT_GROUP_MEMBER_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CHAT_MESSAGE_STRUCK';
