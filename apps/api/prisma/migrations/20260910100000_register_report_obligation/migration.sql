-- The obligation ledger for the cooperative housing register
-- (bostadsrattsregistret, Lag (2026:484)).
--
-- Lag (2026:484) 3 kap. makes the association report a register event to
-- Lantmateriet within two weeks, and 3 kap. 10 § lets Lantmateriet order a late
-- report in under penalty of a fine. 20260905100000 landed the dates those
-- windows run from; nothing computed a deadline from them. This table does: one
-- row per reportable event, stating which event, the day its window opened and
-- the day it closes.
--
-- Two of the chapter's three duties are computable from what this database
-- records, and the table carries exactly those two:
--
--   3 kap. 3 § andra stycket, an overgang: "Anmalan for registrering av
--   overgang ska goras inom tva veckor fran det att bostadsrattsforeningen
--   beslutat om medlemskap i foreningen." The window runs from
--   transfer."membershipDecidedOn", which 20260905100000 added.
--
--   3 kap. 4 §, a bostadsratt having ceased: "En anmalan for registrering av
--   att en bostadsratt har upphort ska goras av bostadsrattsforeningen inom tva
--   veckor fran det att bostadsratten upphorde." The window runs from
--   termination."tookEffectOn".
--
-- The third, 3 kap. 2 §, runs from the upplatelse itself. A grant is recorded
-- here as a transfer with a null "fromPersonId", which is also what a transfer
-- whose seller the register does not hold looks like, so the two cannot be told
-- apart from what is recorded today and the enum carries no GRANT value.
--
-- A pledge is not the association's to report at all: 3 kap. 5 § puts the
-- anmalan on the panthavare, who signs it with the pledgor, and 6 § lets
-- Lantmateriet authorise one to register pledges on its own. No lien note opens
-- a row here.
--
-- The table joins the statutory tier and is guarded on both of the two
-- mechanisms that tier uses, because neither is sufficient alone. The triggers
-- below stop every caller including the schema owner; the REVOKE line in
-- prisma/sql/harden-runtime-role.sql stops the application role, which is
-- separate from the owner precisely so that ALTER TABLE ... DISABLE TRIGGER is
-- out of its reach. Copied from 20260827122611_statutory_append_only_guards and
-- 20260827123622_forbid_truncate_on_statutory_tables, which is also where the
-- two shared trigger functions are defined; 20260827123837 rewrote both to raise
-- P0001 with the OPENBRF_STATUTORY_ARCHIVE marker, so a guard firing here
-- surfaces with the message the application matches on rather than as a foreign
-- key error.

-- CreateEnum
--
-- Named for the register event the report is about rather than for the statutory
-- paragraph, because the paragraph is what the comments cite and a value named
-- after one would go stale if the chapter were renumbered.
CREATE TYPE "RegisterReportKind" AS ENUM ('TRANSFER', 'TERMINATION');

-- CreateTable
CREATE TABLE "register_report_obligation" (
    "id" TEXT NOT NULL,
    "kind" "RegisterReportKind" NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "transferId" TEXT,
    "terminationId" TEXT,
    "triggeredOn" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "register_report_obligation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- One anmalan per event, so one deadline per event. A second row would be a
-- second deadline for one report and nothing here can take either of them out
-- again, which is why this is a constraint and not a convention in the service.
CREATE UNIQUE INDEX "register_report_obligation_transferId_key" ON "register_report_obligation"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "register_report_obligation_terminationId_key" ON "register_report_obligation"("terminationId");

-- CreateIndex
--
-- What falls due next across the whole ledger, without an apartment to lead
-- with: the outstanding-duty question is asked by date over every apartment.
CREATE INDEX "register_report_obligation_dueOn_idx" ON "register_report_obligation"("dueOn");

-- CreateIndex
CREATE INDEX "register_report_obligation_apartmentId_triggeredOn_idx" ON "register_report_obligation"("apartmentId", "triggeredOn");

-- AddForeignKey
--
-- RESTRICT throughout, and never SET NULL or CASCADE, for the reason
-- 20260905100000 records: a statutory record may not lose what it was about,
-- and a row that cannot be deleted cannot cascade, so a cascading delete could
-- only ever fail. SET NULL would also be an UPDATE, which the trigger below
-- rejects.
ALTER TABLE "register_report_obligation" ADD CONSTRAINT "register_report_obligation_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_report_obligation" ADD CONSTRAINT "register_report_obligation_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_report_obligation" ADD CONSTRAINT "register_report_obligation_terminationId_fkey" FOREIGN KEY ("terminationId") REFERENCES "termination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly the event reference that matches the kind, and not the other.
--
-- A row naming a termination while calling itself a transfer would report the
-- wrong event on the wrong paragraph's clock, and a row naming neither would be
-- a deadline about nothing. Both are unreachable through the service; this table
-- has writers the service is not - a seed, an import, a migration - and a
-- constraint weaker than the service is not the boundary it was added to be.
--
-- Stated here rather than in schema.prisma because Prisma has no syntax for a
-- CHECK; the fields' doc comments point at this migration.
ALTER TABLE "register_report_obligation"
  ADD CONSTRAINT "register_report_obligation_event_matches_kind"
  CHECK (
    ("kind" = 'TRANSFER' AND "transferId" IS NOT NULL AND "terminationId" IS NULL)
    OR
    ("kind" = 'TERMINATION' AND "terminationId" IS NOT NULL AND "transferId" IS NULL)
  );

-- The two weeks, in the database.
--
-- "inom tva veckor" is fourteen days from the day the window opened, in all
-- three of the chapter's reporting sections. Written as date + integer, which in
-- PostgreSQL is date arithmetic and yields a date: an INTERVAL would promote
-- both sides to timestamps and compare an hour that neither column holds.
--
-- Here rather than only in the service for the reason the kind constraint gives,
-- and because this is the one arithmetic in the ledger a reader cannot check by
-- eye: a deadline stated fifteen days out looks exactly like a deadline stated
-- fourteen days out.
ALTER TABLE "register_report_obligation"
  ADD CONSTRAINT "register_report_obligation_two_week_window"
  CHECK ("dueOn" = "triggeredOn" + 14);

-- The row says the same thing as the event it names.
--
-- The constraints above check the row against itself: that the kind matches
-- which reference is present, and that the two dates are fourteen days apart.
-- Neither reads the event. So a row could name one transfer, carry another
-- apartment, and open its window on a day that transfer has nothing to do with,
-- and every check above would pass - on a table nothing can correct afterwards.
--
-- A CHECK cannot express this: it may not read another table. A foreign key
-- could, over (event, apartment, date) with a unique index behind it, but ON
-- UPDATE on such a key would rewrite a statutory deadline when the parent moved,
-- and the append-only trigger would then surface the archive message for what is
-- really a refusal to move a window. A trigger says which paragraph was
-- violated instead.
--
-- What it enforces, per reference and only when that reference is present, so
-- that a row failing register_report_obligation_event_matches_kind still fails
-- on that constraint rather than on this:
--
--   The apartment is the event's own. It is denormalised here because the queue
--   is read per apartment and per date, and a denormalised column nothing checks
--   is a second answer waiting to disagree with the first.
--
--   triggeredOn is the day the statute counts from for that event, read off the
--   event: transfer."membershipDecidedOn" under 3 kap. 3 § andra stycket, and
--   termination."tookEffectOn" under 3 kap. 4 §.
--
--   A transfer with no recorded membership decision takes no row at all. The
--   paragraph gives no other day to count from, so a deadline on such a transfer
--   could only be counted from a date the statute does not name.
--
-- P0001 with a marker, for the reason 20260827123837 gives about the archive
-- guards: anything in SQLSTATE class 23 is rewritten by Prisma into a generic
-- constraint error and the real reason is lost. A separate marker from the
-- archive's, because this refuses a wrong row rather than a forbidden mutation.
CREATE OR REPLACE FUNCTION openbrf_check_report_obligation_event()
RETURNS TRIGGER AS $$
DECLARE
  event_apartment TEXT;
  event_date DATE;
BEGIN
  IF NEW."transferId" IS NOT NULL THEN
    SELECT t."apartmentId", t."membershipDecidedOn"
      INTO event_apartment, event_date
      FROM "transfer" t
     WHERE t."id" = NEW."transferId";

    -- A reference to no row at all is the foreign key's to refuse, and it names
    -- the constraint that was broken. A BEFORE ROW trigger runs before the key
    -- is checked, so without this the row would be refused here instead, on a
    -- message about a missing membership decision - true of nothing, since there
    -- is no transfer to have taken one about.
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF event_date IS NULL THEN
      RAISE EXCEPTION
        'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % carries no membership decision, so Lag (2026:484) 3 kap. 3 § andra stycket names no day to count its two weeks from',
        NEW."transferId"
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSIF NEW."terminationId" IS NOT NULL THEN
    SELECT e."apartmentId", e."tookEffectOn"
      INTO event_apartment, event_date
      FROM "termination" e
     WHERE e."id" = NEW."terminationId";

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSE
    -- Neither reference: register_report_obligation_event_matches_kind is what
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

CREATE TRIGGER register_report_obligation_matches_its_event
  BEFORE INSERT ON "register_report_obligation"
  FOR EACH ROW EXECUTE FUNCTION openbrf_check_report_obligation_event();

-- The append-only guard, row level.
--
-- BEFORE UPDATE OR DELETE and not DELETE alone, which is the shape
-- member_register_entry and termination carry rather than the one transfer and
-- lien_note do. Those keep UPDATE because releasing a lien sets releasedOn and a
-- mis-keyed entry has to be correctable. A row here has no later state to reach:
-- the event it reports cannot change, and neither can the date the statute runs
-- the window from. Discharging the duty is a separate later fact about a report
-- that was made, not an edit to this row.
CREATE TRIGGER register_report_obligation_append_only
  BEFORE UPDATE OR DELETE ON "register_report_obligation"
  FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();

-- And statement level, because TRUNCATE fires no row-level trigger at all: the
-- whole ledger could be emptied in one statement while the guard above stayed
-- silent. TRUNCATE is its own privilege and its own trigger event in PostgreSQL,
-- so both halves have to be stated.
CREATE TRIGGER register_report_obligation_no_truncate
  BEFORE TRUNCATE ON "register_report_obligation"
  FOR EACH STATEMENT EXECUTE FUNCTION openbrf_forbid_truncate();
