-- Groups: a room made by whoever wanted one, and the one way the board reaches
-- it.
--
-- No migration over live rows and no backfill. The kind discriminator arrived
-- with 20260913230000_board_chat, which shipped both values and answered one, so
-- a group is a row of a kind the table already knows how to hold.
--
-- Three additions and each is a rule the service enforces above it:
--
--   "chat"."createdByPersonId" is who wanted the room. A record and not an
--   office: every member of a group may put somebody in and each may take
--   themselves out, so nothing about the room is decided by this column.
--
--   "chat_message"."struckAt" is the one thing that can happen to a message
--   after it is written, and it happens in a group alone. The text is withheld
--   from the other members and the row stays where it is, attributed as before:
--   what somebody wrote is a record of what was said, and the only thing that
--   removes one is the retention clock. The board chat has no strike-through,
--   so no row of that kind ever carries these columns.
--
--   "chat_message_report" is the whole of the board's way into a group. A group
--   is invisible to anybody outside it, so there is no list of rooms for the
--   board to read; a member of the room carries one message out, and the board
--   can then strike that message through or leave it standing.
--
-- The membership row is half of the membership test and never the whole of it.
-- The other half is a residency that has not ended, which is why there is no
-- "leftOn" column here: a place in a group ends the day the residency does, and
-- a second date saying so would be a second answer to a question the register
-- has already settled.

-- AlterTable
ALTER TABLE "chat" ADD COLUMN     "createdByPersonId" TEXT;

-- AlterTable
ALTER TABLE "chat_message" ADD COLUMN     "struckAt" TIMESTAMP(3),
ADD COLUMN     "struckByPersonId" TEXT;

-- CreateTable
CREATE TABLE "chat_group_member" (
    "chatId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedByPersonId" TEXT NOT NULL,

    CONSTRAINT "chat_group_member_pkey" PRIMARY KEY ("chatId","personId")
);

-- CreateTable
CREATE TABLE "chat_message_report" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "reporterPersonId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByPersonId" TEXT,
    "upheld" BOOLEAN,

    CONSTRAINT "chat_message_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_group_member_personId_idx" ON "chat_group_member"("personId");

-- CreateIndex
CREATE INDEX "chat_message_report_resolvedAt_createdAt_idx" ON "chat_message_report"("resolvedAt", "createdAt");

-- CreateIndex
CREATE INDEX "chat_message_report_reporterPersonId_createdAt_idx" ON "chat_message_report"("reporterPersonId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_message_report_messageId_reporterPersonId_key" ON "chat_message_report"("messageId", "reporterPersonId");

-- AddForeignKey
ALTER TABLE "chat_group_member" ADD CONSTRAINT "chat_group_member_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_message_report" ADD CONSTRAINT "chat_message_report_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
