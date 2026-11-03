-- The conversation on an issue (decisions 17 to 19 of the issue module plan):
-- issue messages between the reporter and the handlers, internal notes the
-- reporter never reads, files the handlers attach for each other, and the
-- association's saved replies.
--
-- The person columns are plain columns rather than foreign keys, for the
-- reason the schema gives over `issue.reporterPersonId`. No row names anybody
-- by name: a handler's message is signed with a role, and every person is read
-- and masked when the row is read.
CREATE TYPE "IssueMessageSide" AS ENUM ('REPORTER', 'HANDLER');

CREATE TYPE "IssueSignature" AS ENUM ('BOARD', 'PROPERTY_MANAGER');

CREATE TABLE "issue_message" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "side" "IssueMessageSide" NOT NULL,
    "authorPersonId" TEXT,
    "signature" "IssueSignature",
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_message_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_message_body_present" CHECK (btrim("body") <> ''),
    -- A handler's message is signed with a role, and the reporter's never is:
    -- a reporter's message carrying a role would read to them as the board's.
    CONSTRAINT "issue_message_signed_by_handler" CHECK (
      ("side" = 'HANDLER') = ("signature" IS NOT NULL)
    )
);

CREATE INDEX "issue_message_issueId_createdAt_idx" ON "issue_message"("issueId", "createdAt");

CREATE INDEX "issue_message_authorPersonId_idx" ON "issue_message"("authorPersonId");

ALTER TABLE "issue_message" ADD CONSTRAINT "issue_message_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "issue_note" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "authorPersonId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_note_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_note_body_present" CHECK (btrim("body") <> '')
);

CREATE INDEX "issue_note_issueId_createdAt_idx" ON "issue_note"("issueId", "createdAt");

CREATE INDEX "issue_note_authorPersonId_idx" ON "issue_note"("authorPersonId");

ALTER TABLE "issue_note" ADD CONSTRAINT "issue_note_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade both ways, as issue_photo: the row is an index of a file on an issue.
-- A file is on one issue's handler shelf at most, so the media route decides
-- it by that issue alone.
CREATE TABLE "issue_attachment" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_attachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "issue_attachment_fileId_key" ON "issue_attachment"("fileId");

CREATE INDEX "issue_attachment_issueId_sortOrder_idx" ON "issue_attachment"("issueId", "sortOrder");

ALTER TABLE "issue_attachment" ADD CONSTRAINT "issue_attachment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "issue_attachment" ADD CONSTRAINT "issue_attachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "media_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "issue_saved_reply" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_saved_reply_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_saved_reply_title_present" CHECK (btrim("title") <> ''),
    CONSTRAINT "issue_saved_reply_body_present" CHECK (btrim("body") <> '')
);

CREATE INDEX "issue_saved_reply_sortOrder_idx" ON "issue_saved_reply"("sortOrder");

-- The saved replies an instance starts with (decision 17), for an instance
-- whose setup is already complete: a new one gets them when its setup wizard
-- finishes, in that language, as it gets its issue types. Written in the
-- association's language, Swedish unless it chose English, and the board's to
-- reword or remove like any other. Templates, never a statement of law: the
-- second says what the association's own bylaws say, and BRL 7 kap. 12 § lets
-- each association's bylaws draw that line differently.
INSERT INTO "issue_saved_reply" ("id", "title", "body", "sortOrder", "updatedAt")
SELECT 'seed-issue-saved-reply-received',
       CASE WHEN a."defaultLocale" = 'en'
            THEN 'We have received your issue'
            ELSE 'Vi har tagit emot ärendet' END,
       CASE WHEN a."defaultLocale" = 'en'
            THEN 'Thank you for getting in touch. We have received your issue and will write here when we know more.'
            ELSE 'Tack för att du hörde av dig. Vi har tagit emot ärendet och skriver här när vi vet mer.' END,
       0,
       CURRENT_TIMESTAMP
FROM "association" a
WHERE a."setupCompletedAt" IS NOT NULL
LIMIT 1;

INSERT INTO "issue_saved_reply" ("id", "title", "body", "sortOrder", "updatedAt")
SELECT 'seed-issue-saved-reply-bylaws',
       CASE WHEN a."defaultLocale" = 'en'
            THEN 'Yours under the bylaws'
            ELSE 'Ditt ansvar enligt stadgarna' END,
       CASE WHEN a."defaultLocale" = 'en'
            THEN 'Thank you for your report. The association''s bylaws decide whether you as the tenant-owner or the association is responsible for maintaining what you describe. If the bylaws place it with you, you arrange the work and pay for it. Write here if you have any questions.'
            ELSE 'Tack för din anmälan. Enligt föreningens stadgar avgörs det om det är du som bostadsrättshavare eller föreningen som ansvarar för underhållet av det du beskriver. Om stadgarna lägger ansvaret på dig ordnar och bekostar du åtgärden. Skriv här om du har frågor.' END,
       1,
       CURRENT_TIMESTAMP
FROM "association" a
WHERE a."setupCompletedAt" IS NOT NULL
LIMIT 1;
