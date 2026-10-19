-- The news index, the calendar, the broker information page and the account
-- request form become built-in pages: rows in the page table, listed with the
-- association's own pages and put in the menu the way those are. The menu
-- entries that named them by a key become entries for those pages, so every
-- menu renders exactly as it did the day before.

-- CreateEnum
CREATE TYPE "BuiltInPage" AS ENUM ('NEWS', 'CALENDAR', 'BROKER_INFORMATION', 'REQUEST_ACCOUNT');

ALTER TABLE "page" ADD COLUMN "builtIn" "BuiltInPage";

-- CreateIndex
CREATE UNIQUE INDEX "page_builtIn_key" ON "page"("builtIn");

-- A page the board wrote at one of these addresses before the address was the
-- product's could never be opened: the route that serves the built-in page
-- outranks a page's address. It is moved out of the way, to an address its
-- own id makes unique, so the built-in page can take the one it is served at.
-- Nothing that worked stops working - nobody could reach the old page there -
-- and the board can give it an address of its choosing under "Advanced".
UPDATE "page"
SET "slug" = "slug" || '-' || "id"
WHERE "slug" IN ('nyheter', 'kalender', 'maklarinfo');

-- The statements below find the pages just moved by their new address, made of
-- their old one and their own id. No other page has one: the board would have
-- had to type a page's generated id into its own address.
--
-- The root, while no front page is chosen, served the page of the menu's first
-- entry for a public page, read as a visitor reads the menu. Where that was a
-- moved page, the root served it - it was the one place it could be read - and
-- its entry is about to lead to the built-in page instead, which the root
-- passes over. So it is made the front page, which is what the root was
-- serving it as: the root goes on serving it, and the board's list says so.
UPDATE "page"
SET "frontPage" = true
WHERE "id" = (
    SELECT "candidate"."pageId"
    FROM (
        SELECT "top"."sortOrder" AS "topOrder", "top"."createdAt" AS "topCreatedAt",
               "top"."id" AS "topId", 0 AS "level", 0 AS "sortOrder",
               "top"."createdAt", "top"."kind", "top"."pageId"
        FROM "menu_item" AS "top"
        WHERE "top"."parentId" IS NULL
        UNION ALL
        SELECT "top"."sortOrder", "top"."createdAt", "top"."id", 1,
               "child"."sortOrder", "child"."createdAt", "child"."kind",
               "child"."pageId"
        FROM "menu_item" AS "child"
        JOIN "menu_item" AS "top" ON "top"."id" = "child"."parentId"
        WHERE "top"."parentId" IS NULL
    ) AS "candidate"
    JOIN "page" ON "page"."id" = "candidate"."pageId"
    WHERE "candidate"."kind" = 'PAGE' AND "page"."status" = 'PUBLIC'
    ORDER BY "topOrder", "topCreatedAt", "topId", "level", "candidate"."sortOrder",
             "candidate"."createdAt"
    LIMIT 1
)
  AND "slug" IN ('nyheter-' || "id", 'kalender-' || "id", 'maklarinfo-' || "id")
  AND NOT EXISTS (SELECT 1 FROM "page" WHERE "frontPage");

-- The four built-in pages, on every instance whether or not its menu names
-- them, so the board's list has them from now on.
--
-- Titled in the association's own language where it has chosen one, and in
-- Swedish on an instance nobody has claimed yet: the setup wizard titles them
-- again in the language it is finished in. The titles are written out rather
-- than read from the application, as the earlier site migrations write the
-- privacy notice's address: a migration is a record of what the database did
-- on the day it ran.
--
-- Public, never the front page, and with an address that is settled from the
-- start - which the CHECK below holds them to. Placed after every page there
-- is, the privacy notice included, so the board's list keeps its order and the
-- new rows are at its end.
--
-- The ids are fixed, so the menu entries below can name them and running this
-- twice inserts nothing the second time.
WITH "language" AS (
    SELECT COALESCE(
        (SELECT "defaultLocale" FROM "association" WHERE "id" = 1),
        'sv'
    ) AS "locale"
),
"last" AS (
    SELECT COALESCE(MAX("sortOrder"), 0) AS "sortOrder" FROM "page"
)
INSERT INTO "page" (
    "id", "slug", "slugFollowsTitle", "title", "content", "status",
    "publishedAt", "frontPage", "builtIn", "sortOrder", "createdAt", "updatedAt"
)
SELECT
    "built"."id",
    "built"."slug",
    false,
    CASE WHEN "language"."locale" = 'en' THEN "built"."en" ELSE "built"."sv" END,
    '{"version":1,"blocks":[]}'::jsonb,
    'PUBLIC'::"PageStatus",
    CURRENT_TIMESTAMP,
    false,
    "built"."builtIn"::"BuiltInPage",
    "last"."sortOrder" + "built"."position",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    VALUES
        ('built-in-news', 'nyheter', 'NEWS', 'Nyheter', 'News', 1),
        ('built-in-calendar', 'kalender', 'CALENDAR', 'Kalender', 'Calendar', 2),
        ('built-in-broker-information', 'maklarinfo', 'BROKER_INFORMATION',
            'Mäklarinfo', 'Broker information', 3),
        ('built-in-request-account', 'app/request-account', 'REQUEST_ACCOUNT',
            'Ansök om konto', 'Request an account', 4)
) AS "built" ("id", "slug", "builtIn", "sv", "en", "position")
CROSS JOIN "language"
CROSS JOIN "last"
ON CONFLICT DO NOTHING;

-- An entry for a moved page led to the address it was moved from, and what
-- answered there was the product's own page. Where the moved page was public,
-- the entry was shown to everybody, as an entry for a built-in page is, so it
-- now names the built-in page: it leads where it led, to whom it led there,
-- with its label and whatever hangs under it.
--
-- An entry for a draft is left as it is. It was shown to nobody and still is.
--
-- So is an entry for a member-only page, which led signed-in members to the
-- product's page and was kept from everybody else. A built-in page is public,
-- so an entry for one is shown to everybody, and naming it would put the entry
-- in the menu an anonymous visitor is served: the menu never shows a visitor
-- what the board kept for members. The entry keeps its audience and leads its
-- members to the page it names, at its new address, until the board points it
-- elsewhere.
UPDATE "menu_item"
SET "pageId" = "built"."id"
FROM "page" AS "moved",
    (
        VALUES
            ('nyheter', 'built-in-news'),
            ('kalender', 'built-in-calendar'),
            ('maklarinfo', 'built-in-broker-information')
    ) AS "built" ("slug", "id")
WHERE "menu_item"."pageId" = "moved"."id"
  AND "moved"."slug" = "built"."slug" || '-' || "moved"."id"
  AND "moved"."builtIn" IS NULL
  AND "moved"."status" = 'PUBLIC';

-- Every entry that named a generated page by its key now names the built-in
-- page instead, keeping its label, its place and whatever hangs under it.
UPDATE "menu_item"
SET
    "kind" = 'PAGE',
    "pageId" = CASE "generatedKey"
        WHEN 'news' THEN 'built-in-news'
        WHEN 'calendar' THEN 'built-in-calendar'
        WHEN 'broker' THEN 'built-in-broker-information'
        WHEN 'requestAccount' THEN 'built-in-request-account'
    END,
    "generatedKey" = NULL
WHERE "kind" = 'GENERATED'
  AND "generatedKey" IN ('news', 'calendar', 'broker', 'requestAccount');

-- An entry naming a key no version ever offered could only have been written
-- by hand. It was never rendered, and neither was anything hanging under it,
-- so removing it - and them, by the cascade - leaves the website's menu as it
-- was. Keeping it is not possible: there is no third kind left to keep it as.
DELETE FROM "menu_item" WHERE "kind" = 'GENERATED';

-- The menu has two kinds of entry from now on.
ALTER TYPE "MenuItemKind" RENAME TO "MenuItemKind_old";
CREATE TYPE "MenuItemKind" AS ENUM ('PAGE', 'EXTERNAL');
ALTER TABLE "menu_item"
    ALTER COLUMN "kind" TYPE "MenuItemKind" USING ("kind"::text::"MenuItemKind");
DROP TYPE "MenuItemKind_old";

ALTER TABLE "menu_item" DROP COLUMN "generatedKey";

-- What makes a built-in page one, written by hand because Prisma's schema has
-- no CHECK. It is always public: what each visitor reads on it follows the
-- news items' and events' own audiences, and an address the product links
-- from its mailings and its blocks must not answer with the not-found
-- document. It is never the front page, which is a page the board wrote. And
-- its address never follows its title, because it is the address the product
-- serves it at.
ALTER TABLE "page"
    ADD CONSTRAINT "page_built_in_is_public_and_fixed"
    CHECK (
        "builtIn" IS NULL
        OR ("status" = 'PUBLIC' AND NOT "frontPage" AND NOT "slugFollowsTitle")
    );
