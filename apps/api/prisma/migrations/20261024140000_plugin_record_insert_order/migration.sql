-- The order a plugin's records were inserted in (ADR 0047), which orders the
-- versions a legal hold keeps under one key.
--
-- `setAsideAt` and `revision` together do not: two rows set aside at one
-- instant share the first, and a key deleted under a hold and written again
-- starts the second at 1 again, so the older version sorted after the newer
-- one and the bound deleted the newer.
--
-- What `BIGSERIAL` would add, spelled out so the rows already stored are
-- numbered in the order the host read them in until now - set aside by when
-- and then by revision, before the live rows - rather than in whatever order
-- the table holds them.
ALTER TABLE "plugin_record" ADD COLUMN "insertOrder" BIGINT;

UPDATE "plugin_record"
  SET "insertOrder" = numbered.position
  FROM (
    SELECT "id", row_number() OVER (
      ORDER BY ("setAsideAt" IS NULL), "setAsideAt", "revision", "id"
    ) AS position
    FROM "plugin_record"
  ) AS numbered
  WHERE "plugin_record"."id" = numbered."id";

CREATE SEQUENCE "plugin_record_insertOrder_seq"
  OWNED BY "plugin_record"."insertOrder";

-- The next row inserted comes after every row numbered above.
SELECT setval(
  '"plugin_record_insertOrder_seq"',
  COALESCE((SELECT max("insertOrder") FROM "plugin_record"), 0) + 1,
  false
);

ALTER TABLE "plugin_record"
  ALTER COLUMN "insertOrder" SET NOT NULL,
  ALTER COLUMN "insertOrder" SET DEFAULT nextval('"plugin_record_insertOrder_seq"');
