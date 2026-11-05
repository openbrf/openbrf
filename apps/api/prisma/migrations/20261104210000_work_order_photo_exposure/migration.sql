-- The photographs a work order's link has shown a contractor, kept so the data
-- subject access report can state how many were disclosed after the choice is
-- changed or a file is removed (ADR 0055, GDPR art. 15(1)(c)).
--
-- One row per photograph per work order. The file reference is cleared when
-- the file goes, and the row stays: the count outlives the file. The contractor's
-- link is unreleased when this runs, so there is nothing to carry over.

CREATE TABLE "work_order_photo_exposure" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "fileId" TEXT,
    "exposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_order_photo_exposure_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "work_order_photo_exposure_fileId_idx" ON "work_order_photo_exposure"("fileId");

CREATE UNIQUE INDEX "work_order_photo_exposure_workOrderId_fileId_key" ON "work_order_photo_exposure"("workOrderId", "fileId");

ALTER TABLE "work_order_photo_exposure" ADD CONSTRAINT "work_order_photo_exposure_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_photo_exposure" ADD CONSTRAINT "work_order_photo_exposure_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "media_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;
