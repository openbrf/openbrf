-- Which preview an apply was checked against.
--
-- "previewCount" counts a session's previews, and each preview advances it. The
-- apply claims the session only while it still holds the count the apply read,
-- so a preview recorded in between is never applied with decisions that answer
-- another one. It replaces comparing "previewedAt", which two previews can share
-- at millisecond precision.
--
-- No backfill. A session previewed before this migration has 0, which an apply
-- of it reads and claims with like any other count.

-- AlterTable
ALTER TABLE "import_session" ADD COLUMN     "previewCount" INTEGER NOT NULL DEFAULT 0;
