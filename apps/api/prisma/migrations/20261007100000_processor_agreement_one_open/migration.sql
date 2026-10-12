-- One open processor agreement row per recipient.
--
-- `list` and `forPlugins` read the record through this rule: they key the open
-- rows by recipient, so two of them would leave one picked by map order and the
-- art. 28 record stating two classifications for one period. Until now only an
-- advisory lock taken by every writer held it, and a writer that skipped the
-- lock, or read before taking it, would break it with nothing to say so. The
-- lock stays as the path writers take; this index is the backstop that refuses
-- the second row whatever the writer did.
--
-- Partial, because a closed row is history and a recipient has one for every
-- classification it has had. Written by hand with no @@unique counterpart in
-- the schema: Prisma cannot express the WHERE clause.
--
-- The lock came after the table, so two classifications of one recipient that
-- arrived together before it could each have left a row open. Every open row
-- but the newest is closed as the replacement would have closed it, at the
-- moment the row replacing it was recorded, so the dated record still says
-- what held over each period.
WITH "open" AS (
  SELECT "id",
         LEAD("createdAt") OVER (
           PARTITION BY "processorKey"
           ORDER BY "createdAt", "id"
         ) AS "replacedAt"
  FROM "processor_agreement"
  WHERE "endedAt" IS NULL
)
UPDATE "processor_agreement" AS older
SET "endedAt" = "open"."replacedAt",
    "endReason" = 'replaced',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "open"
WHERE older."id" = "open"."id"
  AND "open"."replacedAt" IS NOT NULL;

CREATE UNIQUE INDEX "processor_agreement_one_open"
  ON "processor_agreement" ("processorKey")
  WHERE "endedAt" IS NULL;
