-- What this train writes, and who wrote it.
--
-- All three are statutory register acts. A termination is the event the
-- association reports to the cooperative housing register; the membership
-- decision is the date that report's two-week window runs from; the property
-- designation identifies the property the register's apartments are in. None of
-- them can be answered for afterwards without an entry naming who recorded it.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- Separate from 20260905100000 for that reason and no other.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APARTMENT_REGISTER_TERMINATION_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APARTMENT_REGISTER_MEMBERSHIP_DECISION_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSOCIATION_PROPERTY_DESIGNATION_RECORDED';
