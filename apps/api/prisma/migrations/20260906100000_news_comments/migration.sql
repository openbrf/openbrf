-- Member comments on news items (kommentarer).
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql, because this holds no statutory register
-- content: a comment is personal data held so the people who live in the house
-- can answer a notice, and the news comment purge erases it a year after it was
-- written.
--
-- "authorPersonId" and "hiddenByPersonId" are plain columns and not foreign
-- keys, for the reason issue."reporterPersonId", booking."bookedByPersonId" and
-- audit_log_entry."actorPersonId" are: every referential action available
-- either rewrites this row when a person is erased or vetoes the erasure
-- outright, and service-tier data must be purgeable without the purge having to
-- negotiate with the comment thread.
--
-- "hiddenAt" and "hiddenByPersonId" are moderation as a dated close. A comment
-- is struck through and never deleted, so the pair is written once and never
-- cleared.

-- CreateTable
CREATE TABLE "news_comment" (
    "id" TEXT NOT NULL,
    "newsId" TEXT NOT NULL,
    "authorPersonId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "hiddenAt" TIMESTAMP(3),
    "hiddenByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "news_comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- The thread read: one news item's comments in the order they were written.
CREATE INDEX "news_comment_newsId_createdAt_idx" ON "news_comment"("newsId", "createdAt");

-- CreateIndex
--
-- The purge scan groups by author, and the per-person write budget counts one
-- author's recent comments. Both ask this table for one person's rows by date.
CREATE INDEX "news_comment_authorPersonId_createdAt_idx" ON "news_comment"("authorPersonId", "createdAt");

-- AddForeignKey
--
-- Cascade, like news_delivery's: a comment is a comment on something, and once
-- the item it answers is gone it says nothing at all.
ALTER TABLE "news_comment" ADD CONSTRAINT "news_comment_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "news"("id") ON DELETE CASCADE ON UPDATE CASCADE;
