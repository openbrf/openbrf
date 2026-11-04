-- The contractor register and the work orders handlers send from an issue
-- (decision 23 of the issue module's plan), mailed while the contractor's own
-- link is switched off (decision 25, ADR 0055).
--
-- A contractor's telephone number and address, and the address a work order
-- went to, are stored encrypted, as a reporter's address is.
--
-- A work order keeps its own copy of whom it went to, so a contractor removed
-- from the register leaves the record of what was sent them: the key to the
-- register sets null, and the key to the issue cascades with it.
--
-- `ringFenced` on a type starts false on every row: nothing was ring-fenced
-- before this change, and nothing is derived for a row nobody decided about.
ALTER TABLE "issue_type" ADD COLUMN "ringFenced" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "WorkOrderDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "contractor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "phoneCipher" TEXT,
    "emailCipher" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_order" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "contractorId" TEXT,
    "recipientName" TEXT NOT NULL,
    "recipientEmailCipher" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentByPersonId" TEXT,
    "deliveryStatus" "WorkOrderDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryFailure" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_order_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contractor_active_name_idx" ON "contractor"("active", "name");

CREATE INDEX "work_order_issueId_createdAt_idx" ON "work_order"("issueId", "createdAt");

CREATE INDEX "work_order_contractorId_idx" ON "work_order"("contractorId");

CREATE INDEX "work_order_sentByPersonId_idx" ON "work_order"("sentByPersonId");

ALTER TABLE "work_order" ADD CONSTRAINT "work_order_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order" ADD CONSTRAINT "work_order_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
