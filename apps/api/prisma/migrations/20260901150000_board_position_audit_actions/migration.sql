-- Conferring and ending a position of trust are changes to the register, so
-- they are recorded in the audit log like every other change to it. The two
-- system role actions the same acts need already exist: SYSTEM_ROLE_GRANTED and
-- SYSTEM_ROLE_REVOKED were added for the first administrator the setup wizard
-- creates, and the application now writes them from more than one place.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOARD_POSITION_ELECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOARD_POSITION_ENDED';
