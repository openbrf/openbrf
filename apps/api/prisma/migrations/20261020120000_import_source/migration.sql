-- What a board imports from more than once.
--
-- "import_source" is a file recognised by its column titles: the mapping the
-- board last started an import from it with, offered again in place of a guess,
-- and the digest of the last file from it that was applied, so the same rows
-- uploaded again are answered as unchanged. Nothing in it names a person: the
-- titles are kept only as a keyed digest, since the first row of a file without
-- a header row is a member's, and the file name not at all. The import purge
-- deletes a source no import has used for two years.
--
-- "sourceKey" and "contentDigest" on the session carry the two from the upload
-- to the apply. No backfill: a session uploaded before this has neither, and
-- its apply records no source.

-- AlterTable
ALTER TABLE "import_session" ADD COLUMN     "contentDigest" TEXT,
ADD COLUMN     "sourceKey" TEXT;

-- CreateTable
CREATE TABLE "import_source" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mapping" TEXT[],
    "defaultRole" "ResidencyRole",
    "defaultMovedInOn" TEXT,
    "mappingSavedAt" TIMESTAMPTZ(6) NOT NULL,
    "appliedDigest" TEXT,
    "appliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_source_key_key" ON "import_source"("key");
