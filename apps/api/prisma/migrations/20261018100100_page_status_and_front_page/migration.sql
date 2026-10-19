-- One status for a page in place of a published flag and a visibility, an
-- explicit front page, and an address that follows the title until the page
-- is first published.
--
-- Every existing page keeps who can read it and its address, and the website's
-- root keeps serving the page it served the day before.

-- CreateEnum
CREATE TYPE "PageStatus" AS ENUM ('DRAFT', 'MEMBERS_ONLY', 'PUBLIC');

ALTER TABLE "page"
    ADD COLUMN "status" "PageStatus" NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN "frontPage" BOOLEAN NOT NULL DEFAULT false,
    -- False for every page that exists today: each of their addresses was
    -- typed by the board, and a rename after this migration must not move one.
    -- The default for pages written from now on is set below.
    ADD COLUMN "slugFollowsTitle" BOOLEAN NOT NULL DEFAULT false;

-- The four states the two columns could hold, as the three the board meant.
-- An unpublished page was read by nobody whatever its visibility said, so both
-- of those are a draft. publishedAt is left as it stands: it is when the page
-- was first published, and a page taken down keeps it.
UPDATE "page"
SET "status" = CASE
    WHEN NOT "published" THEN 'DRAFT'
    WHEN "visibility" = 'PUBLIC' THEN 'PUBLIC'
    ELSE 'MEMBERS_ONLY'
END::"PageStatus";

-- The page the root served, chosen as the front page so that it stays one.
--
-- The same question PagesService.homePage answered before this release, in the
-- same order. First the menu's first page entry anybody may read, in the order
-- a visitor reads the menu: a top-level entry, then the entries hanging under
-- it, then the next top-level entry. An entry hanging under one that itself
-- hangs under another is never rendered, so it is never a candidate. Then, for
-- a menu that names no such page, the lowest sort order among public pages,
-- oldest first, leaving out the privacy notice. The notice's slug is written
-- out rather than read from the application, as the menu migration writes it:
-- a migration is a record of what the database did on the day it ran.
--
-- An instance with no public page at all gets no front page, and its root
-- answers as it did.
WITH "menu_candidate" AS (
    SELECT "entry"."pageId" AS "pageId"
    FROM "menu_item" "entry"
    LEFT JOIN "menu_item" "parent" ON "parent"."id" = "entry"."parentId"
    JOIN "page" ON "page"."id" = "entry"."pageId"
    WHERE "entry"."kind" = 'PAGE'
      AND ("entry"."parentId" IS NULL OR "parent"."parentId" IS NULL)
      AND "page"."status" = 'PUBLIC'
    ORDER BY
        COALESCE("parent"."sortOrder", "entry"."sortOrder"),
        COALESCE("parent"."createdAt", "entry"."createdAt"),
        COALESCE("parent"."id", "entry"."id"),
        ("entry"."parentId" IS NOT NULL),
        "entry"."sortOrder",
        "entry"."createdAt",
        "entry"."id"
    LIMIT 1
),
"order_candidate" AS (
    SELECT "page"."id" AS "pageId"
    FROM "page"
    WHERE "page"."status" = 'PUBLIC'
      AND "page"."slug" <> 'integritetspolicy'
    ORDER BY "page"."sortOrder", "page"."createdAt", "page"."id"
    LIMIT 1
)
UPDATE "page"
SET "frontPage" = true
WHERE "page"."id" = COALESCE(
    (SELECT "pageId" FROM "menu_candidate"),
    (SELECT "pageId" FROM "order_candidate")
);

-- A page written from now on takes its address from its title.
ALTER TABLE "page" ALTER COLUMN "slugFollowsTitle" SET DEFAULT true;

-- DropIndex
DROP INDEX "page_visibility_published_sortOrder_idx";

ALTER TABLE "page" DROP COLUMN "published", DROP COLUMN "visibility";

-- CreateIndex
CREATE INDEX "page_status_sortOrder_idx" ON "page"("status", "sortOrder");

-- One front page at most. Written by hand, because Prisma's schema has no way
-- to say a unique index is partial; the write service clears the old front
-- page in the transaction that sets the new one, and this is what makes two
-- boards choosing at once end in one front page rather than two.
CREATE UNIQUE INDEX "page_one_front_page" ON "page" ("frontPage") WHERE "frontPage";

-- And only a public one. A front page taken down or closed to the members would
-- answer the root with the not-found document for every visitor without a
-- session, so the board picks another front page first.
ALTER TABLE "page"
    ADD CONSTRAINT "page_front_page_is_public"
    CHECK (NOT "frontPage" OR "status" = 'PUBLIC');
