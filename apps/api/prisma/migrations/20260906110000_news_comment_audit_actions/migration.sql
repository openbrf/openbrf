-- Writing a comment on a news item, and striking one through.
--
-- Both are recorded in the audit log: the first because a member's own words
-- about a notice are their data and their access report has to be able to say
-- when they wrote them, the second because hiding somebody's comment is an act
-- the board is answerable for and the row itself only says that it happened,
-- never who decided it.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The table these actions are written about is created by
-- 20260906100000_news_comments, which uses neither value.
--
-- There is no action for showing a hidden comment again. The hide is a dated
-- close on the row and nothing clears it, so there is no such act to record.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NEWS_COMMENT_POSTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NEWS_COMMENT_HIDDEN';
