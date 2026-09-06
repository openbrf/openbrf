-- Subletting applications (ansokan om andrahandsupplatelse): what a member asks
-- the board's consent for, and what the board answered.
--
-- BRL 7 kap. 10 § forsta stycket: "En bostadsrattshavare far upplata sin
-- lagenhet i andra hand till nagon annan for sjalvstandigt brukande endast om
-- styrelsen ger sitt samtycke." So the applicant is the tenant-owner, the
-- apartment is their own, and what the board gives or refuses is a samtycke
-- rather than an approval of a proposal.
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql, because the table holds no statutory
-- register content: the member register records who holds the tenant-ownership,
-- and this records one dated request about using it. The sublet purge erases a
-- closed application once its retention window has run out.

-- CreateEnum
--
-- The statute's own vocabulary. CONSENTED and REFUSED rather than APPROVED and
-- REJECTED because 10 § makes the board's act the giving or withholding of
-- samtycke - and the difference is not cosmetic: a refusal is the state 11 §
-- attaches the rent tribunal (hyresnamnden) route to, and an "approval" would
-- suggest the board was judging the proposal rather than consenting to a
-- letting.
CREATE TYPE "SubletApplicationStatus" AS ENUM ('SUBMITTED', 'CONSENTED', 'REFUSED', 'WITHDRAWN');

-- CreateTable
--
-- appliedByPersonId and closedByPersonId are plain columns and not foreign
-- keys, for the reason issue."reporterPersonId" and booking."bookedByPersonId"
-- are: every referential action available either rewrites this row when a
-- person is erased or vetoes the erasure outright, and service-tier data must
-- be purgeable without the purge having to negotiate with the sublet queue.
CREATE TABLE "sublet_application" (
    "id" TEXT NOT NULL,

    -- The bostadsrattshavare who is asking. 10 § gives the act to them and to
    -- nobody else living in the apartment.
    "appliedByPersonId" TEXT NOT NULL,

    -- The apartment the consent would be about.
    --
    -- Nullable with ON DELETE SET NULL, exactly as issue."apartmentId" and
    -- booking."apartmentId" are: an apartment corrected out of the register
    -- must not be held hostage by an application decided two years ago. What is
    -- lost is which apartment, and the row still says who asked, for when, and
    -- what the board answered.
    "apartmentId" TEXT,

    -- The period applied for, both ends inclusive and both required.
    --
    -- The statute fixes no period on the application itself, but its own
    -- fallback where the board refuses does: BRL 7 kap. 11 § forsta stycket has
    -- the rent tribunal's permission "begransas till viss tid" for a
    -- bostadsrattshavare, so an application naming no end could not be taken
    -- further as it stands. The second stycket softens that to "kan begransas"
    -- for a lagenhet held by a juridical person, which is not a case that
    -- reaches this form - a juridical person holds no resident account here.
    --
    -- @db.Date on both, because a letting runs over calendar days rather than
    -- from one instant to another, and because the retention window counts from
    -- the day the period ends.
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,

    -- Why the member wants to let, in their own words.
    --
    -- What 11 § calls the bostadsrattshavare's "skal for upplatelsen", which is
    -- half of what the rent tribunal weighs if the board refuses - so it is the
    -- applicant's own text and not a picker over a list the platform invented.
    -- Scanned for a personal identity number on the way in and on every later
    -- revision: the reason is quoted back to the applicant, read by the board
    -- and printed on a data subject access report, and the third party a letting
    -- is arranged with is exactly whose number turns up pasted into it.
    "reason" TEXT NOT NULL,

    "status" "SubletApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- When the application stopped being open, whichever way it closed, and who
    -- closed it. One date and not one per status, for the reason motion has
    -- one: an application closes exactly once, the status says which close it
    -- was, and the purge needs a single column to compare a cutoff against.
    --
    -- Together with the status this is the board's decision and its date, which
    -- is what BRL 7 kap. 10 § makes the association answerable for.
    "closedAt" TIMESTAMP(3),
    "closedByPersonId" TEXT,

    -- What the board said when it answered.
    --
    -- Optional, and the reason it exists is 11 §: the rent tribunal gives
    -- permission where the association "inte har nagon befogad anledning att
    -- vagra samtycke", so a refusal whose ground is nowhere written down leaves
    -- the association with nothing to point at. Scanned for a personal identity
    -- number like the applicant's own text, because it travels back to the
    -- applicant and onto their access report.
    "decisionNote" TEXT,

    -- The rent tribunal's permission, where the board refused and the member
    -- went on (BRL 7 kap. 11 §).
    --
    -- Recorded and never derived. The platform cannot know what the
    -- hyresnamnden decided unless somebody writes it down, and inventing the
    -- answer either way would take a right away on a guess - so this is stated
    -- rather than enforced: the row carries the board's refusal and the
    -- permission side by side, and nothing here recomputes the status from it.
    -- The association did not consent; the tribunal permitted, and those are two
    -- different facts about the same letting.
    --
    -- "Until" is nullable although 11 § forsta stycket requires the permission
    -- to be limited in time, because the platform records what the decision said
    -- rather than what it ought to have said, and a decision handed in without
    -- an end date must still be recordable.
    "tribunalPermittedOn" DATE,
    "tribunalPermittedUntil" DATE,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sublet_application_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "sublet_application"
  ADD CONSTRAINT "sublet_application_apartmentId_fkey"
  FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A period with its ends in order.
--
-- The API refuses this first and with a reason code, so a violation here is
-- reachable only by a hand-written statement - which is exactly the case the
-- constraint is for, and why losing the reason to SQLSTATE 23514 costs nothing.
ALTER TABLE "sublet_application" ADD CONSTRAINT "sublet_application_period_check"
  CHECK ("periodTo" >= "periodFrom");

-- The rent tribunal's permission, only where it can exist.
--
-- BRL 7 kap. 11 § opens the route on one condition - "Vagrar styrelsen att ge
-- sitt samtycke till en andrahandsupplatelse" - so a permission recorded
-- against an application the board consented to, withdrew or has not yet
-- answered is a statement about a proceeding that had no ground to be brought.
-- An end date without a permission date is the same kind of nonsense one column
-- along.
ALTER TABLE "sublet_application" ADD CONSTRAINT "sublet_application_tribunal_check"
  CHECK (
    ("tribunalPermittedOn" IS NULL OR "status" = 'REFUSED')
    AND ("tribunalPermittedUntil" IS NULL OR "tribunalPermittedOn" IS NOT NULL)
    AND (
      "tribunalPermittedUntil" IS NULL
      OR "tribunalPermittedUntil" >= "tribunalPermittedOn"
    )
  );

-- CreateIndex
--
-- The board's queue, a member's own applications, the purge scan, and the
-- applications standing against one apartment, in that order.
CREATE INDEX "sublet_application_status_submittedAt_idx" ON "sublet_application"("status", "submittedAt");
CREATE INDEX "sublet_application_appliedByPersonId_submittedAt_idx" ON "sublet_application"("appliedByPersonId", "submittedAt");
-- Both columns the purge compares against its cutoff. A closed application is
-- erasable only once both its closing date and the end of the period applied
-- for are past the window, so the scan filters on the pair.
CREATE INDEX "sublet_application_closedAt_periodTo_idx" ON "sublet_application"("closedAt", "periodTo");
CREATE INDEX "sublet_application_apartmentId_idx" ON "sublet_application"("apartmentId");
