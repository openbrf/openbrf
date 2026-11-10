-- A weighing of a work order's text (ADR 0057, question 7): the work order it
-- weighs, named as a message or a note is, and gone with it. The work-order
-- text purge and a handler's redaction of the text, which keep the row and
-- empty its text, delete the weighing in their own transaction.
--
-- In one transaction, so a failure leaves neither the column nor a check
-- half replaced: Prisma runs each statement on its own.
BEGIN;

ALTER TABLE "issue_access_weighing" ADD COLUMN "workOrderId" TEXT;

-- A message, a note or a work order is named for its part and for no other,
-- so a row cannot weigh a text it does not identify.
ALTER TABLE "issue_access_weighing"
  DROP CONSTRAINT "issue_access_weighing_part_check";
ALTER TABLE "issue_access_weighing"
  ADD CONSTRAINT "issue_access_weighing_part_check" CHECK (
    ("part" = 'MESSAGE') = ("messageId" IS NOT NULL)
    AND ("part" = 'NOTE') = ("noteId" IS NOT NULL)
    AND ("part" = 'WORK_ORDER') = ("workOrderId" IS NOT NULL)
  );

-- The reporter's own report weighs the notes and the work orders' text, and
-- never for telling them who reported their own case.
ALTER TABLE "issue_access_weighing"
  DROP CONSTRAINT "issue_access_weighing_reporter_check";
ALTER TABLE "issue_access_weighing"
  ADD CONSTRAINT "issue_access_weighing_reporter_check" CHECK (
    "concernedPersonId" IS NOT NULL
    OR (
      "part" IN ('NOTE', 'WORK_ORDER')
      AND "withheldBecause" IS DISTINCT FROM 'IDENTIFIES_REPORTER'
    )
  );

-- Not CONCURRENTLY, which cannot run in a transaction: the table is new in
-- this release and holds a row per weighed text, so the build is brief.
CREATE INDEX "issue_access_weighing_workOrderId_idx"
  ON "issue_access_weighing"("workOrderId");

ALTER TABLE "issue_access_weighing"
  ADD CONSTRAINT "issue_access_weighing_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "work_order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
