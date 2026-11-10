-- Puts back the weighings of work orders' text that
-- `20261110125900_issue_access_weighing_work_orders_aside` set aside, now that
-- `issue_access_weighing_text_key` tells one work order from another (ADR 0057,
-- question 7), and drops the table that held them.
--
-- On a database built in the order of the migrations nothing was set aside, and
-- this does nothing.
--
-- A work order weighed twice for one report is left unweighed, both rows
-- dropped, as `20261110130000_issue_access_weighing_unique` leaves any other
-- text weighed twice: which of them the board meant cannot be told, and an
-- unweighed text is given in nothing until the board weighs it again. A row
-- whose issue, record or work order has gone since is dropped with it, as the
-- keys would have dropped it in the table.
--
-- One statement, so a failure leaves the rows where they were set aside, and a
-- retry finds them there.
DO $migration$
BEGIN
  IF to_regclass('"issue_access_weighing_work_order_aside"') IS NOT NULL THEN
    INSERT INTO "issue_access_weighing" (
      "id",
      "issueId",
      "concernedPersonId",
      "part",
      "workOrderId",
      "withheldBecause",
      "givenText",
      "weighedAt"
    )
    SELECT
      "aside"."id",
      "aside"."issueId",
      "aside"."concernedPersonId",
      "aside"."part",
      "aside"."workOrderId",
      "aside"."withheldBecause",
      "aside"."givenText",
      "aside"."weighedAt"
    FROM "issue_access_weighing_work_order_aside" AS "aside"
    WHERE NOT EXISTS (
        SELECT 1
        FROM "issue_access_weighing_work_order_aside" AS "other"
        WHERE "other"."id" <> "aside"."id"
          AND "other"."issueId" = "aside"."issueId"
          AND "other"."concernedPersonId" IS NOT DISTINCT FROM "aside"."concernedPersonId"
          AND "other"."workOrderId" = "aside"."workOrderId"
      )
      AND EXISTS (
        SELECT 1 FROM "issue" WHERE "issue"."id" = "aside"."issueId"
      )
      AND EXISTS (
        SELECT 1 FROM "work_order" WHERE "work_order"."id" = "aside"."workOrderId"
      )
      AND (
        "aside"."concernedPersonId" IS NULL
        OR EXISTS (
          SELECT 1
          FROM "issue_concerned_person"
          WHERE "issue_concerned_person"."id" = "aside"."concernedPersonId"
        )
      )
    -- Nothing weighs a work order between the two migrations, which run in one
    -- deploy before the application starts; a weighing that did stands.
    ON CONFLICT DO NOTHING;

    DROP TABLE "issue_access_weighing_work_order_aside";
  END IF;
END
$migration$;
