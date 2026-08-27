-- Residents never see each other's contact details.
--
-- The earlier design let a person opt in to sharing email and phone with
-- fellow residents. That was reconsidered: on a platform holding a statutory
-- register, the resident-facing address book shows names, apartments and roles
-- only, and contact data stays with the board. The two opt-in columns are
-- therefore dead weight rather than a feature waiting to be switched on, so
-- they are removed instead of left to mislead whoever reads the schema next.
--
-- The dropped values are all the seeded default of false; no resident had
-- expressed a sharing preference.
ALTER TABLE "person" DROP COLUMN "emailVisibleToResidents";
ALTER TABLE "person" DROP COLUMN "phoneVisibleToResidents";

-- Retention stays configurable per association; only the value a fresh
-- instance starts from changes, from 24 months to 12.
ALTER TABLE "association"
  ALTER COLUMN "retentionDaysAfterMoveOut" SET DEFAULT 365;
