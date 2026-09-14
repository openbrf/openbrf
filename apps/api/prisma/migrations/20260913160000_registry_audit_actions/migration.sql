-- What the action registry has to be able to record.
--
-- Four of these are new acts: a request that a news item be mailed, a board
-- member dismissing one, and an administrator switching a plugin's action on or
-- off for connected apps and the AI package.
--
-- The other three close a gap that predates this work. PagesWriteService
-- records on publish, on a visibility change and on removal, and writes nothing
-- when the body, the title or the address of a page changes; NewsWriteService
-- is the same. That was defensible while a board member in a browser was the
-- only writer and publication was the act that decided who could read
-- something. It is not defensible once a token can rewrite the body of a page
-- that is already public: the change would leave no record at all, which is the
-- same gap the menu entries closed for the menu. Five of the thirteen writes in
-- the first slice were unattributable without these.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAGE_CONTENT_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NEWS_CONTENT_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAGE_REORDERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NEWS_MAILING_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NEWS_MAILING_REQUEST_DISMISSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_ACTION_ARMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_ACTION_DISARMED';
