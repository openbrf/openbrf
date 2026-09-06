-- A registered overlatelse that has been havd or has gone back to the seller,
-- and the duty it opens.
--
-- Lag (2026:484) 3 kap. 3 § tredje stycket: "Bostadsrattsforeningen ska anmala
-- om en overlatelse som har registrerats har havts eller atergatt till saljaren
-- utan att talan vackts i domstol."
--
-- ## Its own table rather than a column on transfer
--
-- The overlatelse happened, and it was reported. What this records is a later
-- event that undoes it, and both have to remain readable: the register has to
-- say what was reported and what was reported after it. A flag on the transfer
-- would replace a statutory record of an event with a statement that it did not
-- occur, and the transfer's own obligation - already discharged - would then
-- describe a report about nothing.
--
-- So it takes the shape termination has (20260905100000): a statutory-tier row
-- with its own day, its own ground and its own reference, append-only on both of
-- the tier's mechanisms. The triggers below stop every caller including the
-- schema owner; prisma/sql/harden-runtime-role.sql revokes UPDATE and DELETE
-- from the application role, which is a different role precisely so that
-- ALTER TABLE ... DISABLE TRIGGER is out of its reach. The two shared trigger
-- functions come from 20260827122611 and 20260827123622, rewritten by
-- 20260827123837 to raise P0001 with the OPENBRF_STATUTORY_ARCHIVE marker.
--
-- ## The duty it opens has no deadline
--
-- Tredje stycket says "ska anmala" and names no period. 3 kap. 2 §, the rest of
-- 3 §, and 4 § each say "inom tva veckor"; this sentence does not. So the
-- obligation carries a null "dueOn", and register_report_obligation_two_week_window
-- is widened below to say exactly that rather than relaxed to permit any value:
-- every other kind keeps the fourteen days, and this one has to be null. Reading
-- fourteen days into a sentence that does not contain them would put a statutory
-- deadline nobody enacted onto a row nothing can correct.

-- CreateEnum
--
-- Two values because the sentence names two, and they are different acts: a
-- havning is termination for breach, and a return to the seller is the
-- bostadsratt going back on some other footing. Both produce the same anmalan,
-- so the ground is recorded rather than acted on - the opposite reading from
-- BRL 7 kap. 33 §'s alternatives in TerminationKind, where the statute states
-- one sentence and one consequence and the model states one ground.
CREATE TYPE "TransferReversalKind" AS ENUM ('RESCINDED', 'RETURNED_TO_SELLER');

-- CreateTable
CREATE TABLE "transfer_reversal" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "kind" "TransferReversalKind" NOT NULL,
    "reversedOn" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_reversal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- Unique: an overlatelse goes back once. A second row would be a second anmalan
-- about one event, on a table nothing can delete, and the two would disagree
-- about the day it happened.
CREATE UNIQUE INDEX "transfer_reversal_transferId_key" ON "transfer_reversal"("transferId");

-- CreateIndex
CREATE INDEX "transfer_reversal_apartmentId_reversedOn_idx" ON "transfer_reversal"("apartmentId", "reversedOn");

-- CreateIndex
--
-- Without the apartment, for the reason termination's second index gives: the
-- reporting question is asked by date across the whole register and has no
-- apartment to lead with.
CREATE INDEX "transfer_reversal_reversedOn_idx" ON "transfer_reversal"("reversedOn");

-- AddForeignKey
--
-- RESTRICT on both, and never SET NULL or CASCADE. A statutory event may not
-- lose what it was about, and the row is undeletable, so a cascading delete
-- could only ever fail.
ALTER TABLE "transfer_reversal" ADD CONSTRAINT "transfer_reversal_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfer_reversal" ADD CONSTRAINT "transfer_reversal_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A reference made only of whitespace is not one. The class is
-- 20260828180000's, enumerated rather than [[:space:]] because that class is
-- locale-dependent and a statutory constraint may not mean different things on
-- different deployments. VALID, like termination_reference_present: there are no
-- rows here predating the requirement.
ALTER TABLE "transfer_reversal"
  ADD CONSTRAINT "transfer_reversal_reference_present"
  CHECK (
    "reference" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]'
  );

-- The reversal is about the transfer's own apartment.
--
-- The column is denormalised so the register can be read per apartment without
-- a join, which is the reasoning register_report_obligation carries about its
-- own. A denormalised column nothing checks is a second answer waiting to
-- disagree with the first, and here it would put a statutory event on the wrong
-- apartment's entry. A CHECK cannot read another table, so this is a trigger,
-- the way 20260910100000 states the same class of rule.
CREATE OR REPLACE FUNCTION openbrf_check_transfer_reversal()
RETURNS TRIGGER AS $$
DECLARE
  transfer_apartment TEXT;
  transfer_kind "TransferKind";
BEGIN
  SELECT t."apartmentId", t."kind"
    INTO transfer_apartment, transfer_kind
    FROM "transfer" t
   WHERE t."id" = NEW."transferId";

  -- A reference to no row at all is the foreign key's to refuse, and it names
  -- the constraint that was broken. A BEFORE ROW trigger runs before the key is
  -- checked, so without this the row would be refused here instead.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF transfer_apartment IS DISTINCT FROM NEW."apartmentId" THEN
    RAISE EXCEPTION
      'OPENBRF_TRANSFER_REVERSAL: the reversal names apartment % but the overlatelse it undoes is about %',
      NEW."apartmentId", transfer_apartment
      USING ERRCODE = 'raise_exception';
  END IF;

  -- An upplatelse is not an overlatelse. The right comes into being at a grant,
  -- so there is no earlier holder for it to go back to, and 3 kap. 3 § tredje
  -- stycket is about a registered overlatelse. A row written before "kind"
  -- existed carries none and is left alone, on the reading 20260912220000 takes
  -- of the same absence: what such a row was is not recorded, and refusing it
  -- here would be the platform deciding.
  IF transfer_kind = 'GRANT' THEN
    RAISE EXCEPTION
      'OPENBRF_TRANSFER_REVERSAL: transfer % is an upplatelse, and Lag (2026:484) 3 kap. 3 § tredje stycket is about an overlatelse that has been havd or gone back to the seller',
      NEW."transferId"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transfer_reversal_matches_its_transfer
  BEFORE INSERT ON "transfer_reversal"
  FOR EACH ROW EXECUTE FUNCTION openbrf_check_transfer_reversal();

-- The append-only guard, row level. The termination's shape and not the
-- transfer's: the overlatelse has gone back, and there is no later state for
-- this row to reach.
CREATE TRIGGER transfer_reversal_append_only
  BEFORE UPDATE OR DELETE ON "transfer_reversal"
  FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();

-- And statement level, because TRUNCATE fires no row-level trigger at all.
CREATE TRIGGER transfer_reversal_no_truncate
  BEFORE TRUNCATE ON "transfer_reversal"
  FOR EACH STATEMENT EXECUTE FUNCTION openbrf_forbid_truncate();

-- AlterTable
--
-- A third event reference on the ledger rather than a second use of
-- "transferId". The reversal is its own event with its own day, and the transfer
-- it undid already holds an obligation - the one the association discharged when
-- it reported the overgang - so two rows pointing at the transfer would break
-- the uniqueness that makes one event one deadline.
ALTER TABLE "register_report_obligation" ADD COLUMN "reversalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "register_report_obligation_reversalId_key" ON "register_report_obligation"("reversalId");

-- AddForeignKey
ALTER TABLE "register_report_obligation" ADD CONSTRAINT "register_report_obligation_reversalId_fkey" FOREIGN KEY ("reversalId") REFERENCES "transfer_reversal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
--
-- The deadline becomes nullable, for the one kind whose sentence sets none. The
-- constraint below is what keeps that from widening into "any duty may be
-- undated": dropping NOT NULL alone would let a TRANSFER or a TERMINATION be
-- written with no deadline at all, which is the opposite of what this migration
-- is for.
ALTER TABLE "register_report_obligation" ALTER COLUMN "dueOn" DROP NOT NULL;

ALTER TABLE "register_report_obligation"
  DROP CONSTRAINT "register_report_obligation_two_week_window";

-- Which duties carry a deadline at all.
--
-- The column loses NOT NULL above, for the one duty whose section sets no
-- period. Nullable on its own is weaker than what the ledger had: it lets a
-- GRANT, a TRANSFER or a TERMINATION be written with no deadline, silently,
-- which is the failure this table exists to prevent. So the distinction the
-- statute draws is stated as a constraint of its own - null if and only if the
-- kind is TRANSFER_REVERSAL - rather than left implied by the arithmetic below.
--
-- A CASE and not a boolean expression, because a CHECK admits a row whose
-- condition evaluates to NULL rather than to TRUE. Written as
-- `(kind = 'TRANSFER_REVERSAL' AND dueOn IS NULL) OR (kind <> 'TRANSFER_REVERSAL'
-- AND dueOn IS NOT NULL)`, a row is only ever TRUE or FALSE here - but the same
-- shape with the arithmetic folded in gives NULL for a TERMINATION with a null
-- deadline, and the row is accepted. The CASE has no such reading: its WHEN is
-- the only comparison in it, "kind" is NOT NULL, and both branches are IS
-- predicates that cannot be NULL.
ALTER TABLE "register_report_obligation"
  ADD CONSTRAINT "register_report_obligation_deadline_only_where_stated"
  CHECK (
    CASE
      WHEN "kind" = 'TRANSFER_REVERSAL' THEN "dueOn" IS NULL
      ELSE "dueOn" IS NOT NULL
    END
  );

-- And how long it is, where there is one.
--
-- "inom tva veckor" from the day the section names. Written as date + integer,
-- which in PostgreSQL is date arithmetic and yields a date: an INTERVAL would
-- promote both sides to timestamps and compare an hour that neither column
-- holds. That is 20260910100000's reasoning and it is unchanged.
--
-- The two constraints are separate because they answer different questions, and
-- a test that names one should not be able to pass on the other. This one says
-- nothing about which kinds have a deadline - it is silent on a null, and the
-- constraint above is what refuses one. Together they are exactly as strong as
-- the NOT NULL column plus the old arithmetic was, for every kind that still has
-- a window.
ALTER TABLE "register_report_obligation"
  ADD CONSTRAINT "register_report_obligation_two_week_window"
  CHECK ("dueOn" IS NULL OR "dueOn" = "triggeredOn" + 14);

ALTER TABLE "register_report_obligation"
  DROP CONSTRAINT "register_report_obligation_event_matches_kind";

-- Exactly the event reference that matches the kind, and none of the others.
ALTER TABLE "register_report_obligation"
  ADD CONSTRAINT "register_report_obligation_event_matches_kind"
  CHECK (
    ("kind" IN ('GRANT', 'TRANSFER') AND "transferId" IS NOT NULL AND "terminationId" IS NULL AND "reversalId" IS NULL)
    OR
    ("kind" = 'TERMINATION' AND "terminationId" IS NOT NULL AND "transferId" IS NULL AND "reversalId" IS NULL)
    OR
    ("kind" = 'TRANSFER_REVERSAL' AND "reversalId" IS NOT NULL AND "transferId" IS NULL AND "terminationId" IS NULL)
  );

-- The row says the same thing as the event it names, now for four kinds and for
-- an overgang whose window can open on either of two days.
--
-- What changed since 20260912220000:
--
--   A TRANSFER's day is no longer always "membershipDecidedOn". Lag (2026:484)
--   3 kap. 3 § andra stycket runs the two weeks from the membership decision in
--   the ordinary case and "fran overgangen" where the acquirer was already a
--   member or falls outside the membership requirement; fjarde stycket runs it
--   from the overgang where the bostadsratt passed to the association. Which of
--   those applies is stated on the transfer as "reportBasis", so that is what
--   this branches on. A row that carries no basis keeps the ordinary reading,
--   which is the rule it was written under.
--
--   A basis of LIENHOLDING_JURIDICAL_PERSON admits no obligation at all. Forsta
--   stycket assigns that anmalan to the juridical person, so a row here would be
--   the association recording a deadline it does not owe - and it could never be
--   taken out again. Refused in the database as well as in the service, because
--   this table has writers the service is not.
--
--   A TRANSFER_REVERSAL is checked against transfer_reversal, on "reversedOn".
CREATE OR REPLACE FUNCTION openbrf_check_report_obligation_event()
RETURNS TRIGGER AS $$
DECLARE
  event_apartment TEXT;
  event_date DATE;
  event_kind "TransferKind";
  event_basis "TransferReportBasis";
BEGIN
  IF NEW."transferId" IS NOT NULL THEN
    SELECT t."apartmentId", t."kind", t."reportBasis",
           CASE
             WHEN NEW."kind" = 'GRANT' THEN t."transferredOn"
             WHEN t."reportBasis" IN (
               'ALREADY_MEMBER',
               'OUTSIDE_MEMBERSHIP_REQUIREMENT',
               'TO_THE_ASSOCIATION'
             ) THEN t."transferredOn"
             ELSE t."membershipDecidedOn"
           END
      INTO event_apartment, event_kind, event_basis, event_date
      FROM "transfer" t
     WHERE t."id" = NEW."transferId";

    -- A reference to no row at all is the foreign key's to refuse, and it names
    -- the constraint that was broken. A BEFORE ROW trigger runs before the key
    -- is checked, so without this the row would be refused here instead, on a
    -- message about a register event that does not exist.
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF NEW."kind" = 'GRANT' AND event_kind IS DISTINCT FROM 'GRANT' THEN
      RAISE EXCEPTION
        'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % is not recorded as an upplatelse, so Lag (2026:484) 3 kap. 2 § is not the paragraph its report is made under',
        NEW."transferId"
        USING ERRCODE = 'raise_exception';
    END IF;

    IF NEW."kind" = 'TRANSFER' AND event_kind = 'GRANT' THEN
      RAISE EXCEPTION
        'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % is an upplatelse, which is reported under Lag (2026:484) 3 kap. 2 § and not 3 kap. 3 §',
        NEW."transferId"
        USING ERRCODE = 'raise_exception';
    END IF;

    IF NEW."kind" = 'TRANSFER'
       AND event_basis = 'LIENHOLDING_JURIDICAL_PERSON' THEN
      RAISE EXCEPTION
        'OPENBRF_REPORT_OBLIGATION_EVENT: the overgang on transfer % is anmald by the juridical person that acquired it (Lag (2026:484) 3 kap. 3 § forsta stycket, BRL 6 kap. 1 § andra stycket), so the association has no reporting duty to record',
        NEW."transferId"
        USING ERRCODE = 'raise_exception';
    END IF;

    IF event_date IS NULL THEN
      IF NEW."kind" = 'GRANT' THEN
        RAISE EXCEPTION
          'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % carries no date of upplatelse to count Lag (2026:484) 3 kap. 2 §''s two weeks from',
          NEW."transferId"
          USING ERRCODE = 'raise_exception';
      ELSE
        RAISE EXCEPTION
          'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % carries no membership decision, so Lag (2026:484) 3 kap. 3 § andra stycket names no day to count its two weeks from',
          NEW."transferId"
          USING ERRCODE = 'raise_exception';
      END IF;
    END IF;
  ELSIF NEW."terminationId" IS NOT NULL THEN
    SELECT e."apartmentId", e."tookEffectOn"
      INTO event_apartment, event_date
      FROM "termination" e
     WHERE e."id" = NEW."terminationId";

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSIF NEW."reversalId" IS NOT NULL THEN
    SELECT r."apartmentId", r."reversedOn"
      INTO event_apartment, event_date
      FROM "transfer_reversal" r
     WHERE r."id" = NEW."reversalId";

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSE
    -- No reference: register_report_obligation_event_matches_kind is what
    -- refuses this, and it says so more precisely than this trigger could.
    RETURN NEW;
  END IF;

  IF event_apartment IS DISTINCT FROM NEW."apartmentId" THEN
    RAISE EXCEPTION
      'OPENBRF_REPORT_OBLIGATION_EVENT: the obligation names apartment % but its register event is about %',
      NEW."apartmentId", event_apartment
      USING ERRCODE = 'raise_exception';
  END IF;

  IF event_date IS DISTINCT FROM NEW."triggeredOn" THEN
    RAISE EXCEPTION
      'OPENBRF_REPORT_OBLIGATION_EVENT: the window is dated % but the statute counts it from %, the date on the register event',
      NEW."triggeredOn", event_date
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
