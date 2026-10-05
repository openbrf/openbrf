-- Plans the preview in a background job.
--
-- Matching a file against a register that holds personal identity numbers is
-- an Argon2id hash per row, which on the largest file the upload accepts is
-- minutes inside one HTTP request. The preview request now records the mapping
-- and queues a job; the screen polls the job by its id, and the plan is stored
-- encrypted on the session until the import is claimed.
CREATE TYPE "ImportPreviewStatus" AS ENUM ('PLANNING', 'READY', 'FAILED');

ALTER TABLE "import_session"
  ADD COLUMN "previewId" TEXT,
  ADD COLUMN "previewStatus" "ImportPreviewStatus",
  ADD COLUMN "previewRowsDone" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "previewFailureReason" TEXT,
  ADD COLUMN "previewWatchedAt" TIMESTAMP(3),
  ADD COLUMN "previewCipher" TEXT;

-- A session previewed before this migration holds a token and a recorded
-- mapping but no stored plan. It stays appliable with that token; the screen
-- that held it previews again after a reload either way.
UPDATE "import_session"
  SET "previewStatus" = 'READY'
  WHERE "previewToken" IS NOT NULL;
