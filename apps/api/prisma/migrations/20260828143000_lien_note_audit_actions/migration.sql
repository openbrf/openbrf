-- Lien notes are changes to the statutory apartment register, so they are
-- recorded in the audit log like every read of it. The log covers changes as
-- well as accesses.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APARTMENT_REGISTER_LIEN_NOTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APARTMENT_REGISTER_LIEN_RELEASED';
