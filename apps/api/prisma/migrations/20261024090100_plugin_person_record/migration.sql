-- A plugin's records about a person (ADR 0047), in ADR 0033's table.
--
-- Three nullable columns: the person a record is about, the day it is erased
-- on, and when it was set aside. A record of `host.records` has none of them.
--
-- A row gets an id of its own, and plugin, collection and key stop being the
-- primary key: they become a partial unique index over the live rows, those
-- not set aside, so exactly one live row holds a key and any number of rows a
-- legal hold or a restriction keeps may stand beside it. Written here rather
-- than in the schema, as `page_one_front_page` is, because the schema cannot
-- say "where".
--
-- And the cascade from the installed plugin goes. A removal would take a
-- record a hold keeps with the plugin's row, so the host deletes what removal
-- deletes itself, in the transaction that deletes the row, and the column
-- holds the manifest id as text.

-- DropForeignKey
ALTER TABLE "plugin_record" DROP CONSTRAINT "plugin_record_pluginId_fkey";

-- DropPrimaryKey
ALTER TABLE "plugin_record" DROP CONSTRAINT "plugin_record_pkey";

-- AlterTable: the id, filled for the rows already held, and the new columns.
ALTER TABLE "plugin_record"
  ADD COLUMN "id" TEXT,
  ADD COLUMN "subjectPersonId" TEXT,
  ADD COLUMN "eraseOn" DATE,
  ADD COLUMN "setAsideAt" TIMESTAMP(3),
  ADD COLUMN "createdAt" TIMESTAMP(3);

UPDATE "plugin_record"
  SET "id" = gen_random_uuid()::text,
      "createdAt" = "updatedAt";

ALTER TABLE "plugin_record"
  ALTER COLUMN "id" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AddPrimaryKey
ALTER TABLE "plugin_record" ADD CONSTRAINT "plugin_record_pkey" PRIMARY KEY ("id");

-- One live row per key.
CREATE UNIQUE INDEX "plugin_record_live_key"
  ON "plugin_record" ("pluginId", "collection", "key")
  WHERE "setAsideAt" IS NULL;

-- CreateIndex: every row under a key, for a removal and the limits.
CREATE INDEX "plugin_record_pluginId_collection_key_idx"
  ON "plugin_record"("pluginId", "collection", "key");

-- CreateIndex: a person's records, for the access report and erasure.
CREATE INDEX "plugin_record_subjectPersonId_idx" ON "plugin_record"("subjectPersonId");

-- CreateIndex: the records whose day has come, for the purge.
CREATE INDEX "plugin_record_eraseOn_idx" ON "plugin_record"("eraseOn");

-- A record about a person names one and carries its erase date, and only such a
-- record is ever set aside: the host checks both before it writes, and they are
-- held here as well, so a row written past the host cannot be a record about a
-- person the purge never reaches.
ALTER TABLE "plugin_record"
  ADD CONSTRAINT "plugin_record_subject_has_erase_date"
  CHECK (("subjectPersonId" IS NULL) = ("eraseOn" IS NULL));

ALTER TABLE "plugin_record"
  ADD CONSTRAINT "plugin_record_set_aside_has_subject"
  CHECK ("setAsideAt" IS NULL OR "subjectPersonId" IS NOT NULL);

-- What the board consented to a plugin keeping about a person, and the legal
-- basis its processing declared (ADR 0047). An installed plugin consented to
-- before this keeps none.
ALTER TABLE "installed_plugin"
  ADD COLUMN "consentedPersonRecords" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "consentedLegalBasis" TEXT;
