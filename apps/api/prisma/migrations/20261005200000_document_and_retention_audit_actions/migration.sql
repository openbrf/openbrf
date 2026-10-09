-- Two writes the log did not record.
--
-- DOCUMENT_UPDATED: a document in the archive renamed, re-filed or given to
-- another audience. The audience decides whether its file can be fetched
-- without a session, so moving board minutes to PUBLIC was the one change to
-- the archive nothing recorded - an upload and a removal already are. The entry
-- names the fields that changed and the audience either side, never the title.
--
-- ASSOCIATION_RETENTION_RECORDED: the time service data is kept after a
-- move-out was changed. Purge dates are computed from it, so the change moves
-- every pending one at once, as the financial year does for the charges; the
-- entry names the value before and after.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOCUMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSOCIATION_RETENTION_RECORDED';
