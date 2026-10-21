-- The entry written when a plugin records a delivery receipt. It names the
-- notice or the charge, the plugin, the route and the receipt, and never the
-- reference: that lives on the receipt and is erased with it, and the log is
-- exempt from every purge.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DELIVERY_RECEIPT_RECORDED';
