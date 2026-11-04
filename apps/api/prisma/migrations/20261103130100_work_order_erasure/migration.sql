-- A work order's recipient is erased when its contractor is removed from the
-- list, and its text when the retention window after its issue was closed has
-- run out. The row stays either way.
ALTER TABLE "work_order" ALTER COLUMN "recipientName" DROP NOT NULL,
  ALTER COLUMN "recipientEmailCipher" DROP NOT NULL,
  ALTER COLUMN "body" DROP NOT NULL;

-- The sender's own work orders in the last hour, for the sending budget.
DROP INDEX "work_order_sentByPersonId_idx";
CREATE INDEX "work_order_sentByPersonId_createdAt_idx" ON "work_order"("sentByPersonId", "createdAt");
