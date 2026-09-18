-- Fees and fee notices (avgifter och avier), and what a fee is calculated from.
--
-- A fee is not a charge. A debitering records that something happened once - a
-- key handed over, a repair charged on - and the charges module refuses a row
-- dated into the future to keep that true. A fee is a rate that stands until
-- the board changes it, which BRL 9 kap. 13 § makes the board's own standing
-- task, so it dates forward by design and lives in a table of its own. Nothing
-- in member_charge is touched here.
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql, on the charge's reading: these rows are
-- the association's record of what it billed rather than statutory register
-- content, and the fee purge erases them once the accounting record they fed
-- has outlived its own preservation period.
--
-- Deliberately no paid column, no status and no balance, on either table. The
-- accounting system owns the debt.

-- The association's financial year, and where it is paid.
--
-- financialYearStartMonth is the calendar month the rakenskapsar begins in.
-- Bokforingslagen (1999:1078) 3 kap. 1 § makes a rakenskapsar twelve calendar
-- months, so the month says the whole of it. 7 kap. 2 § preserves
-- rakenskapsinformation "fram till och med det sjunde aret efter utgangen av
-- det kalenderar da rakenskapsaret avslutades", which is why the charge and fee
-- retention windows read this column: which calendar year a row's preservation
-- runs from is the financial year's question, not the row's own.
--
-- The default is 1, the calendar year, which is what every instance recorded
-- before this column existed had assumed. On that value both windows compute
-- exactly the dates they computed before, so no erasure date already stated to
-- a named person on a data subject access report moves.
--
-- The two giro numbers are nullable like "organizationNumber" beside them: an
-- instance is set up before the board has every identifier to hand.
ALTER TABLE "association" ADD COLUMN "financialYearStartMonth" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "association" ADD COLUMN "bankgiro" TEXT;
ALTER TABLE "association" ADD COLUMN "plusgiro" TEXT;

-- A rakenskapsar begins in a month of the year and in no other number.
ALTER TABLE "association" ADD CONSTRAINT "association_financial_year_start_month_check"
  CHECK ("financialYearStartMonth" BETWEEN 1 AND 12);

-- CreateEnum
--
-- Three kinds, each of which a Swedish cooperative bills every month and each
-- of which has a settled value added tax position: the arsavgift is exempt
-- under mervardesskattelagen (2023:200) 10 kap. 35 §, while a parking space and
-- a storage space are among the upplatelser 10 kap. 36 § takes back out of that
-- exemption. No kind carrying the board's own words, because a fee row holds no
-- free text and free text about a named household is scanned for a personal
-- identity number everywhere else in this product.
CREATE TYPE "FeeKind" AS ENUM ('ANNUAL_FEE', 'PARKING_SPACE', 'STORAGE_SPACE');

-- CreateEnum
--
-- Two values and not a rate per value, exactly as "MemberChargeVatTreatment"
-- is: the rates are set by mervardesskattelagen and an amending act moves them,
-- so the treatment says whether the fee carries tax at all and
-- "vatRatePercent" says at what rate.
CREATE TYPE "FeeVatTreatment" AS ENUM ('EXEMPT', 'RATE');

-- CreateTable
--
-- One rate in force for one apartment. "monthlyAmount" is what the apartment
-- pays for one calendar month, and a notification run multiplies it by the
-- months in the period - which is exact in ore, where a yearly figure divided
-- by twelve is not, and this product refuses a malformed amount rather than
-- rounding one.
--
-- "recordedByPersonId" is a plain column and not a foreign key, for the reason
-- member_charge."recordedByPersonId" is.
CREATE TABLE "fee" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "kind" "FeeKind" NOT NULL,
    "appliesFrom" DATE NOT NULL,
    "appliesUntil" DATE,
    "monthlyAmount" DECIMAL(14,2) NOT NULL,
    "vatTreatment" "FeeVatTreatment" NOT NULL,
    "vatRatePercent" INTEGER,
    "recordedByPersonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- One notification run: the period's notices as they were issued. One run per
-- period, enforced below - a second run over a period already issued would give
-- the association two answers to what it billed, and two sets of payment
-- references for one month's money. Overlapping periods are refused by the
-- service with a reason code the screen can put a sentence to.
CREATE TABLE "fee_notification" (
    "id" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedByPersonId" TEXT NOT NULL,

    CONSTRAINT "fee_notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- One apartment's notice in one run. The amount is frozen on the row rather
-- than recomputed from the rates: a rate corrected afterwards does not change
-- what was sent, and the board has to be able to say what it sent.
CREATE TABLE "fee_notice" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paymentReference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_notice_pkey" PRIMARY KEY ("id")
);

-- A fee is a positive amount. A credit is not a fee with a minus sign in front
-- of it: it is an act the accounting system takes, and this table holds the
-- rate rather than the ledger. The API refuses each of the checks below first
-- and with a reason code, so a violation here is reachable only by a
-- hand-written statement - which is what the constraint is for.
ALTER TABLE "fee" ADD CONSTRAINT "fee_amount_check"
  CHECK ("monthlyAmount" > 0);

-- The rate belongs to the treatment that has one. Set exactly when the
-- treatment is RATE, and 1 to 100 there: zero is EXEMPT said twice, and the
-- column is not the place to enumerate which rates are in force.
ALTER TABLE "fee" ADD CONSTRAINT "fee_vat_rate_check"
  CHECK (
    ("vatTreatment" = 'RATE' AND "vatRatePercent" BETWEEN 1 AND 100)
    OR ("vatTreatment" = 'EXEMPT' AND "vatRatePercent" IS NULL)
  );

-- A rate that has ended did not end before it began. A single-day rate is
-- allowed, which is what a rate recorded and superseded the same day is.
ALTER TABLE "fee" ADD CONSTRAINT "fee_period_check"
  CHECK ("appliesUntil" IS NULL OR "appliesUntil" >= "appliesFrom");

-- A period runs forwards, and the due date is not before the period it bills
-- opens. Nothing computes from the due date - BRL 7 kap. 18 § makes an unpaid
-- arsavgift a ground for forverkande and a platform counting those days would
-- be running a forfeiture procedure - so this bounds the field and decides
-- nothing by it.
ALTER TABLE "fee_notification" ADD CONSTRAINT "fee_notification_period_check"
  CHECK ("periodTo" >= "periodFrom" AND "dueOn" >= "periodFrom");

-- A notice states a positive amount, on the same reading as the rate above.
ALTER TABLE "fee_notice" ADD CONSTRAINT "fee_notice_amount_check"
  CHECK ("amount" > 0);

-- CreateIndex
--
-- This apartment's rates: the register read, and the read a notification run
-- makes per apartment.
CREATE INDEX "fee_apartmentId_kind_appliesFrom_idx" ON "fee"("apartmentId", "kind", "appliesFrom");

-- CreateIndex
--
-- The rates in force on a day, across every apartment.
CREATE INDEX "fee_appliesFrom_idx" ON "fee"("appliesFrom");

-- CreateIndex
--
-- The purge's scan, which reaches only a rate that has ended.
CREATE INDEX "fee_appliesUntil_idx" ON "fee"("appliesUntil");

-- CreateIndex
--
-- The purge's scan over runs, and the list the board reads newest first.
CREATE INDEX "fee_notification_periodTo_idx" ON "fee_notification"("periodTo");

-- CreateIndex
CREATE UNIQUE INDEX "fee_notification_periodFrom_periodTo_key" ON "fee_notification"("periodFrom", "periodTo");

-- CreateIndex
--
-- This apartment's notices: the purge's grouping and the access report.
CREATE INDEX "fee_notice_apartmentId_idx" ON "fee_notice"("apartmentId");

-- CreateIndex
CREATE UNIQUE INDEX "fee_notice_notificationId_apartmentId_key" ON "fee_notice"("notificationId", "apartmentId");

-- CreateIndex
--
-- The reference a member quotes back over the telephone, looked up by it.
CREATE UNIQUE INDEX "fee_notice_paymentReference_key" ON "fee_notice"("paymentReference");

-- AddForeignKey
--
-- Restrict, as member_charge."apartmentId" is and for the same reason: the
-- apartment is the only party a fee has, so nulling the column would leave a
-- rate the association charged nobody. AddressService.removeApartment counts
-- the fees and the notices before it deletes, so the board is told which record
-- stands in the way rather than meeting SQLSTATE 23503.
ALTER TABLE "fee" ADD CONSTRAINT "fee_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--
-- Cascade, because a notice exists only as part of the run that issued it: the
-- period, the due date and the day it was produced are all on the run, and a
-- notice outliving it would state an amount due with nothing saying for what.
-- The fee purge erases the notices first and the run once nothing of it is
-- left, so the cascade is the constraint rather than the mechanism.
ALTER TABLE "fee_notice" ADD CONSTRAINT "fee_notice_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "fee_notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_notice" ADD CONSTRAINT "fee_notice_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
