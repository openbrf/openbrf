-- Who booked what, and who cancelled it. A booking says which apartment holds
-- which hour, and cancelling one on somebody's behalf is an act the association
-- answers for, so both are recorded in the audit log.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- Separate from 20260902100000, which added the catalogue actions, because that
-- migration had already shipped: a value appended to a file that has run is a
-- change nothing applies.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_MADE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_CANCELLED';
