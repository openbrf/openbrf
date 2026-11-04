-- The audit actions for a change to the contractor list and to an issue
-- type's ring-fence.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses them; the services do, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONTRACTOR_LIST_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_TYPE_RING_FENCE_CHANGED';
