-- The board's weighing under GDPR art. 15(4) of an issue's text for one
-- person's access report (ADR 0057): a row per text and report, given whole or
-- left out for a stated reason. Removed with the text, with the record whose
-- report it is, and with the issue's free-text layer.
--
-- In one transaction, so a failure leaves none of the types, the table, its
-- indexes and its keys behind: Prisma runs each statement on its own, and a
-- retry would otherwise find the table already there.
BEGIN;

CREATE TYPE "IssueAccessPart" AS ENUM ('DESCRIPTION', 'LOCATION', 'MESSAGE', 'NOTE');

CREATE TYPE "IssueAccessWithholdingReason" AS ENUM ('IDENTIFIES_REPORTER', 'ABOUT_ANOTHER_PERSON');

CREATE TABLE "issue_access_weighing" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "concernedPersonId" TEXT,
  "part" "IssueAccessPart" NOT NULL,
  "messageId" TEXT,
  "noteId" TEXT,
  "withheldBecause" "IssueAccessWithholdingReason",
  "weighedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "issue_access_weighing_pkey" PRIMARY KEY ("id"),
  -- A message or a note is named for those parts and for no other, so a row
  -- cannot weigh a text it does not identify.
  CONSTRAINT "issue_access_weighing_part_check" CHECK (
    ("part" = 'MESSAGE') = ("messageId" IS NOT NULL)
    AND ("part" = 'NOTE') = ("noteId" IS NOT NULL)
  ),
  -- The reporter's own report weighs only the notes, and never for telling
  -- them who reported their own case.
  CONSTRAINT "issue_access_weighing_reporter_check" CHECK (
    "concernedPersonId" IS NOT NULL
    OR ("part" = 'NOTE' AND "withheldBecause" IS DISTINCT FROM 'IDENTIFIES_REPORTER')
  )
);

CREATE INDEX "issue_access_weighing_issueId_idx"
  ON "issue_access_weighing"("issueId");

CREATE INDEX "issue_access_weighing_concernedPersonId_idx"
  ON "issue_access_weighing"("concernedPersonId");

CREATE INDEX "issue_access_weighing_messageId_idx"
  ON "issue_access_weighing"("messageId");

CREATE INDEX "issue_access_weighing_noteId_idx"
  ON "issue_access_weighing"("noteId");

ALTER TABLE "issue_access_weighing"
  ADD CONSTRAINT "issue_access_weighing_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "issue"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Goes with the record of whom the issue concerns, which is whose report it is.
ALTER TABLE "issue_access_weighing"
  ADD CONSTRAINT "issue_access_weighing_concernedPersonId_fkey"
  FOREIGN KEY ("concernedPersonId") REFERENCES "issue_concerned_person"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "issue_access_weighing"
  ADD CONSTRAINT "issue_access_weighing_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "issue_message"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "issue_access_weighing"
  ADD CONSTRAINT "issue_access_weighing_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "issue_note"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
