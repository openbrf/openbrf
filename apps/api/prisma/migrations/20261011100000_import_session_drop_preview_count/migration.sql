-- The preview token names one preview, so the count no longer has to.
--
-- "previewCount" told an apply whether the session had been previewed again
-- since the apply read it. The preview token does the same: asking for another
-- preview clears it, its job issues a new one, and the apply claims the session
-- only while it still holds the token the screen sent. No data is lost: the
-- count named nothing but itself.

-- AlterTable
ALTER TABLE "import_session" DROP COLUMN "previewCount";
