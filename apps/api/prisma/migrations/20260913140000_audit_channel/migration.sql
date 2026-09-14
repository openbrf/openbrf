-- Which way a change reached the association's records: the audit channel
-- (granskningskanal).
--
-- The log has always recorded who acted and what they did, and for as long as a
-- person in a browser was the only way in there was no route to record. Once a
-- token held by an external program can publish a news item and rearrange a
-- menu, the route is a fact about the act rather than about the person: the
-- same board member acting in the web interface and acting through a connected
-- app is one person reaching the records two ways, and only one of those ways
-- involves them reading what they signed. The column sits beside the actor
-- rather than replacing anything, so an entry says who, what, and now how.
--
-- Nullable with no default, and there is no backfill statement in this file.
-- Neither is an omission:
--
--   The table is append-only. A BEFORE UPDATE OR DELETE trigger installed by
--   20260827122611_statutory_append_only_guards rejects any rewrite of a row,
--   and the runtime role holds no UPDATE privilege on the table at all
--   (prisma/sql/harden-runtime-role.sql). A backfill is not something this
--   migration chooses against; it is something the table forbids.
--
--   A default of 'WEB' would be an assertion about history the log cannot
--   support. Rows written before this column existed were written by people in
--   the web interface, by nightly jobs and by seeds alike, and the log has no
--   way to tell them apart after the fact. Null says "written before the log
--   recorded the channel", which is true, and the data subject access report
--   prints exactly that sentence rather than a channel it invented.
--
-- Adding a column is safe against the trigger: it fires on UPDATE and DELETE of
-- a row, and ALTER TABLE is neither.
--
-- There is deliberately no column for the connected app that acted. The client
-- id and its host go into the existing context JSON under a reserved "client"
-- key that AuditLogService.record writes itself, so a call site cannot forget
-- them and this statutory table takes one structural change rather than three.
CREATE TYPE "AuditChannel" AS ENUM ('WEB', 'MCP', 'AI', 'SYSTEM', 'PLUGIN');

ALTER TABLE "audit_log_entry" ADD COLUMN "channel" "AuditChannel";

-- Answers "what has been done through connected apps", which is the question
-- the channel exists for and the one a board asks after granting a token.
-- Paired with createdAt because every reading of this log is bounded by a
-- period, and because the null rows form one large group the index lets a query
-- skip rather than scan.
CREATE INDEX "audit_log_entry_channel_createdAt_idx" ON "audit_log_entry"("channel", "createdAt");
