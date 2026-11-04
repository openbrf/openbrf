-- Trigram indexes on the text of issue messages and internal notes, for the
-- queue's search (ADR 0054, `IssueService.searchWhere`).
--
-- The search matches each of its words anywhere in a message or a note, case
-- aside, as ILIKE '%word%', once per word and Unicode form. A B-tree cannot
-- answer a pattern that starts with a wildcard, so without these every word
-- read every message and every note in the database, whichever issues the
-- reader handles, and the screen reads a view's list and four counts for each
-- search. With 100,000 messages and 40,000 notes one count and one page took
-- about a second for one word and almost three for six; with these, about a
-- seventh of a second for either. A trigram index finds the rows that may hold
-- the word, and PostgreSQL checks each of them against the pattern itself, so
-- what a search matches does not change. A word shorter than three characters
-- has no trigram and is still matched by reading the table.
--
-- pg_trgm ships with PostgreSQL's contrib modules, in the image
-- docker-compose.prod.yml runs and on the common managed servers. It is a
-- trusted extension, so the schema owner, which owns the database and is not a
-- superuser, may create it (docs/deployment.md). Its functions belong to the
-- server's bootstrap superuser, and docker/schema-owner.sql leaves them alone,
-- as it leaves everything an extension installed.
--
-- Built in the migration's transaction rather than CONCURRENTLY, which a
-- transaction cannot do. Both tables arrive in the same release as this
-- (20261103120100_issue_conversation), so no instance holds a row in them yet
-- and the build holds their locks for no time.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX "issue_message_body_trgm_idx" ON "issue_message" USING GIN ("body" gin_trgm_ops);

CREATE INDEX "issue_note_body_trgm_idx" ON "issue_note" USING GIN ("body" gin_trgm_ops);
