-- Fixes what the application sees when a statutory guard fires.
--
-- The guards raised with ERRCODE 'restrict_violation', which is SQLSTATE
-- 23001 and therefore inside the integrity-constraint-violation class. Prisma
-- maps that whole class onto its own constraint errors, so every guard
-- surfaced as "Foreign key constraint violated" and the actual reason was
-- lost. The board would have been shown a foreign key error for an attempt to
-- rewrite the member register, and application code had no way to tell a real
-- referential problem from an archive violation.
--
-- P0001 (raise_exception, the default for RAISE) is outside that class, so
-- Prisma passes the message through untouched. The message carries a stable
-- marker so application code can match on it rather than on prose.

CREATE OR REPLACE FUNCTION openbrf_forbid_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'OPENBRF_STATUTORY_ARCHIVE: % is not permitted on %',
    TG_OP, TG_TABLE_NAME
    USING
      ERRCODE = 'raise_exception',
      HINT = 'This table is part of the statutory archive and may only be appended to.';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION openbrf_forbid_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'OPENBRF_STATUTORY_ARCHIVE: TRUNCATE is not permitted on %',
    TG_TABLE_NAME
    USING
      ERRCODE = 'raise_exception',
      HINT = 'This table is part of the statutory archive and may only be appended to.';
END;
$$ LANGUAGE plpgsql;
