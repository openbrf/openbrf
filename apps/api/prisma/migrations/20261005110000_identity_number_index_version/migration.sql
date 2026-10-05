-- Records which normalization a personal identity number's blind index was
-- computed under.
--
-- A number without its century is now dated by its whole birth date on the
-- association's calendar, and a twelve-digit number is read only with the
-- century 18, 19 or 20. The blind index is a hash of the normalized number, so
-- the numbers this changes hold indexes a lookup no longer computes. SQL cannot
-- recompute them - that needs the key and Argon2id - so every existing row is
-- marked as written under version 1, and IdentityNumberReindexService rewrites
-- them in the background after the API starts. New rows are written under the
-- current version, 2, which the default records.
ALTER TABLE "person" ADD COLUMN "personalIdentityNumberIndexVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "person" ALTER COLUMN "personalIdentityNumberIndexVersion" SET DEFAULT 2;
