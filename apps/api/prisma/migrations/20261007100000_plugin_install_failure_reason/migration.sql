-- Why an install failed, as a code and its values rather than as English.
--
-- Additive: lastError keeps what it holds and its type. Existing rows get no
-- reason and are shown from lastError as they are; nothing is backfilled,
-- because reading a code back out of a sentence is the thing this replaces.
--
-- Reversed by dropping the two columns, which loses nothing lastError does
-- not also hold:
--
--   ALTER TABLE "installed_plugin" DROP COLUMN "lastErrorDetail",
--     DROP COLUMN "lastErrorReason";
ALTER TABLE "installed_plugin" ADD COLUMN "lastErrorReason" TEXT,
ADD COLUMN "lastErrorDetail" JSONB;
