-- Charges to members (debiteringar mot medlem): the basis for a one-off cost
-- the board puts on a named member or on an apartment, and nothing about
-- whether it has been paid.
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql, because the table holds no statutory
-- register content: a charge is the association's own note of what it charged
-- and why, held so the board can hand the debiting list to whoever keeps its
-- books, and the charge purge erases it once the accounting record it fed has
-- outlived its own preservation period.
--
-- Deliberately no "paidAt", no status and no balance. The accounting system
-- owns the debt; a second answer to whether something has been paid is worse
-- than none, and a column here would become that answer the first time the two
-- disagreed.

-- CreateEnum
CREATE TYPE "MemberChargeVatTreatment" AS ENUM ('EXEMPT', 'RATE');

-- CreateTable
--
-- "personId" and "recordedByPersonId" are plain columns and not foreign keys,
-- for the reason booking."bookedByPersonId" and event_signup."personId" are:
-- every referential action available either rewrites this row when a person is
-- erased or vetoes the erasure outright, and service-tier data must be
-- purgeable without the purge having to negotiate with the debiting list.
CREATE TABLE "member_charge" (
    "id" TEXT NOT NULL,
    "personId" TEXT,
    "apartmentId" TEXT,
    "chargedOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "vatTreatment" "MemberChargeVatTreatment" NOT NULL,
    "vatRatePercent" INTEGER,
    "handedToManagerOn" DATE,
    "recordedByPersonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_charge_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
--
-- Restrict, and not the SET NULL booking."apartmentId" carries. The apartment
-- means different things on the two rows: a booking is made by somebody for a
-- flat, so one whose apartment was corrected out of the register still says who
-- booked the sauna, while an apartment-keyed charge has no other party at all
-- and nulling the column would leave a sum the association charged nobody. It is
-- also what keeps member_charge_party_check true, which a SET NULL would violate
-- on the update it performs.
--
-- AddressService.removeApartment counts the charges before it deletes, so the
-- board is told which record stands in the way rather than meeting SQLSTATE
-- 23503.
ALTER TABLE "member_charge" ADD CONSTRAINT "member_charge_apartmentId_fkey"
  FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One charged party and exactly one.
--
-- A charge is on a named person or on an apartment, whoever holds it. Both
-- would give two answers to "who is being charged" the day the apartment
-- changes hands, and neither would leave a row nothing can be invoiced from.
-- The API refuses both cases first and with a reason code, so a violation here
-- is reachable only by a hand-written statement - which is what the constraint
-- is for, and why losing the reason to SQLSTATE 23514 costs nothing. The same
-- applies to the three checks below.
ALTER TABLE "member_charge" ADD CONSTRAINT "member_charge_party_check"
  CHECK (("personId" IS NULL) <> ("apartmentId" IS NULL));

-- A charge is a positive amount. A credit note is not a charge with a minus
-- sign in front of it: it is an act the accounting system takes, and this table
-- holds the basis rather than the ledger.
ALTER TABLE "member_charge" ADD CONSTRAINT "member_charge_amount_check"
  CHECK ("amount" > 0);

-- The rate belongs to the treatment that has one.
--
-- Set exactly when the treatment is RATE, and 1 to 100 there: zero is EXEMPT
-- said a second way, and a row carrying a rate under EXEMPT would be a charge
-- whose two VAT fields contradict each other on a document handed to a
-- bookkeeper. The bound is not an enumeration of the rates in force - those are
-- mervardesskattelagen's and move by amendment - only a refusal of a number
-- that could not be a rate at all.
ALTER TABLE "member_charge" ADD CONSTRAINT "member_charge_vatRate_check"
  CHECK (
    ("vatTreatment" = 'RATE' AND "vatRatePercent" BETWEEN 1 AND 100)
    OR ("vatTreatment" = 'EXEMPT' AND "vatRatePercent" IS NULL)
  );

-- A reason with something in it. The reason is what the member is told the
-- charge was for, so a row carrying only whitespace would put an unexplained sum
-- on the debiting list. The same shape as transfer."agreementReference"'s check,
-- down to the class: PostgreSQL's one-argument btrim strips spaces and nothing
-- else, so a single tab, newline or non-breaking space would satisfy that older
-- predicate while the service refuses all of those - String.prototype.trim
-- strips the whole Unicode whitespace set, and the constraint exists because the
-- service is not the only writer. The class below is that set written out.
-- Enumerated rather than [[:space:]], which is locale-dependent and in this
-- database already excludes U+00A0, U+1680, U+202F and U+FEFF. U+200B is
-- deliberately absent: it is not whitespace, and String.prototype.trim keeps it.
ALTER TABLE "member_charge" ADD CONSTRAINT "member_charge_reason_check"
  CHECK ("reason" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]');

-- CreateIndex
--
-- The debiting list for a period, then the two person-and-apartment reads the
-- access report and the purge make.
CREATE INDEX "member_charge_chargedOn_idx" ON "member_charge"("chargedOn");
CREATE INDEX "member_charge_personId_chargedOn_idx" ON "member_charge"("personId", "chargedOn");
CREATE INDEX "member_charge_apartmentId_chargedOn_idx" ON "member_charge"("apartmentId", "chargedOn");
