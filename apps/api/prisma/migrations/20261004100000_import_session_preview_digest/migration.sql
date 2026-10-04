-- Two facts an import carries between its steps.
--
-- "previewDigest" is what the preview planned for every row, hashed. Starting
-- the import plans the file again with the board's decisions and refuses when
-- the digest differs, so a decision cannot turn a row the preview showed as an
-- update into a new person without the board seeing it.
--
-- "unwrittenIdentityNumbers" maps a row the apply wrote to a person without
-- writing its identity number - the row reached them by email or by name - to
-- that person. A later chunk reads the number back from the row, so a later row
-- stating it reaches the same person instead of creating them a second time.
--
-- Both are nullable and need no backfill. A session previewed before this
-- migration has no digest, and an apply of it with decisions is refused as
-- outdated until it is previewed again. One already applying has no rows
-- recorded, which is what it had before.

-- AlterTable
ALTER TABLE "import_session" ADD COLUMN     "previewDigest" TEXT,
ADD COLUMN     "unwrittenIdentityNumbers" JSONB;
