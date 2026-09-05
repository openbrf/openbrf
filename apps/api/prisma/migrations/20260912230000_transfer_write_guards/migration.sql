-- What a transfer must state, checked against what the row was.
--
-- Two requirements on this table were written as NOT VALID CHECK constraints:
-- a reference to the agreement (20260828170000, tightened in 20260828180000)
-- and, in 20260912200000, which of the two register events the row is. NOT
-- VALID leaves the rows already there alone when the constraint is added, and
-- that is what both were reaching for: a transfer written before the
-- requirement has no reference to be found and no recorded kind, and inventing
-- either would put a statement into a statutory register that nobody made.
--
-- But NOT VALID only exempts a row until something writes to it. PostgreSQL
-- checks every constraint against the whole new row on UPDATE, so a
-- grandfathered transfer could be read and never corrected: the one flow the
-- board is offered on exactly those rows - recording the day the association
-- decided on membership, which is the day Lag (2026:484) 3 kap. 3 § andra
-- stycket opens the reporting window on - failed on a constraint about a
-- different column. The register kept the row and refused the deadline.
--
-- A CHECK cannot express the rule that was actually meant, because it sees only
-- the new row and the rule is about the difference: state it when you write it,
-- and never take it away. A BEFORE INSERT OR UPDATE trigger sees OLD and NEW,
-- so that is what states it.
--
-- What the trigger enforces:
--
--   On INSERT, both. A new transfer states its kind and carries a reference.
--
--   On UPDATE, neither may be removed. A row that has a reference cannot be
--   blanked, and a recorded kind cannot be changed at all - not back to null and
--   not to the other value. A row that arrived without either keeps whatever it
--   has and is updatable, which is the grandfathering both constraints intended.
--
-- The kind is fixed rather than merely non-null because the reporting
-- obligation is computed from it and that ledger is append-only. A grant's duty
-- names 3 kap. 2 § and opens on `transferredOn`; a transfer's names 3 kap. 3 §
-- and opens on `membershipDecidedOn`. Let the kind move afterwards and the row
-- in the ledger states the wrong paragraph and the wrong day, with no way to
-- correct it: the ledger refuses UPDATE and DELETE, so the mistake would stand
-- as the association's record of what it owed and when.
--
-- Recording what a legacy row was is still allowed - null to a value is a
-- correction somebody is making rather than a guess the platform is making, and
-- the platform still never makes one. Such a row has no duty in the ledger to
-- contradict, because a kind was not known when it was written.
--
-- P0001 with a marker, for the reason 20260827123837 gives about the archive
-- guards: anything in SQLSTATE class 23 is rewritten by Prisma into a generic
-- constraint error and the real reason is lost. Its own marker, because this
-- refuses an incomplete row rather than a forbidden mutation.
--
-- The whitespace class is 20260828180000's, unchanged: String.prototype.trim's
-- set written out, enumerated rather than [[:space:]] because that class is
-- locale-dependent and a statutory constraint may not mean different things on
-- different deployments.

ALTER TABLE "transfer" DROP CONSTRAINT "transfer_kind_recorded";

ALTER TABLE "transfer" DROP CONSTRAINT "transfer_agreement_reference_present";

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

CREATE TRIGGER transfer_states_what_it_is
  BEFORE INSERT OR UPDATE ON "transfer"
  FOR EACH ROW EXECUTE FUNCTION openbrf_check_transfer_record();
