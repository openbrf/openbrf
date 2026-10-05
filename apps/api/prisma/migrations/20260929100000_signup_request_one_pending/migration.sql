-- One pending sign-up request per email address.
--
-- A submission used to replace the pending request from the same address. The
-- form is anonymous, so that let anybody who knows a resident's address swap
-- the claim the board reads. The first request now stands and a later one is
-- dropped, and this index decides two submissions that arrive together.
--
-- Partial, because a decided request is history and an address may ask again
-- after a rejection. Written by hand with no @@unique counterpart in the
-- schema: Prisma cannot express the WHERE clause.
--
-- The replacement kept at most one pending row per address, but two concurrent
-- submissions could each have left one. Only the newest of those is kept, as
-- the replacement would have kept it; the rest were never decided and are the
-- same person asking twice.
DELETE FROM "signup_request" AS older
USING "signup_request" AS newer
WHERE older."status" = 'PENDING'
  AND newer."status" = 'PENDING'
  AND older."emailIndex" = newer."emailIndex"
  AND (older."createdAt", older."id") < (newer."createdAt", newer."id");

CREATE UNIQUE INDEX "signup_request_one_pending_per_email"
  ON "signup_request" ("emailIndex")
  WHERE "status" = 'PENDING';
