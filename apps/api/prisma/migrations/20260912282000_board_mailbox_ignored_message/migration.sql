-- A message in the board's mailbox that was read and will never be stored.
--
-- Nothing is deleted from the mailbox, so what this instance holds is decided by
-- what it remembers having seen. A letter it stored is remembered by the
-- identifier on its own row; a letter it read and could not store had no row to
-- be remembered by, so it was fetched again on every run - and once the per-run
-- bound counts fetches rather than rows, fifty of those at the head of the
-- mailbox stop a collection before it reaches the mail behind them.
--
-- Only for a letter nothing will ever change about: no usable sender address, so
-- there is no correspondent to open a thread with and none will appear. A
-- message too large to fetch is not written here, because it is never read; nor
-- is one a retrieval failed on, because that is a mailbox having a bad minute
-- and the next run should try it again.
--
-- Service tier by placement and outside every purge scope by content: the
-- identifier is the mailbox's own opaque string behind a fingerprint of the
-- credentials it was seen under, and the reason is a code this module writes.
-- There is no person to key it to, which is the same reason the thread purge
-- names no subject. No append-only trigger and no REVOKE, on the rest of this
-- module's rule.
CREATE TABLE "board_mailbox_ignored_message" (
    "id" TEXT NOT NULL,
    "sourceUid" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_mailbox_ignored_message_pkey" PRIMARY KEY ("id")
);

-- The identifier is what a collection asks about, and asking twice must answer
-- once. The same constraint a stored message's "sourceUid" carries.
CREATE UNIQUE INDEX "board_mailbox_ignored_message_sourceUid_key" ON "board_mailbox_ignored_message"("sourceUid");
