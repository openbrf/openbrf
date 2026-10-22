-- A report carries one post or one comment (ADR 0026, moderation of Alla).
--
-- A report of a comment points at the comment and not at the post it is under:
-- the purge erases a post on its writer's clock and leaves the comments under
-- it standing, and a report about one of them is still asking. Each goes with
-- what it is about, by cascade.

ALTER TABLE "post_report" ALTER COLUMN "postId" DROP NOT NULL;

ALTER TABLE "post_report" ADD COLUMN "commentId" TEXT;

ALTER TABLE "post_report" ADD CONSTRAINT "post_report_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "post_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One person reports one comment once, as they report one post once. A null
-- never collides, so this index and the post's each hold for their own kind.
CREATE UNIQUE INDEX "post_report_commentId_reporterPersonId_key" ON "post_report"("commentId", "reporterPersonId");

-- Exactly one of the two. Written by hand, because the schema has no way to
-- say it: a report about nothing would sit in the board's queue unanswerable,
-- and one about both would be two questions in one row.
ALTER TABLE "post_report" ADD CONSTRAINT "post_report_one_subject" CHECK (num_nonnulls("postId", "commentId") = 1);
