-- The sheet row each data row of an import session was read from, so the
-- preview names a row by the number the board sees in the sheet rather than by
-- its place among the rows left once blank ones were dropped. A session
-- uploaded before this column existed has none and expires within a day; the
-- preview then counts from the header as before.
ALTER TABLE "import_session" ADD COLUMN "sourceRows" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
