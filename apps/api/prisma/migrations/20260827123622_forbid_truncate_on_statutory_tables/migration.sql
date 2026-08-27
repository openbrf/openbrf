-- Closes a gap in the append-only guards added in
-- 20260827122611_statutory_append_only_guards.
--
-- TRUNCATE does not fire row-level BEFORE DELETE triggers, so the whole
-- statutory archive could be emptied in one statement while every row-level
-- guard stayed silent. Postgres treats TRUNCATE as its own privilege and its
-- own trigger event, so both halves need to be stated explicitly.
--
-- The application role is never granted TRUNCATE (see
-- prisma/sql/harden-runtime-role.sql, which grants only SELECT, INSERT, UPDATE
-- and DELETE). This statement-level trigger additionally stops the schema
-- owner, which is the role that runs migrations and maintenance scripts.

CREATE OR REPLACE FUNCTION openbrf_forbid_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is part of the statutory archive: TRUNCATE is not permitted',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER member_register_entry_no_truncate
  BEFORE TRUNCATE ON "member_register_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION openbrf_forbid_truncate();

CREATE TRIGGER audit_log_entry_no_truncate
  BEFORE TRUNCATE ON "audit_log_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION openbrf_forbid_truncate();

CREATE TRIGGER transfer_no_truncate
  BEFORE TRUNCATE ON "transfer"
  FOR EACH STATEMENT EXECUTE FUNCTION openbrf_forbid_truncate();

CREATE TRIGGER lien_note_no_truncate
  BEFORE TRUNCATE ON "lien_note"
  FOR EACH STATEMENT EXECUTE FUNCTION openbrf_forbid_truncate();
