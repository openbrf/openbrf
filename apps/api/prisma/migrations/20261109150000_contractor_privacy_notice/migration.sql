-- When a contractor on the association's list was first mailed a work order
-- that linked the association's privacy notice (GDPR art. 14(3)(b), ADR 0057,
-- question 6). Null until then, and null again once the board changes the
-- contractor's name or address, so the next work order links the notice for
-- whoever reads that address now.
--
-- Every contractor already on the list starts at null: no work order sent
-- before this change linked the notice, so the next one to each of them does.
BEGIN;

ALTER TABLE "contractor" ADD COLUMN "privacyNoticeGivenAt" TIMESTAMP(3);

COMMIT;
