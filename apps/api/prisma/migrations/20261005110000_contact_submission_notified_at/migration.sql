-- AlterTable
ALTER TABLE "contact_submission" ADD COLUMN "notifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "contact_submission_notifiedAt_idx" ON "contact_submission"("notifiedAt");
