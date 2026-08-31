-- What the association offers for booking is configuration the board is
-- answerable for, so adding, editing and withdrawing a resource is recorded in
-- the audit log like every other change a board makes to how the instance
-- works.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The tables these actions are written about are created by
-- 20260902090000_bookings, which uses none of these values.
--
-- Only what this change writes. The actions for making and cancelling a booking
-- arrive with the endpoints that write them.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_RESOURCE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_RESOURCE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_RESOURCE_DEACTIVATED';
