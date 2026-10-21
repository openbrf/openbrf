-- Delivery receipts: a plugin's record that a fee notice or a charge left the
-- association by a route, at a time, under a reference the receiving system
-- knows it by.
--
-- A receipt and never a paid flag. No paid column, no status and no balance,
-- here or on the rows it points at: the accounting system settles the debt,
-- and a second answer to whether something was paid is worse than none. The
-- notice and the charge are not touched by this migration.
--
-- Service tier, on the notice's and the charge's own reading, and erased with
-- them: both foreign keys cascade, so the fee purge and the charge purge take
-- the receipts along without knowing they exist, and so does the board
-- removing a charge entered by mistake. The audit entry that recorded the
-- receipt is append-only and stays, carrying no reference.
--
-- No column names a person. "pluginId" is a plain column rather than a foreign
-- key, so a plugin removed later leaves its receipts saying who recorded them.

-- CreateTable
CREATE TABLE "delivery_receipt" (
    "id" TEXT NOT NULL,
    "feeNoticeId" TEXT,
    "memberChargeId" TEXT,
    "pluginId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_receipt_feeNoticeId_idx" ON "delivery_receipt"("feeNoticeId");

-- CreateIndex
CREATE INDEX "delivery_receipt_memberChargeId_idx" ON "delivery_receipt"("memberChargeId");

-- AddForeignKey
ALTER TABLE "delivery_receipt" ADD CONSTRAINT "delivery_receipt_feeNoticeId_fkey" FOREIGN KEY ("feeNoticeId") REFERENCES "fee_notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_receipt" ADD CONSTRAINT "delivery_receipt_memberChargeId_fkey" FOREIGN KEY ("memberChargeId") REFERENCES "member_charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one target. A receipt naming both a notice and a charge would give
-- two answers to what was delivered, and one naming neither says nothing.
ALTER TABLE "delivery_receipt" ADD CONSTRAINT "delivery_receipt_one_target_check"
  CHECK (num_nonnulls("feeNoticeId", "memberChargeId") = 1);

-- The shapes the host accepts, held here as well so that a hand-written
-- statement cannot write what the API would refuse. The host refuses each first
-- with a reason a plugin can act on. A channel is the plugin's own word for a
-- route, in the characters a plugin id is written in; a reference is the
-- receiving system's identifier and nothing longer, with no control characters
-- for a log or a screen to trip over.
ALTER TABLE "delivery_receipt" ADD CONSTRAINT "delivery_receipt_channel_check"
  CHECK ("channel" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("channel") <= 32);
ALTER TABLE "delivery_receipt" ADD CONSTRAINT "delivery_receipt_reference_check"
  CHECK (
    char_length("reference") BETWEEN 1 AND 128
    AND "reference" !~ '[[:cntrl:]]'
  );

-- One receipt per plugin, target, route and reference. Written by hand,
-- because Prisma's schema has no way to say a unique index is partial; one
-- index per target, because the other target column is null on every row and
-- NULLs are distinct in a unique index. This is what makes a plugin's retried
-- job record one delivery once: the host reads the existing receipt back
-- instead of writing a second.
CREATE UNIQUE INDEX "delivery_receipt_fee_notice_unique"
  ON "delivery_receipt" ("feeNoticeId", "pluginId", "channel", "reference")
  WHERE "feeNoticeId" IS NOT NULL;
CREATE UNIQUE INDEX "delivery_receipt_member_charge_unique"
  ON "delivery_receipt" ("memberChargeId", "pluginId", "channel", "reference")
  WHERE "memberChargeId" IS NOT NULL;
