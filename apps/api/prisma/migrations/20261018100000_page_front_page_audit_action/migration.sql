-- The entry written when the board chooses which page the root of the website
-- serves.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The entry names the page chosen and the one it replaced.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAGE_FRONT_PAGE_CHANGED';
