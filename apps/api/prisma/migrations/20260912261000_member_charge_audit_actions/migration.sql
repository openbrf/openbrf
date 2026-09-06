-- Recording a charge, correcting one and removing one are all writes to
-- personal data about the person or the household they name, so all three are
-- recorded with that person as the subject and the board member who acted as
-- the actor - the shape BOOKING_CANCELLED already uses, and what puts a charge
-- somebody else decided on into that person's own access report. A charge on an
-- apartment names no subject: the row is about the flat, and which of its
-- residents would be the subject is a question the log must not answer by
-- guessing.
--
-- Exporting the debiting list is its own action rather than DATA_EXPORTED,
-- because it is the register extracts' kind of act and is read back the way
-- MEMBER_REGISTER_EXTRACT_GENERATED is: the list leaves the association for its
-- bookkeeper carrying names, apartments and sums, and the log has to be able to
-- say who took a copy and for which period.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The table these actions are written about is created by
-- 20260912260000_member_charges, which uses none of them.
--
-- The purge that erases these rows writes SERVICE_DATA_PURGED with a targetKind
-- of "memberCharge" rather than an action of its own, exactly as the booking
-- and sign-up purges do: it is the same act the log already has a word for.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMBER_CHARGE_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMBER_CHARGE_CORRECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMBER_CHARGE_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEBITING_LIST_EXPORTED';
