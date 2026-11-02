-- Whether a record's subject chose to have their name, and a resident their
-- apartment, shown to the others the plugin serves (ADR 0053). False on every
-- record written before the flag existed, which nobody chose to show. A column
-- with a constant default, so PostgreSQL adds it without rewriting the table.
ALTER TABLE "plugin_record" ADD COLUMN "showSubject" BOOLEAN NOT NULL DEFAULT false;
