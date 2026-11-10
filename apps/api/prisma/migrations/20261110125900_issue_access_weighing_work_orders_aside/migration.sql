-- Sets the weighings of work orders' text aside before
-- `20261110130000_issue_access_weighing_unique` holds a text to one weighing per
-- report, and `20261110140300_issue_access_weighing_work_orders_back` puts them
-- back once `20261110140200_issue_access_weighing_text_key_work_order` has built
-- the index that tells one work order from another (ADR 0057, question 7).
--
-- On a database built in the order of the migrations this does nothing: the
-- table has no work order yet. It acts on a database that took the work-order
-- migrations (`20261110140000` and `20261110140100`) before the uniqueness one,
-- which then runs out of order. That one names a message or a note, not a work
-- order, so it would take the weighings of two work orders of one issue for one
-- text weighed twice and delete both, and its index would hold every work order
-- of an issue to one weighing. Out of the table here, they are neither.
--
-- The rows go to a table of their own rather than a temporary one: Prisma may
-- run the next migrations on another connection. It holds the board's copies
-- given in part, the issue's free text, only until the migration that puts them
-- back drops it, a few statements later in the same deploy.
--
-- One statement, so a failure leaves no row moved and no table behind.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'issue_access_weighing'
      AND column_name = 'workOrderId'
  ) THEN
    CREATE TABLE "issue_access_weighing_work_order_aside" AS
      SELECT
        "id",
        "issueId",
        "concernedPersonId",
        "part",
        "workOrderId",
        "withheldBecause",
        "givenText",
        "weighedAt"
      FROM "issue_access_weighing"
      WHERE "part" = 'WORK_ORDER';

    DELETE FROM "issue_access_weighing" WHERE "part" = 'WORK_ORDER';
  END IF;
END
$migration$;
