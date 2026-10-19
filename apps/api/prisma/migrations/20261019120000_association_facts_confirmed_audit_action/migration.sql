-- The entry written when a board member confirms that the facts on the broker
-- information page still hold, without changing any of them.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The column the confirmation moves is added by
-- 20261019120100_association_facts_confirmed_at, which uses no audit value.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSOCIATION_FACTS_CONFIRMED';
