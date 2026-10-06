-- What tells an apply that another import has written since it was previewed.
--
-- "import_revision" counts the import chunks that wrote to the register. A
-- chunk advances it in the same transaction as its writes, and only when it
-- wrote something. "previewedRevision" is the count a preview read before it
-- read the register, and the apply refuses to start when the two differ.
--
-- No backfill. A session previewed before this migration has no revision and is
-- refused as outdated until it is previewed again. The counter starts at 0; the
-- application also creates the row if it is missing, and reads a missing row
-- as 0.

-- AlterTable
ALTER TABLE "import_session" ADD COLUMN     "previewedRevision" INTEGER;

-- CreateTable
CREATE TABLE "import_revision" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "import_revision_pkey" PRIMARY KEY ("id")
);

-- One instance serves exactly one association, and one count serves the
-- instance, so the singleton row is pinned rather than merely conventional.
ALTER TABLE "import_revision"
  ADD CONSTRAINT "import_revision_is_singleton" CHECK ("id" = 1);

INSERT INTO "import_revision" ("id", "revision") VALUES (1, 0);
