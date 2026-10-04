-- A news item's comments refuse its delete instead of following it.
--
-- The key cascaded, so removing a news item erased every comment under it in
-- the same statement. A comment is one person's personal data on a retention
-- clock of its own, and the news comment purge is the path that erases it: the
-- one that honours a legal hold, a restriction and an erasure request, and that
-- writes an audit entry for each person it erases. A cascade reached none of
-- that. NewsWriteService.remove now refuses a commented item with a reason; this
-- key is what keeps that promise for a delete that does not go through it.
--
-- RESTRICT rather than SET NULL: the column is NOT NULL, and a comment detached
-- from the notice it answers is a row nothing can read a meaning out of.
--
-- Not changed here: news_delivery still cascades. It records a mailing of the
-- item, not anybody's words, and it goes with the item it describes.
--
-- ON UPDATE CASCADE is the client's default on every foreign key in this schema
-- and is kept for consistency; the referenced column is a cuid that is never
-- updated.
--
-- Adding the key validates the existing rows against news' primary key. Every
-- existing comment already references an item, because the old key enforced
-- that too, so the validation cannot fail. The table is one association's
-- comments, so the ACCESS EXCLUSIVE lock is held for milliseconds.

-- DropForeignKey
ALTER TABLE "news_comment" DROP CONSTRAINT "news_comment_newsId_fkey";

-- AddForeignKey
ALTER TABLE "news_comment" ADD CONSTRAINT "news_comment_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "news"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
