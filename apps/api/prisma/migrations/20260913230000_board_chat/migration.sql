-- The chat, and the rooms it is read in.
--
-- Both kinds arrive in this migration although only the board's is answered by
-- the service. A value nothing accepts is safe to ship, and a value added later
-- would be a migration over live rows - the argument ADR 0006 makes for a block
-- type the renderer does not yet draw.

-- CreateEnum
CREATE TYPE "ChatKind" AS ENUM ('BOARD', 'GROUP');

-- CreateTable
CREATE TABLE "chat" (
    "id" TEXT NOT NULL,
    "kind" "ChatKind" NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "authorPersonId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_read" (
    "chatId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_read_pkey" PRIMARY KEY ("chatId","personId")
);

-- CreateIndex
CREATE INDEX "chat_kind_idx" ON "chat"("kind");

-- CreateIndex
CREATE INDEX "chat_message_chatId_createdAt_idx" ON "chat_message"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_message_authorPersonId_createdAt_idx" ON "chat_message"("authorPersonId", "createdAt");

-- AddForeignKey
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- There is exactly one board chat. Its membership is derived from who holds a
-- seat, so a second row of that kind would be a second room with the same
-- members and no way for a reader to tell which one the board was writing in.
-- The service creates it on first read if it is absent, and two requests
-- arriving at an empty instance together would otherwise each create one.
--
-- Written by hand because Prisma cannot express a WHERE clause on an index, and
-- with no @@unique counterpart in schema.prisma. The Chat model's comment on
-- @@index([kind]) says so, so that nobody adds the expressible one later: a
-- plain unique on "kind" would cap the groups at one as well.
CREATE UNIQUE INDEX "chat_one_board_chat" ON "chat" ("kind") WHERE "kind" = 'BOARD';
