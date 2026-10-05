-- An INTERNAL file always names the capability that reads it.
--
-- INTERNAL with no capability meant "anyone signed in", and the two paths that
-- stored files that way were the board mailbox's attachments and the photos on
-- an issue report: letters to the board and pictures of the building, readable
-- by any account that held a file's id. Each now names the capability that
-- handles what it belongs to, and the reporter of an issue reads its photos
-- through the issue.
UPDATE "media_file" SET "requiredCapability" = 'boardMailbox:handle'
WHERE "visibility" = 'INTERNAL'
  AND "requiredCapability" IS NULL
  AND "id" IN (SELECT "fileId" FROM "board_mailbox_attachment");

UPDATE "media_file" SET "requiredCapability" = 'issues:handle'
WHERE "visibility" = 'INTERNAL'
  AND "requiredCapability" IS NULL
  AND "id" IN (SELECT "fileId" FROM "issue_photo");

-- What is left belongs to nothing: an attachment whose letter was never
-- written, which nothing links to and no screen offers. It is narrowed to the
-- board mailbox's capability, the only path that leaves such files behind,
-- rather than left readable by everyone until it is removed.
UPDATE "media_file" SET "requiredCapability" = 'boardMailbox:handle'
WHERE "visibility" = 'INTERNAL' AND "requiredCapability" IS NULL;

ALTER TABLE "media_file" ADD CONSTRAINT "media_file_internal_names_capability"
  CHECK ("visibility" <> 'INTERNAL' OR "requiredCapability" IS NOT NULL);

-- And no default. INTERNAL was the default, and a row written without saying
-- how it is held would now be refused by the CHECK above rather than stored.
ALTER TABLE "media_file" ALTER COLUMN "visibility" DROP DEFAULT;
