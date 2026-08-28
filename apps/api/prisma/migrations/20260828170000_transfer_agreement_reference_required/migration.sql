-- The apartment register extract states a reference to the agreement behind
-- every transfer it lists (BRL 9 kap.), and the extract prints what these
-- columns hold. Left nullable on both sides, it could print a transfer with no
-- reference at all, on a row the database will not let anyone delete.
--
-- The constraint asks for one of the two places a reference lives rather than
-- for "agreementReference" alone: the board's own reference - a case number, or
-- where the paper copy is filed - or the path of an uploaded agreement. An
-- upload therefore satisfies the same requirement without a second migration,
-- and a cooperative that keeps its agreements on paper is not forced to invent
-- a file.
--
-- NOT VALID, and deliberately so. A transfer written before this constraint has
-- no reference and there is none to be found for it; backfilling a placeholder
-- would put a statement into a statutory register that nobody made, which is
-- worse than an absence the extract can name. The constraint binds every insert
-- and every update from here on and leaves the rows it cannot speak for as they
-- are. The register extract names such a row as having no reference recorded
-- rather than printing an empty space.
--
-- Prisma has no syntax for a CHECK constraint, so this is not represented in
-- schema.prisma; the field's doc comment points here.
ALTER TABLE "transfer"
  ADD CONSTRAINT "transfer_agreement_reference_present"
  CHECK (
    btrim(COALESCE("agreementReference", '')) <> ''
    OR btrim(COALESCE("agreementDocumentPath", '')) <> ''
  ) NOT VALID;
