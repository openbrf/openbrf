-- Where the preview wrote each row, for every chunk of the apply to compare.
--
-- The register revision covers what another import writes after a preview,
-- and the rows the preview asked about carry the persons it offered. Neither
-- covers an ordinary row that the address book, a sign-up approval or a move
-- has sent to somebody else since: an update of one person becomes an update
-- of another. "previewedTargets" holds one digest per data row of what the
-- preview planned for it, and a chunk whose own rows differ stops before it
-- writes.
--
-- No backfill. A session previewed before this has none, and its apply is
-- refused until it is previewed again.

-- AlterTable
ALTER TABLE "import_session" ADD COLUMN     "previewedTargets" JSONB;
