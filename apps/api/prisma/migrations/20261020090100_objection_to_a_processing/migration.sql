-- An objection can name one processing (ADR 0035): a plugin's row in the record
-- of processing activities. A granted, open request naming one is what the host
-- reads to leave the person out of that plugin's reads of the address book.
-- Null on every existing row, which keeps them objections to the communications.
ALTER TABLE "data_subject_request" ADD COLUMN "processingActivityId" TEXT;

CREATE INDEX "data_subject_request_processingActivityId_closedAt_idx" ON "data_subject_request"("processingActivityId", "closedAt");

ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_processingActivityId_fkey" FOREIGN KEY ("processingActivityId") REFERENCES "processing_activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
