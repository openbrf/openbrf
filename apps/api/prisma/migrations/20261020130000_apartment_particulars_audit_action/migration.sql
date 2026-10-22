-- The entry written when the board records an apartment's room count, other
-- spaces, living area or the registration date of the economic plan it was
-- granted under (BRL 9 kap. 10 §).
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The entry names the fields that moved and never their values, as
-- APARTMENT_SHARES_RECORDED does: the apartment register is confidential and
-- the log is exempt from every purge.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APARTMENT_PARTICULARS_RECORDED';
