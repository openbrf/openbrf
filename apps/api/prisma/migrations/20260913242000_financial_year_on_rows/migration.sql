-- The financial year each charge, fee rate and notification run was kept in.
--
-- Bokforingslagen (1999:1078) 7 kap. 2 § preserves rakenskapsinformation "fram
-- till och med det sjunde aret efter utgangen av det kalenderar da
-- rakenskapsaret avslutades". Which calendar year that is depends on the
-- financial year the row's books were kept in. The retention windows read it
-- from association."financialYearStartMonth" until now, which applied today's
-- setting to every row ever written: an association moving its financial year
-- from May to January would have moved a June 2026 charge from 2035 to 2034 -
-- erased a year before the statute allows, and a year before the date its
-- member's data subject access report already stated.
--
-- So the month is stamped on the row when it is written and read from there.
-- Changing the setting then changes the books written afterwards and leaves the
-- ones already closed where they were.
--
-- The run carries it for its notices rather than each notice carrying its own:
-- a notice is preserved from the run's period, and every notice in a run is
-- written in the same transaction as the run.

-- Every existing row is backfilled with 1, January. That is the only value that
-- can have applied to it: before this column existed there was no setting at
-- all, and every purge and every access report computed its dates on the
-- calendar year. Stamping anything else would move a date already stated.
--
-- The default exists only to backfill and is dropped at once, so that every
-- writer from here on has to state the month rather than inheriting January by
-- omission - which is exactly the mistake this migration corrects.
ALTER TABLE "member_charge" ADD COLUMN "financialYearStartMonth" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "member_charge" ALTER COLUMN "financialYearStartMonth" DROP DEFAULT;

ALTER TABLE "fee" ADD COLUMN "financialYearStartMonth" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "fee" ALTER COLUMN "financialYearStartMonth" DROP DEFAULT;

ALTER TABLE "fee_notification" ADD COLUMN "financialYearStartMonth" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "fee_notification" ALTER COLUMN "financialYearStartMonth" DROP DEFAULT;

-- A financial year begins in a month of the year and in no other number, on
-- each row as on the association.
ALTER TABLE "member_charge" ADD CONSTRAINT "member_charge_financial_year_start_month_check"
  CHECK ("financialYearStartMonth" BETWEEN 1 AND 12);

ALTER TABLE "fee" ADD CONSTRAINT "fee_financial_year_start_month_check"
  CHECK ("financialYearStartMonth" BETWEEN 1 AND 12);

ALTER TABLE "fee_notification" ADD CONSTRAINT "fee_notification_financial_year_start_month_check"
  CHECK ("financialYearStartMonth" BETWEEN 1 AND 12);
