-- CreateEnum
CREATE TYPE "MenuItemKind" AS ENUM ('PAGE', 'GENERATED', 'EXTERNAL');

-- CreateTable
CREATE TABLE "menu_item" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "MenuItemKind" NOT NULL,
    "pageId" TEXT,
    "generatedKey" TEXT,
    "url" TEXT,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_item_parentId_sortOrder_idx" ON "menu_item"("parentId", "sortOrder");

-- AddForeignKey
ALTER TABLE "menu_item" ADD CONSTRAINT "menu_item_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item" ADD CONSTRAINT "menu_item_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "menu_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The menu an instance that already has pages starts from.
--
-- One top-level entry per page that is published and public, in the order the
-- pages already sit in, labelled with the page's own title. An association
-- that has been writing pages since before there was a menu therefore gets the
-- menu it would have built, and its front page does not move: the first entry
-- here is the page the lowest sort order used to select.
--
-- Unpublished pages and member-only pages are left out. An unpublished page is
-- answered exactly like a missing one, so an entry for it would be a menu item
-- that leads nowhere; a member-only page can be added to the menu by the board
-- deliberately, and putting one there on an association's behalf is not this
-- migration's decision to make.
--
-- The privacy notice is left out because the footer of every page already
-- links it. The slug is written out rather than read from the application:
-- it is a constant of the product (PRIVACY_NOTICE_SLUG in pages.service.ts)
-- and a migration is a record of what the database did on the day it ran.
--
-- The id is derived from the page's, so running this twice inserts nothing the
-- second time rather than doubling the menu.
INSERT INTO "menu_item" ("id", "label", "kind", "pageId", "sortOrder", "createdAt", "updatedAt")
SELECT
    'menu-' || "page"."id",
    "page"."title",
    'PAGE'::"MenuItemKind",
    "page"."id",
    "page"."sortOrder",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "page"
WHERE "page"."published" = true
  AND "page"."visibility" = 'PUBLIC'
  AND "page"."slug" <> 'integritetspolicy'
ON CONFLICT ("id") DO NOTHING;
