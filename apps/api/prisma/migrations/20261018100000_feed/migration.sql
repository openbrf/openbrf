-- The feed (ADR 0026): the chat's rooms become audiences, its messages posts,
-- and the news items and their comments join them.
--
-- Nothing that can be renamed is copied. A message keeps its identifier, its
-- createdAt - and with it the date the purge reaches it - and its strike; a
-- room keeps its identifier, its members and its read markers; a news comment
-- keeps its identifier, its instant and its strike. The only rows written are
-- the Alla audience, a Styrelsen audience on an instance whose board never
-- opened its chat, and one post per news item that is or has been in front of
-- the house.

-- The kinds of audience. A new type rather than a value added to the old one:
-- a value added by ALTER TYPE cannot be used in the transaction that adds it,
-- and this migration writes the Alla row below.
CREATE TYPE "AudienceKind" AS ENUM ('ALL', 'BOARD', 'GROUP');

-- Rooms become audiences. The partial unique index named the old type's value,
-- so it goes before the column changes type and comes back as two: one
-- Styrelsen and one Alla, and as many groups as the house makes.
ALTER TABLE "chat" RENAME TO "audience";
ALTER TABLE "audience" RENAME CONSTRAINT "chat_pkey" TO "audience_pkey";
ALTER INDEX "chat_kind_idx" RENAME TO "audience_kind_idx";
DROP INDEX "chat_one_board_chat";
ALTER TABLE "audience"
  ALTER COLUMN "kind" TYPE "AudienceKind" USING ("kind"::text::"AudienceKind");
DROP TYPE "ChatKind";
CREATE UNIQUE INDEX "audience_one_board" ON "audience" ("kind") WHERE "kind" = 'BOARD';
CREATE UNIQUE INDEX "audience_one_all" ON "audience" ("kind") WHERE "kind" = 'ALL';

INSERT INTO "audience" ("id", "kind", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'ALL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "audience" ("id", "kind", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'BOARD', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "audience" WHERE "kind" = 'BOARD');

-- A room's read markers become its audience's.
ALTER TABLE "chat_read" RENAME TO "audience_read";
ALTER TABLE "audience_read" RENAME CONSTRAINT "chat_read_pkey" TO "audience_read_pkey";
ALTER TABLE "audience_read" RENAME COLUMN "chatId" TO "audienceId";
ALTER TABLE "audience_read" RENAME CONSTRAINT "chat_read_chatId_fkey" TO "audience_read_audienceId_fkey";

-- A group's members stay its members.
ALTER TABLE "chat_group_member" RENAME TO "group_member";
ALTER TABLE "group_member" RENAME CONSTRAINT "chat_group_member_pkey" TO "group_member_pkey";
ALTER TABLE "group_member" RENAME COLUMN "chatId" TO "audienceId";
ALTER TABLE "group_member" RENAME CONSTRAINT "chat_group_member_chatId_fkey" TO "group_member_audienceId_fkey";
ALTER INDEX "chat_group_member_personId_idx" RENAME TO "group_member_personId_idx";

-- Messages become posts in their audience.
ALTER TABLE "chat_message" RENAME TO "post";
ALTER TABLE "post" RENAME CONSTRAINT "chat_message_pkey" TO "post_pkey";
ALTER TABLE "post" RENAME COLUMN "chatId" TO "audienceId";
ALTER TABLE "post" RENAME CONSTRAINT "chat_message_chatId_fkey" TO "post_audienceId_fkey";
ALTER INDEX "chat_message_chatId_createdAt_idx" RENAME TO "post_audienceId_createdAt_idx";
ALTER INDEX "chat_message_authorPersonId_createdAt_idx" RENAME TO "post_authorPersonId_createdAt_idx";
ALTER TABLE "post"
  ALTER COLUMN "authorPersonId" DROP NOT NULL,
  ALTER COLUMN "body" DROP NOT NULL,
  ADD COLUMN "byBoard" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "namesAuthor" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "newsId" TEXT,
  ADD COLUMN "issueId" TEXT,
  ADD COLUMN "important" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pinnedAt" TIMESTAMP(3),
  ADD COLUMN "commentsAllowed" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "scheduledAt" TIMESTAMP(3),
  ADD COLUMN "editedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "post_newsId_key" ON "post"("newsId");
CREATE UNIQUE INDEX "post_issueId_key" ON "post"("issueId");
CREATE INDEX "post_createdAt_idx" ON "post"("createdAt");
ALTER TABLE "post" ADD CONSTRAINT "post_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "news"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post" ADD CONSTRAINT "post_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the schema cannot say about a post. A post has its own text exactly when
-- it is not a news item, whose text is the item's; only a board post is a news
-- item; and only a board post may leave its writer unrecorded.
ALTER TABLE "post" ADD CONSTRAINT "post_text_or_news_item"
  CHECK (("newsId" IS NULL) = ("body" IS NOT NULL));
ALTER TABLE "post" ADD CONSTRAINT "post_news_item_is_the_boards"
  CHECK ("newsId" IS NULL OR "byBoard");
ALTER TABLE "post" ADD CONSTRAINT "post_resident_post_names_its_author"
  CHECK ("byBoard" OR "authorPersonId" IS NOT NULL);

-- A reported message is a reported post.
ALTER TABLE "chat_message_report" RENAME TO "post_report";
ALTER TABLE "post_report" RENAME CONSTRAINT "chat_message_report_pkey" TO "post_report_pkey";
ALTER TABLE "post_report" RENAME COLUMN "messageId" TO "postId";
ALTER TABLE "post_report" RENAME CONSTRAINT "chat_message_report_messageId_fkey" TO "post_report_postId_fkey";
ALTER INDEX "chat_message_report_resolvedAt_createdAt_idx" RENAME TO "post_report_resolvedAt_createdAt_idx";
ALTER INDEX "chat_message_report_reporterPersonId_createdAt_idx" RENAME TO "post_report_reporterPersonId_createdAt_idx";
ALTER INDEX "chat_message_report_messageId_reporterPersonId_key" RENAME TO "post_report_postId_reporterPersonId_key";

-- News comments become post comments. The column still holds a news item's
-- identifier until the posts below exist and it is pointed at them.
ALTER TABLE "news_comment" DROP CONSTRAINT "news_comment_newsId_fkey";
ALTER TABLE "news_comment" RENAME TO "post_comment";
ALTER TABLE "post_comment" RENAME CONSTRAINT "news_comment_pkey" TO "post_comment_pkey";
ALTER TABLE "post_comment" RENAME COLUMN "newsId" TO "postId";
ALTER TABLE "post_comment" RENAME COLUMN "hiddenAt" TO "struckAt";
ALTER TABLE "post_comment" RENAME COLUMN "hiddenByPersonId" TO "struckByPersonId";
ALTER INDEX "news_comment_newsId_createdAt_idx" RENAME TO "post_comment_postId_createdAt_idx";
ALTER INDEX "news_comment_authorPersonId_createdAt_idx" RENAME TO "post_comment_authorPersonId_createdAt_idx";
ALTER TABLE "post_comment"
  DROP COLUMN "updatedAt",
  ADD COLUMN "byBoard" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "editedAt" TIMESTAMP(3);

-- Every news item that is or has been in front of the house becomes a
-- Styrelsen post to Alla, at the instant it was published. Published to the
-- street or to members only, the house reads it, so Alla is the audience that
-- matches either visibility. An item with a comment has been published, since a
-- draft has no thread, and is taken whatever its date says. A draft that never
-- went out gets its post when it does. The writer is not named on the post:
-- nothing ever showed a news item's author.
INSERT INTO "post" ("id", "audienceId", "authorPersonId", "byBoard", "namesAuthor", "body", "newsId", "createdAt")
SELECT
  gen_random_uuid()::text,
  (SELECT "id" FROM "audience" WHERE "kind" = 'ALL'),
  n."authorPersonId",
  true,
  false,
  NULL,
  n."id",
  COALESCE(n."publishedAt", n."createdAt")
FROM "news" n
WHERE n."published"
   OR n."publishedAt" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "post_comment" c WHERE c."postId" = n."id");

UPDATE "post_comment" c
SET "postId" = p."id"
FROM "post" p
WHERE p."newsId" = c."postId";

ALTER TABLE "post_comment" ADD CONSTRAINT "post_comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Likes, read records and the history of edits: new, and empty.
CREATE TABLE "post_like" (
    "postId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "post_like_pkey" PRIMARY KEY ("postId","personId")
);
CREATE TABLE "post_comment_like" (
    "commentId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "post_comment_like_pkey" PRIMARY KEY ("commentId","personId")
);
CREATE TABLE "post_read" (
    "postId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "post_read_pkey" PRIMARY KEY ("postId","personId")
);
CREATE TABLE "post_revision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL,
    "replacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "post_revision_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "post_comment_revision" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL,
    "replacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "post_comment_revision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "post_like_personId_idx" ON "post_like"("personId");
CREATE INDEX "post_comment_like_personId_idx" ON "post_comment_like"("personId");
CREATE INDEX "post_read_personId_idx" ON "post_read"("personId");
CREATE INDEX "post_revision_postId_replacedAt_idx" ON "post_revision"("postId", "replacedAt");
CREATE INDEX "post_comment_revision_commentId_replacedAt_idx" ON "post_comment_revision"("commentId", "replacedAt");
ALTER TABLE "post_like" ADD CONSTRAINT "post_like_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_comment_like" ADD CONSTRAINT "post_comment_like_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "post_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_read" ADD CONSTRAINT "post_read_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_revision" ADD CONSTRAINT "post_revision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_comment_revision" ADD CONSTRAINT "post_comment_revision_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "post_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
