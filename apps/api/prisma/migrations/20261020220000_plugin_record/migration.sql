-- A plugin's own records (ADR 0033): JSON values a plugin keeps under a
-- collection and a key through `host.records`, configuration and never people.
--
-- Keyed by plugin, collection and key, and cascading from the installed
-- plugin, so removing a plugin deletes its records in the transaction that
-- deletes its row.
--
-- The key is compared in the "C" collation, so `list` returns a collection in
-- the order of the key's characters, whatever the database's own collation
-- does with case and punctuation: a plugin that numbers its keys with leading
-- zeros reads them back in that order.

-- CreateTable
CREATE TABLE "plugin_record" (
    "pluginId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "key" TEXT COLLATE "C" NOT NULL,
    "value" JSONB NOT NULL,
    "size" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_record_pkey" PRIMARY KEY ("pluginId","collection","key")
);

-- AddForeignKey
ALTER TABLE "plugin_record" ADD CONSTRAINT "plugin_record_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "installed_plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The host checks all three before it writes. Held here as well, so a row
-- written past the host - by hand, or by a later version that got one wrong -
-- cannot carry a name the host's patterns would refuse or a size its limits
-- would not count.
ALTER TABLE "plugin_record"
  ADD CONSTRAINT "plugin_record_collection_shape"
  CHECK (char_length("collection") <= 32
    AND "collection" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "plugin_record"
  ADD CONSTRAINT "plugin_record_key_shape"
  CHECK ("key" ~ '^[A-Za-z0-9._:-]{1,128}$');

ALTER TABLE "plugin_record"
  ADD CONSTRAINT "plugin_record_size_bounded"
  CHECK ("size" BETWEEN 1 AND 65536 AND "revision" >= 1);
