-- Signing up to a date and standing down again are both recorded, because both
-- are writes to personal data about the person they name: one says a resident
-- intends to be somewhere the association arranged, the other that they no
-- longer do. The board may withdraw a sign-up on somebody's behalf, so the
-- withdrawal entry names the person whose sign-up it was as the subject and
-- whoever acted as the actor - the shape BOOKING_CANCELLED already uses, and
-- what puts a withdrawal somebody else decided on into that person's own access
-- report.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The table these actions are written about is created by
-- 20260903120000_event_signups, which uses neither of them.
--
-- The purge that erases these rows writes SERVICE_DATA_PURGED with a targetKind
-- of "eventSignup" rather than an action of its own, exactly as the booking
-- purge does: it is the same act the log already has a word for.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EVENT_SIGNUP_MADE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EVENT_SIGNUP_WITHDRAWN';
