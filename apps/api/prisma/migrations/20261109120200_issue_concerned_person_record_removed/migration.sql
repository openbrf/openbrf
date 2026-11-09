-- When the record of whom an issue concerns was taken off the issue while a
-- work order's text still stands (ADR 0057): the row is then kept as the
-- selector a later legal hold or restriction on the person finds that text by,
-- and deleted with the last of it. Null while the record stands.
--
-- In one transaction, as the migration that made the table is: Prisma runs each
-- statement on its own.
BEGIN;

ALTER TABLE "issue_concerned_person"
  ADD COLUMN IF NOT EXISTS "recordRemovedAt" TIMESTAMP(3);

COMMIT;
