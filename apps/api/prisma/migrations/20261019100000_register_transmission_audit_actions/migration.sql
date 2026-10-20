-- Two acts the port to Lantmateriet adds (ADR 0029): handing a report over, and
-- Lantmateriet refusing one.
--
-- REGISTER_REPORT_TRANSMITTED is the disclosure. It is written and committed
-- before the report leaves, naming every person whose personal identity number
-- it carries, so a crash or a lost connection after the hand-over cannot leave
-- a disclosure unrecorded. A received answer is not a new action: it is
-- REGISTER_REPORT_MADE, the entry the queue already reads a discharge from,
-- carrying Lantmateriet's day and reference.
--
-- REGISTER_REPORT_REJECTED is Lantmateriet's refusal, with its reason codes.
-- The duty it was about stays owed; nothing on the ledger changes, and nothing
-- could, since the ledger is append-only.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it: a migration file is sent as one script,
-- which the server runs as a single implicit transaction, so the values must be
-- committed by this file before any later one uses them.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REGISTER_REPORT_TRANSMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REGISTER_REPORT_REJECTED';
