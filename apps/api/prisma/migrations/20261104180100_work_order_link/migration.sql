-- A contractor's link to one work order (decision 24 of the issue module plan,
-- ADR 0055), built behind a switch that is off until the legal review clears
-- it (decision 25): the link, the photographs the board chose for it, and the
-- contractor's answer, notes and photographs.
--
-- The token is never stored: only its SHA-256 digest, unique, which is what a
-- request is looked up by.

CREATE TYPE "WorkOrderAnswer" AS ENUM ('ACCEPTED', 'DECLINED', 'DONE');

ALTER TABLE "work_order" ADD COLUMN "answer" "WorkOrderAnswer",
ADD COLUMN "answeredAt" TIMESTAMP(3),
-- An answer has a time, and a time is an answer's.
ADD CONSTRAINT "work_order_answer_has_time" CHECK (("answer" IS NULL) = ("answeredAt" IS NULL));

CREATE TABLE "work_order_link" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "work_order_link_pkey" PRIMARY KEY ("id"),
    -- A SHA-256 digest in unpadded base64url is 43 characters of that
    -- alphabet. Anything else is not a digest, and a column that could hold
    -- the token itself is the one mistake this table must not allow.
    CONSTRAINT "work_order_link_digest_shape" CHECK ("tokenDigest" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE TABLE "work_order_photo" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "work_order_photo_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_order_note" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "redactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_order_note_pkey" PRIMARY KEY ("id"),
    -- A redacted note keeps no words.
    CONSTRAINT "work_order_note_redacted_empty" CHECK ("redactedAt" IS NULL OR "body" = '')
);

CREATE TABLE "work_order_file" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_order_file_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_order_link_tokenDigest_key" ON "work_order_link"("tokenDigest");

CREATE INDEX "work_order_link_workOrderId_idx" ON "work_order_link"("workOrderId");

-- One live link per work order at most: issuing a new one revokes the one
-- before in the same transaction, and two issued at once cannot both stand.
CREATE UNIQUE INDEX "work_order_link_one_unrevoked" ON "work_order_link"("workOrderId") WHERE "revokedAt" IS NULL;

CREATE INDEX "work_order_photo_fileId_idx" ON "work_order_photo"("fileId");

CREATE UNIQUE INDEX "work_order_photo_workOrderId_fileId_key" ON "work_order_photo"("workOrderId", "fileId");

CREATE INDEX "work_order_note_workOrderId_createdAt_idx" ON "work_order_note"("workOrderId", "createdAt");

CREATE UNIQUE INDEX "work_order_file_fileId_key" ON "work_order_file"("fileId");

CREATE INDEX "work_order_file_workOrderId_sortOrder_idx" ON "work_order_file"("workOrderId", "sortOrder");

ALTER TABLE "work_order_link" ADD CONSTRAINT "work_order_link_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_photo" ADD CONSTRAINT "work_order_photo_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_photo" ADD CONSTRAINT "work_order_photo_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "media_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_note" ADD CONSTRAINT "work_order_note_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_file" ADD CONSTRAINT "work_order_file_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_file" ADD CONSTRAINT "work_order_file_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "media_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
