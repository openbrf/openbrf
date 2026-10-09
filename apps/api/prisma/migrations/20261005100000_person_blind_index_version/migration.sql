-- The normalisation rules a person's blind indexes were computed under.
--
-- A blind index is a keyed hash of the normalised value, so it can only be
-- recomputed by the application, which holds the key: SQL cannot do it here.
-- Every row that exists now was indexed under version 1, and this release
-- changes the rules (version 2, NORMALIZATION_VERSION in
-- src/crypto/personal-data.ts). So the column is added at 1 for the existing
-- rows and its default then moves to 2 for the rows the application writes from
-- now on, and the application reindexes every row below the current version at
-- boot.
--
-- A later change of the rules is a migration that moves the default again.

-- AlterTable
ALTER TABLE "person" ADD COLUMN "blindIndexVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "person" ALTER COLUMN "blindIndexVersion" SET DEFAULT 2;
