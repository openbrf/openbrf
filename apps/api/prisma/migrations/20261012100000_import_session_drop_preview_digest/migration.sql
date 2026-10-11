-- The apply no longer plans the file again, so it has no plan to compare.
--
-- "previewDigest" let the request that starts an import plan the file with the
-- board's decisions and check the plan against the preview's. That plan now
-- belongs to the preview job: the apply starts only with the decisions the
-- preview was planned with ("decisions"), and the screen previews again with
-- any others. No data is lost: the digest named nothing but itself.

-- AlterTable
ALTER TABLE "import_session" DROP COLUMN "previewDigest";
