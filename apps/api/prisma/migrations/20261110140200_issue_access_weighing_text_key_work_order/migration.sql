-- The unique index on one weighing per text (`issue_access_weighing_text_key`)
-- names a message or a note, and so would hold every work order of an issue
-- to one weighing: a work order's weighing has neither. Rebuild it with the
-- work order folded into the same column; the part is in the key, and the part
-- check allows at most one of the three.
--
-- In one transaction, so a failure leaves the old index in place. The index
-- before it allowed one work-order weighing per issue and report at most, so
-- nothing already stored breaks the new one.
BEGIN;

DROP INDEX "issue_access_weighing_text_key";

CREATE UNIQUE INDEX "issue_access_weighing_text_key"
  ON "issue_access_weighing" (
    "issueId",
    COALESCE("concernedPersonId", ''),
    "part",
    COALESCE("messageId", "noteId", "workOrderId", '')
  );

COMMIT;
