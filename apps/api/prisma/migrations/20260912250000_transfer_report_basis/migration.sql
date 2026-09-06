-- Which case of Lag (2026:484) 3 kap. 3 § an overgang is, and on what footing
-- the association's buildings stand on their land.
--
-- ## The overgang
--
-- 3 kap. 3 § is four rules and the register held one of them. Its own words:
--
--   Forsta stycket: "En anmalan for registrering av overgang ska goras av
--   bostadsrattsforeningen. En overgang till en sadan juridisk person som avses
--   i 6 kap. 1 § andra stycket bostadsrattslagen (1991:614) ska dock anmalas
--   for registrering av den juridiska personen."
--
--   Andra stycket: "Anmalan for registrering av overgang ska goras inom tva
--   veckor fran det att bostadsrattsforeningen beslutat om medlemskap i
--   foreningen. Vid overgang till nagon som redan ar medlem i foreningen eller
--   som inte omfattas av kravet pa medlemskap ska anmalan i stallet goras inom
--   tva veckor fran overgangen."
--
--   Fjarde stycket: "Om en bostadsratt har overgatt till foreningen, ska
--   anmalan goras inom tva veckor fran overgangen."
--
-- Until now the platform raised a duty only where the board recorded a
-- membership decision, so an overgang to a sitting member, to somebody outside
-- the membership requirement, or to the association raised none at all - each
-- of those looks exactly like a decision nobody has minuted yet, and the
-- register held nothing that told them apart. The column added here is that
-- something.
--
-- Stated by the board rather than inferred, which is the decision
-- 20260912200000 took about "kind" and is taken again for the same reason.
-- Whether the acquirer was already a member on the day, whether they fall
-- outside the membership requirement, and what a juridical person acquired the
-- bostadsratt at are facts about people and about a sale that this database does
-- not hold. A guess in a statutory register is a statement nobody made.
--
-- Nullable, and rows written earlier keep a null. Nothing derives a basis for
-- one, and such a row keeps the behaviour it was written under: its window opens
-- on "membershipDecidedOn" if the board ever records one.
--
-- ## The land
--
-- Forordning (2026:898) 2 kap. 4 § forsta stycket 4 registers "foreningens
-- lagfarts- och tomtrattsinnehav". Andra stycket: "Om bostadsrattsforeningens
-- byggnad eller byggnader star pa mark som foreningen varken ager eller innehar
-- med tomtratt, ska uppgift om fastighetsbeteckning, taxeringsenhetsnummer och
-- fastighetstyp redovisas i stallet for uppgift om lagfarts- eller
-- tomtrattsinnehav."
--
-- The designation has had a column since 20260905100000. The other two are
-- added here, together with the answer that decides whether they are reported
-- at all.
--
-- That answer is not on association_facts, and the roadmap and the glossary both
-- said it was. It holds "siteLeasehold", a boolean whose own doc comment reads
-- false as "the association owns the land" - so its three states are owns, holds
-- with tomtratt, and not recorded, and the case andra stycket turns on is a
-- fourth it cannot express. Beyond that, the facts page is prose a board writes
-- for a broker and that model forbids statutory data being derived from it,
-- which is why the designation is held twice already. The tenure is held on the
-- association singleton for both reasons.

-- CreateEnum
CREATE TYPE "TransferReportBasis" AS ENUM (
  'MEMBERSHIP_DECISION',
  'ALREADY_MEMBER',
  'OUTSIDE_MEMBERSHIP_REQUIREMENT',
  'TO_THE_ASSOCIATION',
  'LIENHOLDING_JURIDICAL_PERSON'
);

-- CreateEnum
--
-- Three values, because the forordning's question is three-way. OTHER is the
-- conditional case of andra stycket and the only one in which the two columns
-- below are reported.
CREATE TYPE "LandTenure" AS ENUM ('OWNERSHIP', 'SITE_LEASEHOLD', 'OTHER');

-- AlterTable
ALTER TABLE "transfer" ADD COLUMN "reportBasis" "TransferReportBasis";

-- Only an overgang has a case under 3 kap. 3 §.
--
-- An upplatelse is reported under 3 kap. 2 §, which has one rule and no cases,
-- so a basis on a GRANT would name a paragraph that does not reach it. A row
-- whose kind was never recorded is left alone: it carries no basis either, so
-- the constraint holds over the whole table and is added VALID rather than NOT
-- VALID - which matters, because NOT VALID is enforced on UPDATE and would make
-- exactly the grandfathered rows un-updatable. That is the trap
-- 20260912230000 was written to undo, and it is not walked into again here.
--
-- Stated as "not a GRANT" rather than "is a TRANSFER", so the condition is never
-- NULL. A CHECK admits a row whose condition evaluates to NULL, and
-- `"kind" = 'TRANSFER'` is NULL on a row whose kind was never recorded - the
-- right answer here, since such a row may still take a TRANSFER obligation, but
-- reached by accident rather than by saying so.
ALTER TABLE "transfer"
  ADD CONSTRAINT "transfer_report_basis_is_for_an_overgang"
  CHECK ("reportBasis" IS NULL OR "kind" IS DISTINCT FROM 'GRANT');

-- A membership decision date belongs to the case that has a decision.
--
-- The three cases whose window runs from the overgang itself have no decision to
-- date - that is what the second sentence of andra stycket and the fjarde
-- stycket say - and the juridical person's case is not the association's report
-- at all. A date beside any of them would be a second, contradictory answer to
-- which day the window opened, and the ledger reads that answer off these two
-- columns.
--
-- Rows written before either column existed carry a null basis and satisfy this,
-- so it too is added VALID.
ALTER TABLE "transfer"
  ADD CONSTRAINT "transfer_membership_decision_matches_basis"
  CHECK (
    "membershipDecidedOn" IS NULL
    OR "reportBasis" IS NULL
    OR "reportBasis" = 'MEMBERSHIP_DECISION'
  );

-- The write guard learns the third thing a transfer states.
--
-- 20260912230000 explains at length why this is a trigger and not a CHECK: the
-- rule is about the difference between the old row and the new one, and a NOT
-- VALID CHECK exempts a row only until something writes to it. The basis takes
-- the same shape as the kind beside it - fixed once stated, settable on a row
-- that never stated it - and for the same reason. The obligation computed from
-- it names a paragraph and a day, and that ledger refuses UPDATE and DELETE, so
-- a basis that could move would leave the association's own record of what it
-- owed stating a rule nobody chose.
--
-- Not required on INSERT, which is where it differs from the kind. The kind is
-- known to whoever records the move; the case under 3 kap. 3 § can be, but the
-- ordinary one is not settled until the board has decided on membership, and
-- requiring it at the insert would have the move flow ask for an answer the
-- board does not yet have. It is stated by its own later act instead - the same
-- act that records the decision date - which is where the audit entry for it is.
CREATE OR REPLACE FUNCTION openbrf_check_transfer_record()
RETURNS TRIGGER AS $$
DECLARE
  blank CONSTANT TEXT :=
    '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]';
  new_has_reference BOOLEAN;
  old_has_reference BOOLEAN;
BEGIN
  new_has_reference :=
    COALESCE(NEW."agreementReference", '') ~ blank
    OR COALESCE(NEW."agreementDocumentPath", '') ~ blank;

  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" IS NULL THEN
      RAISE EXCEPTION
        'OPENBRF_TRANSFER_RECORD: a row states whether it is a grant (upplatelse) or a transfer (overgang), because only a grant is reported under Lag (2026:484) 3 kap. 2 §'
        USING ERRCODE = 'raise_exception';
    END IF;

    IF NOT new_has_reference THEN
      RAISE EXCEPTION
        'OPENBRF_TRANSFER_RECORD: a transfer needs a reference to its agreement, which the apartment register extract states for every transfer it lists (BRL 9 kap.)'
        USING ERRCODE = 'raise_exception';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."kind" IS NOT NULL AND NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION
      'OPENBRF_TRANSFER_RECORD: a row that states which register event it is may not restate it, because the reporting obligation computed from it cannot be corrected'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."reportBasis" IS NOT NULL
     AND NEW."reportBasis" IS DISTINCT FROM OLD."reportBasis" THEN
    RAISE EXCEPTION
      'OPENBRF_TRANSFER_RECORD: a row that states which case of Lag (2026:484) 3 kap. 3 § it falls in may not restate it, because the reporting obligation computed from it cannot be corrected'
      USING ERRCODE = 'raise_exception';
  END IF;

  old_has_reference :=
    COALESCE(OLD."agreementReference", '') ~ blank
    OR COALESCE(OLD."agreementDocumentPath", '') ~ blank;

  IF old_has_reference AND NOT new_has_reference THEN
    RAISE EXCEPTION
      'OPENBRF_TRANSFER_RECORD: a transfer that carries a reference to its agreement may not have it removed'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AlterTable
--
-- No append-only guard and no REVOKE, for the reason 20260905100000 gives about
-- the property designation beside these: the land is held on a footing that can
-- change, and a value recorded in error has to be correctable in place. The
-- audit log carries what each was changed from and to.
ALTER TABLE "association" ADD COLUMN "landTenure" "LandTenure";
ALTER TABLE "association" ADD COLUMN "taxAssessmentUnitNumber" TEXT;
ALTER TABLE "association" ADD COLUMN "propertyType" TEXT;

-- The two conditional fields are recordable only in the case that reports them.
--
-- Andra stycket reports taxeringsenhetsnummer and fastighetstyp "i stallet for"
-- the lagfarts- och tomtrattsinnehav, in the one case where the association
-- holds neither. An association that owns its land or holds a tomtratt has no
-- occasion to state them, and a value sitting there would go into a supply file
-- under a paragraph that does not apply to it.
--
-- The single row this table holds carries nulls in all three columns, so the
-- constraint is added VALID.
--
-- A CASE and not two OR'd branches, because a CHECK admits a row whose condition
-- evaluates to NULL. Written as `(both IS NULL) OR "landTenure" = 'OTHER'`, a row
-- with no tenure recorded and a fastighetstyp stated gives FALSE OR NULL, which
-- is NULL, and the row is accepted - so a conditional field could be recorded
-- beside no answer at all and go into a supply file under a paragraph nobody
-- said applied. The WHEN is NULL in that case and falls through to an ELSE that
-- never is.
--
-- The whitespace class is 20260828180000's, unchanged: String.prototype.trim's
-- set written out, enumerated rather than [[:space:]] because that class is
-- locale-dependent and a statutory constraint may not mean different things on
-- different deployments. A field made of spaces is not a recorded value, and the
-- alternative to enforcing that here is a supply file with a column of blanks
-- that reads as a register that lost one.
ALTER TABLE "association"
  ADD CONSTRAINT "association_conditional_property_fields"
  CHECK (
    CASE
      WHEN "landTenure" = 'OTHER' THEN TRUE
      ELSE "taxAssessmentUnitNumber" IS NULL AND "propertyType" IS NULL
    END
  );

ALTER TABLE "association"
  ADD CONSTRAINT "association_property_fields_present"
  CHECK (
    (
      "taxAssessmentUnitNumber" IS NULL
      OR "taxAssessmentUnitNumber" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]'
    )
    AND (
      "propertyType" IS NULL
      OR "propertyType" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]'
    )
  );
