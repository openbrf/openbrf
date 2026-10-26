-- Which record a row is a version of (ADR 0047): drawn at random when a key's
-- record is first written, carried onto the new live row when a hold sets the
-- old one aside, and gone with the record. A plugin's compare-and-set on
-- `host.personRecords` can name it beside the revision, which a record written
-- anew under the key after an erasure starts again from 1.
--
-- Every row already held gets one of its own, as the id did in
-- 20261024090100_plugin_person_record. A live row and the rows a hold set
-- aside under the same key get different ones, which nothing reads: only the
-- live row's is handed to the plugin.
--
-- The UPDATE and SET NOT NULL rewrite and scan the table under its lock. It
-- holds at most 10 000 live rows a plugin, so that is brief, and a plugin's
-- record writes wait for it rather than fail.
ALTER TABLE "plugin_record" ADD COLUMN "identity" TEXT;

UPDATE "plugin_record" SET "identity" = gen_random_uuid()::text;

ALTER TABLE "plugin_record" ALTER COLUMN "identity" SET NOT NULL;
