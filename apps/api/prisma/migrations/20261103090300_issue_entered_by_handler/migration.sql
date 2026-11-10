-- That a handler opened an issue, kept apart from which handler (ADR 0054).
--
-- `enteredByPersonId` goes when the handler is erased (ADR 0057), and an issue
-- must still say that a handler entered it: the reporter's own list shows it,
-- and the board reads it as the record of how the issue came to be. The flag
-- is not personal data, so it stays.
ALTER TABLE "issue"
  ADD COLUMN "enteredByHandler" BOOLEAN NOT NULL DEFAULT false;

UPDATE "issue" SET "enteredByHandler" = true WHERE "enteredByPersonId" IS NOT NULL;
