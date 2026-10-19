import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { scratchDatabases, withClient } from "../testing/scratch-databases";

/**
 * The migration that turns the chat into the feed, against a database that
 * held the chat.
 *
 * Every other suite meets the schema after this migration has run on an empty
 * database, where it has nothing to carry over. An instance upgrading meets it
 * with a year of messages, groups and their members, read markers, reports,
 * news items and their comments in it - and the promise ADR 0026 makes is that
 * nothing renamable is copied: a message keeps its identifier and its instant,
 * and with them the date the purge reaches it, and its strike; a room keeps its
 * identifier, its members and its markers; a news comment keeps its
 * identifier, its instant and its hiding, now called a strike. Only a database
 * that held rows in the old shape can show that, and only this suite builds
 * one.
 *
 * It also holds the two things the schema cannot say and the migration writes
 * by hand: that there is exactly one Alla and one Styrelsen, on an upgraded
 * instance and on a fresh one, and that the CHECK constraints refuse a post
 * that is neither a neighbour's text nor a news item.
 *
 * Applied one migration at a time with the owner's connection, as
 * `check-triggers.int-spec.ts` applies them: every migration before the feed's,
 * then the rows, then the feed's own.
 */

loadEnvForIntegrationTests();

const migrations = join(process.cwd(), "prisma", "migrations");

/** The migration under test. */
const FEED_MIGRATION = "20261018100000_feed";

/** Every migration, in the order an instance applies them. */
function migrationNames(): string[] {
  return readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function apply(client: Client, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await client.query(
      readFileSync(join(migrations, name, "migration.sql"), "utf8"),
    );
  }
}

/**
 * Empty databases, as an instance meets the migrations. Dropped again once the
 * suite is done.
 */
const scratch = scratchDatabases();

afterAll(async () => {
  await scratch.dropAll();
});

/*
 * The instants the fixture rows carry. Written as the column stores them -
 * TIMESTAMP(3) without a zone - and read back as text, so what is compared is
 * the stored value and not a conversion of it through this process's zone.
 */
const A_YEAR_AGO = "2025-10-01 08:00:00";
const LAST_WEEK = "2026-10-11 09:30:00";
const STRUCK_AT = "2026-10-12 10:00:00";
const MEMBER_PUBLISHED_AT = "2026-03-02 07:15:00";
const PUBLIC_PUBLISHED_AT = "2026-04-03 12:00:00";
const FORMERLY_PUBLISHED_AT = "2026-05-04 18:45:00";
const COMMENTED_DRAFT_CREATED_AT = "2026-06-05 11:00:00";
const COMMENTED_AT = "2026-06-06 08:00:00";
const HIDDEN_AT = "2026-06-07 09:00:00";

/**
 * A chat and a newsroom as an instance holds them before the feed: the board's
 * room with a message a year old in it, a group with two members, a struck
 * message, the markers, a report, and four kinds of news item with comments.
 *
 * The person identifiers are plain strings. Every column here that names a
 * person is a plain column rather than a relation, so a purge can reach the rows
 * unvetoed, and the migration does not need a person to exist either.
 */
async function writeOldRows(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "chat" ("id", "kind", "name", "createdByPersonId", "createdAt", "updatedAt") VALUES
      ('chat-board', 'BOARD', NULL, NULL, '2025-09-01 08:00:00', '2025-09-01 08:00:00'),
      ('chat-group', 'GROUP', 'Trädgårdsgruppen', 'person-nils', '2026-01-10 08:00:00', '2026-01-10 08:00:00');

    INSERT INTO "chat_group_member" ("chatId", "personId", "joinedAt", "addedByPersonId") VALUES
      ('chat-group', 'person-nils', '2026-01-10 08:00:00', 'person-nils'),
      ('chat-group', 'person-astrid', '2026-01-11 08:00:00', 'person-nils');

    INSERT INTO "chat_message" ("id", "chatId", "authorPersonId", "body", "createdAt", "struckAt", "struckByPersonId") VALUES
      ('message-old', 'chat-board', 'person-bo', 'Offerten fran i fjol.', '${A_YEAR_AGO}', NULL, NULL),
      ('message-board', 'chat-board', 'person-bo', 'Vi tar beslutet pa motet.', '${LAST_WEEK}', NULL, NULL),
      ('message-struck', 'chat-group', 'person-astrid', 'Rad som stroks.', '${LAST_WEEK}', '${STRUCK_AT}', 'person-bo'),
      ('message-standing', 'chat-group', 'person-nils', 'Vi ses pa lordag.', '${LAST_WEEK}', NULL, NULL);

    INSERT INTO "chat_read" ("chatId", "personId", "readAt") VALUES
      ('chat-board', 'person-bo', '${LAST_WEEK}'),
      ('chat-group', 'person-astrid', '${STRUCK_AT}');

    INSERT INTO "chat_message_report" ("id", "messageId", "reporterPersonId", "note", "createdAt", "resolvedAt", "resolvedByPersonId", "upheld") VALUES
      ('report-1', 'message-struck', 'person-nils', 'Det handlar om min lagenhet.', '${LAST_WEEK}', '${STRUCK_AT}', 'person-bo', true);

    INSERT INTO "news" ("id", "slug", "title", "content", "visibility", "published", "publishedAt", "authorPersonId", "createdAt", "updatedAt") VALUES
      ('news-member', 'arsstamma', 'Arsstamma', '{"blocks":[]}', 'MEMBER', true, '${MEMBER_PUBLISHED_AT}', 'person-bo', '2026-03-01 10:00:00', '2026-03-02 07:15:00'),
      ('news-public', 'stadning', 'Stadning', '{"blocks":[]}', 'PUBLIC', true, '${PUBLIC_PUBLISHED_AT}', 'person-bo', '2026-04-01 10:00:00', '2026-04-03 12:00:00'),
      ('news-draft', 'utkast', 'Utkast', '{"blocks":[]}', 'MEMBER', false, NULL, 'person-bo', '2026-05-01 10:00:00', '2026-05-01 10:00:00'),
      ('news-taken-down', 'nedtagen', 'Nedtagen', '{"blocks":[]}', 'MEMBER', false, '${FORMERLY_PUBLISHED_AT}', NULL, '2026-05-02 10:00:00', '2026-05-05 10:00:00'),
      ('news-commented-draft', 'kommenterat-utkast', 'Kommenterat utkast', '{"blocks":[]}', 'MEMBER', false, NULL, 'person-bo', '${COMMENTED_DRAFT_CREATED_AT}', '${COMMENTED_DRAFT_CREATED_AT}');

    INSERT INTO "news_comment" ("id", "newsId", "authorPersonId", "body", "hiddenAt", "hiddenByPersonId", "createdAt", "updatedAt") VALUES
      ('comment-standing', 'news-member', 'person-astrid', 'Tack for kallelsen.', NULL, NULL, '${COMMENTED_AT}', '${COMMENTED_AT}'),
      ('comment-hidden', 'news-member', 'person-nils', 'Nagot som doldes.', '${HIDDEN_AT}', 'person-bo', '${COMMENTED_AT}', '${HIDDEN_AT}'),
      ('comment-taken-down', 'news-taken-down', 'person-astrid', 'Ska den inte upp igen?', NULL, NULL, '${COMMENTED_AT}', '${COMMENTED_AT}'),
      ('comment-on-draft', 'news-commented-draft', 'person-nils', 'Kommenterat fore publicering.', NULL, NULL, '${COMMENTED_AT}', '${COMMENTED_AT}');
  `);
}

/** One query's rows. */
async function rows<T>(client: Client, text: string): Promise<T[]> {
  const result = await client.query(text);
  return result.rows as T[];
}

describe("the feed migration on an instance that held the chat", () => {
  it("carries every message, room, member, marker, report and news comment over as it was", async () => {
    const url = await scratch.create("feed_upgrade");
    const names = migrationNames();
    const before = names.filter((name) => name < FEED_MIGRATION);
    expect(names).toContain(FEED_MIGRATION);

    await withClient(url, async (client) => {
      await apply(client, before);
      await writeOldRows(client);

      // What the messages are before, read the way they are read after.
      const messagesBefore = await rows(
        client,
        `SELECT "id", "chatId" AS "audienceId", "authorPersonId", "body",
                "createdAt"::text AS "createdAt", "struckAt"::text AS "struckAt",
                "struckByPersonId"
         FROM "chat_message" ORDER BY "id"`,
      );

      await apply(client, [FEED_MIGRATION]);

      /*
       * The messages are posts, with the identifier, the instant - and so the
       * date the purge reaches each - and the strike they had. Each is a
       * neighbour's own: not Styrelsen's, naming its writer, and no news item.
       */
      const posts = await rows<Record<string, unknown>>(
        client,
        `SELECT "id", "audienceId", "authorPersonId", "body",
                "createdAt"::text AS "createdAt", "struckAt"::text AS "struckAt",
                "struckByPersonId"
         FROM "post" WHERE "newsId" IS NULL ORDER BY "id"`,
      );
      expect(posts).toEqual(messagesBefore);
      expect(posts).toContainEqual({
        id: "message-old",
        audienceId: "chat-board",
        authorPersonId: "person-bo",
        body: "Offerten fran i fjol.",
        createdAt: A_YEAR_AGO,
        struckAt: null,
        struckByPersonId: null,
      });
      expect(posts).toContainEqual({
        id: "message-struck",
        audienceId: "chat-group",
        authorPersonId: "person-astrid",
        body: "Rad som stroks.",
        createdAt: LAST_WEEK,
        struckAt: STRUCK_AT,
        struckByPersonId: "person-bo",
      });
      expect(
        await rows(
          client,
          `SELECT DISTINCT "byBoard", "namesAuthor", "important", "pinnedAt",
                  "commentsAllowed", "scheduledAt", "editedAt"
           FROM "post" WHERE "newsId" IS NULL`,
        ),
      ).toEqual([
        {
          byBoard: false,
          namesAuthor: true,
          important: false,
          pinnedAt: null,
          commentsAllowed: true,
          scheduledAt: null,
          editedAt: null,
        },
      ]);

      /*
       * The rooms are audiences with the identifiers they had: the board's
       * room is Styrelsen and the group is a group of the same name. Alla is
       * new, and there is one of it and one Styrelsen - the migration must not
       * have made a second board audience beside the room it renamed.
       */
      const audiences = await rows<{
        id: string;
        kind: string;
        name: string | null;
      }>(
        client,
        `SELECT "id", "kind"::text AS "kind", "name" FROM "audience" ORDER BY "kind", "id"`,
      );
      const all = audiences.filter((audience) => audience.kind === "ALL");
      expect(all).toHaveLength(1);
      const allId = all[0]?.id ?? "";
      expect(audiences).toEqual([
        { id: allId, kind: "ALL", name: null },
        { id: "chat-board", kind: "BOARD", name: null },
        { id: "chat-group", kind: "GROUP", name: "Trädgårdsgruppen" },
      ]);

      // The group's members, as they were put in and by whom.
      expect(
        await rows(
          client,
          `SELECT "audienceId", "personId", "joinedAt"::text AS "joinedAt", "addedByPersonId"
           FROM "group_member" ORDER BY "personId"`,
        ),
      ).toEqual([
        {
          audienceId: "chat-group",
          personId: "person-astrid",
          joinedAt: "2026-01-11 08:00:00",
          addedByPersonId: "person-nils",
        },
        {
          audienceId: "chat-group",
          personId: "person-nils",
          joinedAt: "2026-01-10 08:00:00",
          addedByPersonId: "person-nils",
        },
      ]);

      // How far each person had read, in the audience the room became.
      expect(
        await rows(
          client,
          `SELECT "audienceId", "personId", "readAt"::text AS "readAt"
           FROM "audience_read" ORDER BY "audienceId"`,
        ),
      ).toEqual([
        { audienceId: "chat-board", personId: "person-bo", readAt: LAST_WEEK },
        {
          audienceId: "chat-group",
          personId: "person-astrid",
          readAt: STRUCK_AT,
        },
      ]);

      // The report names the post the message became, and its answer stands.
      expect(
        await rows(
          client,
          `SELECT "id", "postId", "reporterPersonId", "note", "resolvedAt"::text AS "resolvedAt",
                  "resolvedByPersonId", "upheld"
           FROM "post_report"`,
        ),
      ).toEqual([
        {
          id: "report-1",
          postId: "message-struck",
          reporterPersonId: "person-nils",
          note: "Det handlar om min lagenhet.",
          resolvedAt: STRUCK_AT,
          resolvedByPersonId: "person-bo",
          upheld: true,
        },
      ]);

      /*
       * Every news item that is or has been in front of the house is a
       * Styrelsen post to Alla, at the instant it was first published - to the
       * street or to the members alike, and taken down or not, since the feed
       * shows it only while it is up. Its text is the item's and its writer is
       * not named. The draft that never went out has no post: it gets one when
       * it is published. A draft somebody commented on is taken whatever its
       * date says, because its comments need a post to hang on.
       */
      const newsPosts = await rows<Record<string, unknown>>(
        client,
        `SELECT "newsId", "audienceId", "authorPersonId", "byBoard", "namesAuthor", "body",
                "createdAt"::text AS "createdAt", "struckAt"
         FROM "post" WHERE "newsId" IS NOT NULL ORDER BY "newsId"`,
      );
      const asBoardPost = (
        newsId: string,
        createdAt: string,
        authorPersonId: string | null,
      ) => ({
        newsId,
        audienceId: allId,
        authorPersonId,
        byBoard: true,
        namesAuthor: false,
        body: null,
        createdAt,
        struckAt: null,
      });
      expect(newsPosts).toEqual([
        asBoardPost(
          "news-commented-draft",
          COMMENTED_DRAFT_CREATED_AT,
          "person-bo",
        ),
        asBoardPost("news-member", MEMBER_PUBLISHED_AT, "person-bo"),
        asBoardPost("news-public", PUBLIC_PUBLISHED_AT, "person-bo"),
        asBoardPost("news-taken-down", FORMERLY_PUBLISHED_AT, null),
      ]);

      /*
       * The comments hang on those posts now, with their identifiers, their
       * instants and their writers - and a hidden one is struck, by whoever
       * hid it, at the instant they did.
       */
      expect(
        await rows(
          client,
          `SELECT c."id", p."newsId", c."authorPersonId", c."body",
                  c."createdAt"::text AS "createdAt", c."struckAt"::text AS "struckAt",
                  c."struckByPersonId", c."byBoard", c."editedAt"
           FROM "post_comment" c JOIN "post" p ON p."id" = c."postId"
           ORDER BY c."id"`,
        ),
      ).toEqual([
        {
          id: "comment-hidden",
          newsId: "news-member",
          authorPersonId: "person-nils",
          body: "Nagot som doldes.",
          createdAt: COMMENTED_AT,
          struckAt: HIDDEN_AT,
          struckByPersonId: "person-bo",
          byBoard: false,
          editedAt: null,
        },
        {
          id: "comment-on-draft",
          newsId: "news-commented-draft",
          authorPersonId: "person-nils",
          body: "Kommenterat fore publicering.",
          createdAt: COMMENTED_AT,
          struckAt: null,
          struckByPersonId: null,
          byBoard: false,
          editedAt: null,
        },
        {
          id: "comment-standing",
          newsId: "news-member",
          authorPersonId: "person-astrid",
          body: "Tack for kallelsen.",
          createdAt: COMMENTED_AT,
          struckAt: null,
          struckByPersonId: null,
          byBoard: false,
          editedAt: null,
        },
        {
          id: "comment-taken-down",
          newsId: "news-taken-down",
          authorPersonId: "person-astrid",
          body: "Ska den inte upp igen?",
          createdAt: COMMENTED_AT,
          struckAt: null,
          struckByPersonId: null,
          byBoard: false,
          editedAt: null,
        },
      ]);

      // Likes, read records and histories are new, and start empty.
      for (const table of [
        "post_like",
        "post_comment_like",
        "post_read",
        "post_revision",
        "post_comment_revision",
      ]) {
        expect(
          await rows(client, `SELECT count(*)::int AS "count" FROM "${table}"`),
          table,
        ).toEqual([{ count: 0 }]);
      }

      /*
       * The constraints the schema cannot state. A neighbour's post has its own
       * text; a news item's post has none, because its text is the item's; only
       * Styrelsen posts a news item; and only Styrelsen may leave its writer
       * unrecorded.
       */
      const refusal = (text: string) =>
        client.query(text).then(
          () => null,
          (error: unknown) => {
            const { code, constraint } = error as {
              code?: string;
              constraint?: string;
            };
            return { code, constraint };
          },
        );

      expect(
        await refusal(
          `INSERT INTO "post" ("id", "audienceId", "authorPersonId", "body")
           VALUES ('post-no-text', '${allId}', 'person-astrid', NULL)`,
        ),
      ).toEqual({ code: "23514", constraint: "post_text_or_news_item" });
      expect(
        await refusal(
          `INSERT INTO "post" ("id", "audienceId", "authorPersonId", "byBoard", "body", "newsId")
           VALUES ('post-news-text', '${allId}', 'person-bo', true, 'Egen text.', 'news-draft')`,
        ),
      ).toEqual({ code: "23514", constraint: "post_text_or_news_item" });
      expect(
        await refusal(
          `INSERT INTO "post" ("id", "audienceId", "authorPersonId", "byBoard", "body", "newsId")
           VALUES ('post-resident-news', '${allId}', 'person-astrid', false, NULL, 'news-draft')`,
        ),
      ).toEqual({ code: "23514", constraint: "post_news_item_is_the_boards" });
      expect(
        await refusal(
          `INSERT INTO "post" ("id", "audienceId", "authorPersonId", "body")
           VALUES ('post-nobody', '${allId}', NULL, 'Vem skrev detta?')`,
        ),
      ).toEqual({
        code: "23514",
        constraint: "post_resident_post_names_its_author",
      });
      // And a second Alla or Styrelsen is refused by the partial indexes.
      for (const kind of ["ALL", "BOARD"]) {
        expect(
          await refusal(
            `INSERT INTO "audience" ("id", "kind", "updatedAt")
             VALUES ('audience-second-${kind}', '${kind}', CURRENT_TIMESTAMP)`,
          ),
          kind,
        ).toMatchObject({ code: "23505" });
      }
      // What it may hold: a neighbour's text, and a news item's post.
      await client.query(
        `INSERT INTO "post" ("id", "audienceId", "authorPersonId", "body")
         VALUES ('post-resident', '${allId}', 'person-astrid', 'Hej grannar.');
         INSERT INTO "post" ("id", "audienceId", "authorPersonId", "byBoard", "namesAuthor", "body", "newsId")
         VALUES ('post-news', '${allId}', NULL, true, false, NULL, 'news-draft');`,
      );
    });
  }, 180_000);

  it("leaves a fresh database with one Alla and one Styrelsen and nothing else", async () => {
    /*
     * An instance whose board never opened its chat has no room to rename, and
     * the migration writes Styrelsen itself. A fresh instance is that case with
     * every later migration on top, which is what a first deploy runs.
     */
    const url = await scratch.create("feed_fresh");

    await withClient(url, async (client) => {
      await apply(client, migrationNames());

      expect(
        await rows(
          client,
          `SELECT "kind"::text AS "kind", "name", count(*)::int AS "count"
           FROM "audience" GROUP BY "kind", "name" ORDER BY "kind"`,
        ),
      ).toEqual([
        { kind: "ALL", name: null, count: 1 },
        { kind: "BOARD", name: null, count: 1 },
      ]);
      expect(
        await rows(client, `SELECT count(*)::int AS "count" FROM "post"`),
      ).toEqual([{ count: 0 }]);
    });
  }, 180_000);
});
