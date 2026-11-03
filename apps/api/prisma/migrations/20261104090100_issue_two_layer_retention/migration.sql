-- Two layers of an issue (ADR 0057, decision 33 of the issue module plan). The
-- building record stays: what, where, when and the outcome. The free-text
-- layer - the description, the free-text location, the conversation, the
-- internal notes and every photograph and file - is removed on a clock after
-- the issue closes, unless a legal hold stands, and a handler may redact any of
-- it before then.

-- The board's clock, in whole years after closing: from one to ten, two by
-- default. Read by the nightly purge and never stamped on an issue.
ALTER TABLE "association"
  ADD COLUMN "issueTextRetentionYears" INTEGER NOT NULL DEFAULT 2,
  ADD CONSTRAINT "association_issue_text_retention_years_range"
    CHECK ("issueTextRetentionYears" BETWEEN 1 AND 10);

ALTER TABLE "issue"
  ADD COLUMN "descriptionRedactedAt" TIMESTAMP(3),
  ADD COLUMN "locationRedactedAt" TIMESTAMP(3),
  ADD COLUMN "freeTextRemovedAt" TIMESTAMP(3),
  ADD COLUMN "legalHoldAt" TIMESTAMP(3),
  -- A redaction leaves nothing behind: the mark stands only over an empty
  -- text, so a write that put words back under it is refused here as well as
  -- by the service.
  ADD CONSTRAINT "issue_description_redacted_empty"
    CHECK ("descriptionRedactedAt" IS NULL OR "description" = ''),
  ADD CONSTRAINT "issue_location_redacted_empty"
    CHECK ("locationRedactedAt" IS NULL OR "location" IS NULL);

-- The clock's scan compares the closing date against a cutoff.
CREATE INDEX "issue_closedAt_idx" ON "issue"("closedAt");

-- A message or a note keeps its place in the conversation when it is redacted,
-- with an empty text and the date. Present text while it stands, as before;
-- none once it is redacted.
ALTER TABLE "issue_message"
  ADD COLUMN "redactedAt" TIMESTAMP(3),
  DROP CONSTRAINT "issue_message_body_present",
  ADD CONSTRAINT "issue_message_body_present" CHECK (
    CASE WHEN "redactedAt" IS NULL THEN btrim("body") <> '' ELSE "body" = '' END
  );

ALTER TABLE "issue_note"
  ADD COLUMN "redactedAt" TIMESTAMP(3),
  DROP CONSTRAINT "issue_note_body_present",
  ADD CONSTRAINT "issue_note_body_present" CHECK (
    CASE WHEN "redactedAt" IS NULL THEN btrim("body") <> '' ELSE "body" = '' END
  );

-- The clock runs from closedAt, which the service writes under the issue lock
-- on every move into the DONE meaning. An issue standing in a DONE status with
-- no closing date - written by hand, or before the column was written on every
-- path - would never reach its clock, and its free text would be kept for
-- ever. It is given the date of its last change, which is when it last moved,
-- as the migration that introduced closedAt dated the issues already closed.
UPDATE "issue" i
SET "closedAt" = i."updatedAt"
FROM "issue_status" s
WHERE s."id" = i."statusId"
  AND s."meaning" = 'DONE'
  AND i."closedAt" IS NULL;
