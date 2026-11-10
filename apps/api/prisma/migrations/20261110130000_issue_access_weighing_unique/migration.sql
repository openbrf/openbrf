-- One weighing per text and report (ADR 0057). Without it a second row on the
-- same text could stand beside the first, and a report reading one of them
-- could give a text the other left out.
--
-- A unique index on expressions, written here alone: the reporter's report has
-- no record (`concernedPersonId` is null) and the description and the location
-- name no message or note, and PostgreSQL holds nulls distinct in a plain
-- unique key. `COALESCE` folds each to the empty string, which no identifier
-- is (they are cuids). The schema cannot declare an index on expressions, so
-- the model's comment names it. The message and the note fold into one column:
-- the part is in the key, and the part check allows at most one of them.
--
-- In one transaction, so a failure leaves no rows deleted and no index. Not
-- built CONCURRENTLY, which cannot run in one: the table came in the migration
-- before this one and holds at most a row per text and report weighed, so the
-- lock is short.
BEGIN;

-- A text weighed twice for one report is left unweighed, both rows removed,
-- rather than one kept: which of them the board meant cannot be told, and an
-- unweighed text is given in nothing until the board weighs it again.
DELETE FROM "issue_access_weighing" AS "row"
USING "issue_access_weighing" AS "other"
WHERE "other"."id" <> "row"."id"
  AND "other"."issueId" = "row"."issueId"
  AND "other"."concernedPersonId" IS NOT DISTINCT FROM "row"."concernedPersonId"
  AND "other"."part" = "row"."part"
  AND "other"."messageId" IS NOT DISTINCT FROM "row"."messageId"
  AND "other"."noteId" IS NOT DISTINCT FROM "row"."noteId";

CREATE UNIQUE INDEX "issue_access_weighing_text_key"
  ON "issue_access_weighing" (
    "issueId",
    COALESCE("concernedPersonId", ''),
    "part",
    COALESCE("messageId", "noteId", '')
  );

COMMIT;
