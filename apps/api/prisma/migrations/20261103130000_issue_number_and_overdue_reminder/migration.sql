-- The issue number (ärendenummer) and the overdue reminder's marker.
--
-- The number is what every mail about an issue calls it, since a mail carries
-- no free text (decision 21 of the issue module plan): the number, the type, the
-- priority and a link. Existing issues are numbered in the order they were
-- filed, oldest first, with the identifier to break a tie between two filed in
-- one instant, and the sequence goes on from the highest. The same steps a
-- `SERIAL` column takes, written out so the existing rows are numbered in that
-- order rather than in whatever order the table is stored in.
--
-- All of it in the migration's transaction, so the numbering, the default and
-- the unique index commit together. The UPDATE, the NOT NULL check and the
-- index build each hold the issue table's lock while they run, which is why the
-- index is not built CONCURRENTLY (a transaction cannot) and why the
-- application is stopped before an upgrade (docs/deployment.md, "The upgrade,
-- step by step"). An association's issue table is a few thousand rows.
CREATE SEQUENCE "issue_number_seq" AS INTEGER;

ALTER TABLE "issue" ADD COLUMN "number" INTEGER;

UPDATE "issue"
SET "number" = "numbered"."n"
FROM (
  SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS "n"
  FROM "issue"
) AS "numbered"
WHERE "issue"."id" = "numbered"."id";

-- `false`: the next value handed out is this one, not the one after it. An
-- empty table starts at 1.
SELECT setval(
  '"issue_number_seq"',
  COALESCE((SELECT max("number") FROM "issue"), 0) + 1,
  false
);

ALTER TABLE "issue"
  ALTER COLUMN "number" SET DEFAULT nextval('"issue_number_seq"'),
  ALTER COLUMN "number" SET NOT NULL;

ALTER SEQUENCE "issue_number_seq" OWNED BY "issue"."number";

CREATE UNIQUE INDEX "issue_number_key" ON "issue"("number");

-- The target date the assignee was last reminded of; null on every existing
-- issue, which has had no reminder.
ALTER TABLE "issue" ADD COLUMN "overdueRemindedFor" DATE;
