-- Every edit of the website's menu is recorded, whoever makes it.
--
-- The menu was deliberately left unaudited: it decides what is offered and
-- never what may be read, so an entry is rendered only to a visitor who could
-- open its target anyway, and rearranging it publishes nothing and conceals
-- nothing. That argument is about disclosure and it still holds. Attribution is
-- a separate question, and it becomes a real one the moment something other
-- than a board member in a browser can write here: the menu is the one place on
-- a public page where an address leaving the instance can be planted, every
-- visitor sees it, and nobody reads it closely. So the entry records the href
-- for an external target - a published menu target is site content and not
-- personal data, and it is the only field that makes the record answerable.
--
-- The label is never recorded. It is text a board member wrote, it lives on the
-- row while the row lives, and rule 3 on AuditLogService keeps copies of such
-- text out of a table that outlives them.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MENU_ITEM_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MENU_ITEM_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MENU_ITEM_REORDERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MENU_ITEM_REMOVED';
