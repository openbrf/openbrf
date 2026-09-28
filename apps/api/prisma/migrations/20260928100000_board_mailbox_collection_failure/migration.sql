-- A letter set aside by the collector is listed on the board's mailbox screen,
-- dated by its own Date header where the collector believed it, so a board
-- member can find it in a mail client. Nullable: a letter may carry no date the
-- collector trusts, and the rows already here were written without one.
ALTER TABLE "board_mailbox_ignored_message" ADD COLUMN "letterDate" TIMESTAMP(3);

-- A letter the collector failed to store for a reason that said nothing about
-- the letter, and how often. Retried rather than set aside, but not for ever:
-- past a bound the letter goes to the ledger above and onto the board's screen.
--
-- Service tier and no personal data, on the ledger's argument: an opaque
-- identifier behind a fingerprint, a count and a moment.
CREATE TABLE "board_mailbox_collection_failure" (
    "id" TEXT NOT NULL,
    "sourceUid" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "firstFailedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_mailbox_collection_failure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "board_mailbox_collection_failure_sourceUid_key" ON "board_mailbox_collection_failure"("sourceUid");
