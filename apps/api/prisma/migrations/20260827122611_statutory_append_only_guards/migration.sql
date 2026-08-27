-- Statutory tier guards, enforced in the database rather than only in
-- application code: a bug in an admin screen must not be able to destroy the
-- member register (EFL 5 kap. via BRL 9 kap., decision 21).
--
-- Postgres RULES are deliberately not used here; they are a legacy feature
-- with well known surprises. Triggers plus revoked privileges are the
-- mechanism, and the privilege half lives in prisma/sql/harden-runtime-role.sql
-- because it needs a role separate from the migration owner.

CREATE OR REPLACE FUNCTION openbrf_forbid_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is part of the statutory archive: % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- The member register is strictly append-only. A correction is a new row with
-- eventType = 'CORRECTION' that references the entry it supersedes, never an
-- UPDATE of the original.
CREATE TRIGGER member_register_entry_append_only
  BEFORE UPDATE OR DELETE ON "member_register_entry"
  FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();

-- Transfers and lien notes are apartment register content: history may never
-- be deleted, but UPDATE stays available because releasing a lien sets
-- releasedOn, and a mis-keyed entry has to be correctable. Those updates are
-- audit-logged by the application.
CREATE TRIGGER transfer_no_delete
  BEFORE DELETE ON "transfer"
  FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();

CREATE TRIGGER lien_note_no_delete
  BEFORE DELETE ON "lien_note"
  FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();

-- The audit log is evidence: it may grow but never be rewritten.
CREATE TRIGGER audit_log_entry_append_only
  BEFORE UPDATE OR DELETE ON "audit_log_entry"
  FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();

-- One instance serves exactly one association, so the singleton row is pinned
-- rather than merely conventional.
ALTER TABLE "association"
  ADD CONSTRAINT "association_is_singleton" CHECK ("id" = 1);
