-- Register completeness for the cooperative housing register
-- (bostadsrattsregistret, Lag (2026:484)).
--
-- Three gaps, all of them in what the association has to be able to report:
--
--   No record existed of a tenant-ownership ceasing. Lag (2026:484) 3 kap. 4 §
--   makes the association report one within two weeks of the day it ceased,
--   and 3 kap. 10 § lets Lantmateriet order a late report in under penalty of
--   a fine.
--
--   Nothing held the day the association decided on an acquirer's membership.
--   Lag (2026:484) 3 kap. 3 § andra stycket runs the transfer report's two
--   weeks from that decision rather than from the transfer. It is minuted by
--   the board and is nowhere else in this database, so a row written without it
--   cannot be repaired later.
--
--   The property designation lived only on association_facts, which is
--   published prose and whose own model comment forbids statutory data being
--   derived from it.
--
-- The termination table joins the statutory tier and is guarded on both of the
-- two mechanisms that tier uses, because neither is sufficient alone. The
-- triggers below stop every caller including the schema owner; the REVOKE lines
-- in prisma/sql/harden-runtime-role.sql stop the application role, which is
-- separate from the owner precisely so that ALTER TABLE ... DISABLE TRIGGER is
-- out of its reach. Copied from 20260827122611_statutory_append_only_guards and
-- 20260827123622_forbid_truncate_on_statutory_tables, which is also where the
-- two shared trigger functions are defined; 20260827123837 rewrote both to
-- raise P0001 with the OPENBRF_STATUTORY_ARCHIVE marker, so a guard firing here
-- surfaces with the message the application matches on rather than as a foreign
-- key error.

-- CreateEnum
--
-- Two values, because bostadsrattslagen distinguishes two grounds on which a
-- tenant-ownership ceases and has to be registered, both inserted by
-- Lag (2026:486): a general meeting resolving that one held by the association
-- should cease (BRL 6 kap. 11 §) and the building being transferred or sold
-- executively (BRL 7 kap. 33 §). The alternatives inside that second section
-- are not split apart: they stand in one sentence with one consequence and one
-- registration duty, and inventing a distinction the statute does not draw
-- would put a claim about the law into a statutory record.
CREATE TYPE "TerminationKind" AS ENUM ('GENERAL_MEETING_DECISION', 'BUILDING_TRANSFERRED');

-- CreateTable
CREATE TABLE "termination" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "kind" "TerminationKind" NOT NULL,
    "tookEffectOn" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "termination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "termination_apartmentId_tookEffectOn_idx" ON "termination"("apartmentId", "tookEffectOn");

-- CreateIndex
--
-- Without the apartment: the reporting duty is asked by date across the whole
-- register - which cessations opened a window and when - and that query has no
-- apartment to lead with.
CREATE INDEX "termination_tookEffectOn_idx" ON "termination"("tookEffectOn");

-- AddForeignKey
--
-- RESTRICT and never SET NULL. A statutory event may not lose what it was
-- about: a row saying a tenant-ownership ceased, with no apartment, is not a
-- shorter record but a false one. CASCADE is not available either - the row is
-- undeletable, so a cascading delete could only ever fail - which leaves
-- RESTRICT as the only action that says the truth, namely that an apartment
-- named by the statutory archive stays.
ALTER TABLE "termination" ADD CONSTRAINT "termination_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A reference made only of whitespace is not one.
--
-- The column is already NOT NULL, which this table can afford and
-- transfer."agreementReference" cannot: there are no rows here predating the
-- requirement, so nothing has to be excused. VALID rather than NOT VALID for
-- the same reason - there is nothing to validate against and nothing to
-- grandfather.
--
-- The character class is String.prototype.trim's whitespace set written out,
-- identical to transfer_agreement_reference_present as tightened in
-- 20260828180000: U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A,
-- U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. Enumerated rather than
-- [[:space:]] because that class is locale-dependent and excludes several of
-- these in this database, and a statutory constraint may not mean different
-- things on different deployments. U+200B is deliberately absent: it is not
-- whitespace, String.prototype.trim keeps it, and so does this.
--
-- Stated here rather than in schema.prisma because Prisma has no syntax for a
-- CHECK; the field's doc comment points at this migration.
ALTER TABLE "termination"
  ADD CONSTRAINT "termination_reference_present"
  CHECK (
    "reference" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]'
  );

-- The append-only guard, row level.
--
-- BEFORE UPDATE OR DELETE and not DELETE alone, which is where this table is
-- stricter than transfer and lien_note beside it. Those keep UPDATE because
-- releasing a lien sets releasedOn and a mis-keyed entry has to be correctable.
-- A cessation has no later state to reach - the tenant-ownership is gone - so
-- this table takes the member register's shape instead: a mistake is answered
-- by the record of the correcting act in the audit log, not by rewriting the
-- event.
CREATE TRIGGER termination_append_only
  BEFORE UPDATE OR DELETE ON "termination"
  FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();

-- And statement level, because TRUNCATE fires no row-level trigger at all: the
-- whole table could be emptied in one statement while the guard above stayed
-- silent. TRUNCATE is its own privilege and its own trigger event in
-- PostgreSQL, so both halves have to be stated.
CREATE TRIGGER termination_no_truncate
  BEFORE TRUNCATE ON "termination"
  FOR EACH STATEMENT EXECUTE FUNCTION openbrf_forbid_truncate();

-- AlterTable
--
-- The day the association decided on the acquirer's membership, which is the
-- day the transfer report's two weeks start running (Lag (2026:484) 3 kap. 3 §
-- andra stycket).
--
-- Nullable, and with no CHECK requiring a value, for two reasons that both
-- outlive this migration. Rows written before this column have no such date and
-- nothing to derive one from, so backfilling would state a board decision that
-- nobody can point to. And the statute itself has transfers with no membership
-- decision at all: to an acquirer who is already a member, or who is outside
-- the membership requirement, the same paragraph runs the two weeks from the
-- transfer instead. For those, null is the correct recorded value.
ALTER TABLE "transfer" ADD COLUMN "membershipDecidedOn" DATE;

-- AlterTable
--
-- The association's authoritative property designation, beside
-- organizationNumber, which is where this singleton already keeps the
-- identifiers of the legal person it is.
--
-- association_facts."propertyDesignation" stays where it is and keeps its
-- purpose: it is what the board publishes to a broker, and that model's comment
-- says nothing there may become derived from the statutory registers. This
-- column is the register's own, written on the apartment register screen behind
-- the capability that gates that register and recorded in the audit log.
--
-- No append-only trigger and no REVOKE. A designation is the property's current
-- name rather than a dated event - a fastighetsbildning renames one - so it has
-- to be correctable in place, and this table carries an updatedAt that every
-- other settings write already moves.
ALTER TABLE "association" ADD COLUMN "propertyDesignation" TEXT;
