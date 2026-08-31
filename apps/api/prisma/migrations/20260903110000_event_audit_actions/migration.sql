-- What the association arranges and who it is announced to are the board's
-- decisions, so entering a series, editing it, publishing it and calling off one
-- of its dates are recorded in the audit log like every other change a board
-- makes to what the instance says.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The tables these actions are written about are created by 20260903100000_events,
-- which uses none of these values.
--
-- Only what this change writes. The action for signing up to an occurrence
-- arrives with the endpoint that writes it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EVENT_SERIES_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EVENT_SERIES_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EVENT_SERIES_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EVENT_OCCURRENCE_CANCELLED';
