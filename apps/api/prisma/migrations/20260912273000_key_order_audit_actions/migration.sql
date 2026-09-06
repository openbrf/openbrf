-- What happened to a key order: a resident placed one, revised it, took it back,
-- or the board handed the key over or declined the order.
--
-- The handover is the act the record exists for, so it is an action of its own
-- rather than a status change folded into a general "closed": the audit log is
-- where the association can still say that somebody was given a key to the
-- building on a day, once the order itself has been purged.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The table these actions are written about is created by 20260912272000_key_orders,
-- which uses none of these values.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KEY_ORDER_PLACED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KEY_ORDER_REVISED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KEY_ORDER_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KEY_ORDER_HANDED_OVER';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KEY_ORDER_DECLINED';
