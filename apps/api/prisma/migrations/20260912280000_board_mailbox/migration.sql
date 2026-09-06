-- The shared board mailbox (styrelsemail).
--
-- Mail sent to the address the board publishes is collected into these tables,
-- so every seat reads the same inbox and one of them takes a letter on where the
-- others can see it. The settings columns on "association" sit beside the SMTP
-- ones because they are the same kind of thing: where this instance's
-- correspondence goes out, and where it comes in.
--
-- Service tier throughout. No append-only trigger, no TRUNCATE guard and no
-- REVOKE in prisma/sql/harden-runtime-role.sql, because none of this is
-- statutory register content: a letter to the board is personal data held for
-- one service purpose, and the board mailbox purge erases a thread two years
-- after the last thing said in it.
--
-- Every person reference here - "takenByPersonId", "closedByPersonId",
-- "sentByPersonId" - is a plain column and not a foreign key, for the reason
-- issue."reporterPersonId", news_comment."authorPersonId" and
-- audit_log_entry."actorPersonId" are: every referential action available either
-- rewrites the row when a person is erased or vetoes the erasure outright, and
-- service-tier data must be purgeable without the purge having to negotiate with
-- the board's inbox.
--
-- The correspondent is deliberately NOT one of those columns. Mail is untrusted
-- input from outside the association, the From address is asserted by whoever
-- sent it, and this platform has no way to check it - so a thread names an
-- address and never a person in the register.

-- CreateEnum
CREATE TYPE "BoardMailboxThreadStatus" AS ENUM ('NEW', 'TAKEN', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BoardMailboxMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "BoardMailboxDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
--
-- The mailbox the board configures. The password is encrypted at rest like the
-- SMTP one, and carries no blind index for the same reason: it is read back by
-- primary key alone, and indexing a secret is pure downside.
ALTER TABLE "association" ADD COLUMN     "boardMailboxAddress" TEXT,
ADD COLUMN     "boardMailboxPop3Host" TEXT,
ADD COLUMN     "boardMailboxPop3PasswordCipher" TEXT,
ADD COLUMN     "boardMailboxPop3Port" INTEGER,
ADD COLUMN     "boardMailboxPop3Secure" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "boardMailboxPop3User" TEXT;

-- CreateTable
CREATE TABLE "board_mailbox_thread" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "correspondentEmailCipher" TEXT NOT NULL,
    "correspondentEmailIndex" TEXT,
    "correspondentNameCipher" TEXT,
    "status" "BoardMailboxThreadStatus" NOT NULL DEFAULT 'NEW',
    "takenByPersonId" TEXT,
    "takenAt" TIMESTAMP(3),
    "closedByPersonId" TEXT,
    "closedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_mailbox_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_mailbox_message" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "direction" "BoardMailboxMessageDirection" NOT NULL,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "sourceUid" TEXT,
    "body" TEXT NOT NULL,
    "bodyFromHtml" BOOLEAN NOT NULL DEFAULT false,
    "bodyTruncated" BOOLEAN NOT NULL DEFAULT false,
    "attachmentsDropped" INTEGER NOT NULL DEFAULT 0,
    "sentByPersonId" TEXT,
    "deliveryStatus" "BoardMailboxDeliveryStatus",
    "deliveryFailure" TEXT,
    "sentAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_mailbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_mailbox_attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_mailbox_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- The inbox as the board reads it: what is waiting, oldest first inside a state.
CREATE INDEX "board_mailbox_thread_status_lastMessageAt_idx" ON "board_mailbox_thread"("status", "lastMessageAt");

-- CreateIndex
--
-- The purge scan, which asks the whole table one question: which threads have
-- been quiet for longer than the retention window.
CREATE INDEX "board_mailbox_thread_lastMessageAt_idx" ON "board_mailbox_thread"("lastMessageAt");

-- CreateIndex
--
-- The data subject access report and the legal hold, both of which start from a
-- person's own address and ask what this instance holds under it.
CREATE INDEX "board_mailbox_thread_correspondentEmailIndex_idx" ON "board_mailbox_thread"("correspondentEmailIndex");

-- CreateIndex
--
-- What makes collecting the mailbox twice harmless. Two polls that overlap
-- cannot both insert one letter: the second loses on this constraint rather than
-- on a check that read the table a moment earlier. The value carries a
-- fingerprint of the mailbox it came from, because a POP3 unique identifier is
-- unique within one mailbox and not between two.
CREATE UNIQUE INDEX "board_mailbox_message_sourceUid_key" ON "board_mailbox_message"("sourceUid");

-- CreateIndex
--
-- One thread, read in the order it was said.
CREATE INDEX "board_mailbox_message_threadId_occurredAt_idx" ON "board_mailbox_message"("threadId", "occurredAt");

-- CreateIndex
--
-- Threading a collected message against what this instance already holds: its
-- In-Reply-To against the Message-ID of a message already on a thread.
CREATE INDEX "board_mailbox_message_messageId_idx" ON "board_mailbox_message"("messageId");

-- CreateIndex
CREATE INDEX "board_mailbox_attachment_messageId_sortOrder_idx" ON "board_mailbox_attachment"("messageId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "board_mailbox_attachment_messageId_fileId_key" ON "board_mailbox_attachment"("messageId", "fileId");

-- AddForeignKey
--
-- Cascade: a message is a message in a conversation, and once the conversation
-- is erased it says nothing at all. This is also how the purge reaches the
-- messages and the attachment rows by deleting the thread alone.
ALTER TABLE "board_mailbox_message" ADD CONSTRAINT "board_mailbox_message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "board_mailbox_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_mailbox_attachment" ADD CONSTRAINT "board_mailbox_attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "board_mailbox_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- Cascade, like issue_photo's: the row is an index of a file, and an index of
-- bytes that are gone is worse than no index at all.
ALTER TABLE "board_mailbox_attachment" ADD CONSTRAINT "board_mailbox_attachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "media_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
