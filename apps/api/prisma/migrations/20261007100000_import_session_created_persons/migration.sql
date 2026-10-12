-- The persons an import has created, so a later chunk can tell them apart from
-- persons the register gained since the preview.
--
-- "createdPersons" maps a row the apply wrote as a new person to that person.
-- The preview lists only persons already in the register as a row's
-- candidates. A chunk planned after an earlier chunk created one of them finds
-- that person in the register, so it sets these aside before comparing a row
-- the board answered with the candidates the preview showed. Anybody else is
-- somebody the board never chose against, and the import stops.
--
-- Nullable, and needs no backfill. An import already running has no persons
-- recorded. A row of it that the board answered, and that matches a person an
-- earlier chunk created, stops the import as outdated rather than being
-- written past them.

-- AlterTable
ALTER TABLE "import_session" ADD COLUMN     "createdPersons" JSONB;
