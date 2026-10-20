-- The entries written when a board member confirms that the facts on the broker
-- information page still hold, without changing any of them, and when a board
-- member changes how many months those facts count as current.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and PostgreSQL runs each migration
-- script in one implicit transaction. The columns they record are added by
-- 20261019120100_association_facts_confirmed_at_and_stale_after, which uses no
-- audit value.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSOCIATION_FACTS_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSOCIATION_FACTS_STALE_AFTER_CHANGED';
