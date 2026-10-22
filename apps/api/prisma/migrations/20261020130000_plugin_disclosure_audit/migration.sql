-- A plugin sending personal data to a declared recipient through the host
-- (ADR 0037): one entry per person before the request leaves, and one with
-- its outcome after.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_DISCLOSURE_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_DISCLOSURE_FINISHED';
