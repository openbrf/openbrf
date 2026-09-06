-- The audit actions for the three acts this round adds.
--
-- Their own migration, as every module's are. PostgreSQL will not let a value
-- added to an enum be used in the same transaction that added it, and the
-- application writes these the moment it starts, so they land ahead of the code
-- that names them rather than in the same statement as the schema they describe.
--
-- APARTMENT_REGISTER_TRANSFER_REPORT_BASIS_RECORDED stands beside
-- APARTMENT_REGISTER_MEMBERSHIP_DECISION_RECORDED rather than replacing it. The
-- two are different statements: one is the day the board decided on membership,
-- the other is which case of Lag (2026:484) 3 kap. 3 § the overgang falls in.
-- The ordinary case produces both from one act, and the four other cases produce
-- only this one, because there is no decision to date.
ALTER TYPE "AuditAction" ADD VALUE 'APARTMENT_REGISTER_TRANSFER_REPORT_BASIS_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE 'APARTMENT_REGISTER_TRANSFER_REVERSAL_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE 'ASSOCIATION_LAND_TENURE_RECORDED';
