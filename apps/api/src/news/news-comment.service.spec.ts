import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import { NewsCommentError } from "./news-comment.error";
import {
  COMMENTS_PER_WRITE_WINDOW,
  NewsCommentService,
  WRITE_WINDOW_MINUTES,
  refusePersonalIdentityNumbers,
} from "./news-comment.service";

/**
 * The rules a comment thread lives under, decided before any row is written.
 *
 * Five of them, and every one is a rule a database cannot be asked about.
 *
 * Visibility is inherited: a draft has no thread, and the refusal for a draft is
 * the refusal for an item that does not exist. Asserted as the reason code and
 * as the write never reaching the table, because a service that refused with the
 * right code after having inserted the row would satisfy a test that only read
 * the error. The same rule read from the other end is which items a reader is
 * offered at all, so the reader's list is asserted beside the refusals rather
 * than on its own: the two answers have to be the same answer.
 *
 * The personal identity number scan, which here protects a member from
 * themselves rather than the association from its board. Asserted on the
 * location it publishes and on the value it must not: a refusal that named the
 * number would put it in a response body, a log and somebody's screen.
 *
 * The write budget, which is per person and counted from the table rather than
 * per address and counted in memory. The window it asks for is asserted, not
 * only the refusal, because a count over the wrong window refuses and permits
 * exactly when a correct one would in a fixture of one.
 *
 * Who a comment is attributed to, including the two cases that are not a name.
 *
 * And that hiding withholds the text from readers, shows it to the board and to
 * the author, and never removes the comment from the thread. Both answers are
 * asserted for each reader, so a service that had stopped withholding anything
 * at all would fail rather than pass half the cases.
 *
 * What the database itself does with these rows is `news-comments.int-spec.ts`.
 */

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

const NEWS_ID = "news-1";
const DRAFT_ID = "news-draft";

interface CommentFixture {
  id: string;
  newsId: string;
  authorPersonId: string;
  body: string;
  hiddenAt: Date | null;
  createdAt: Date;
}

interface PersonFixture {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
}

/**
 * A news item as the column holds it.
 *
 * `content` is unknown rather than a parsed body, because unknown is what the
 * column is: the reader parses whatever is in there, and a fixture typed as the
 * parsed shape could not express the case the parser exists for.
 */
interface NewsFixture {
  id: string;
  slug: string;
  published: boolean;
  title: string;
  content: unknown;
  publishedAt: Date | null;
  createdAt: Date;
}

/** A news item: published, with one paragraph, unless told otherwise. */
function newsItem(overrides: Partial<NewsFixture> = {}): NewsFixture {
  return {
    id: NEWS_ID,
    slug: "portkoden-byts",
    published: true,
    title: "Portkoden byts",
    content: {
      version: 1,
      blocks: [{ type: "paragraph", runs: [{ text: "Vi byter portkod." }] }],
    },
    publishedAt: new Date("2026-08-01T08:00:00.000Z"),
    createdAt: new Date("2026-08-01T07:00:00.000Z"),
    ...overrides,
  };
}

function principal(personId: string, capabilities: Capability[]): Principal {
  return {
    personId,
    capabilities: new Set(capabilities),
    isAdmin: false,
    isBoardMember: capabilities.includes("site:manage"),
    isPropertyManager: false,
    isResident: true,
    isMember: true,
  };
}

/**
 * A database holding these news items, comments and people.
 *
 * Every query is implemented rather than stubbed with an answer, because what is
 * under test is what the service asks of it. A `count` that ignored its `where`
 * would let the budget test pass whatever window the service asked for, and a
 * `findMany` that ignored its `newsId` would let a thread read return another
 * item's comments and still look right.
 */
function build(options: {
  news?: NewsFixture[];
  comments?: CommentFixture[];
  persons?: PersonFixture[];
}) {
  const news = options.news ?? [
    newsItem(),
    newsItem({
      id: DRAFT_ID,
      slug: "utkast",
      published: false,
      title: "Utkast",
      publishedAt: null,
    }),
  ];
  const comments = [...(options.comments ?? [])];
  const persons = options.persons ?? [];

  const create = vi.fn(
    async (args: {
      data: { newsId: string; authorPersonId: string; body: string };
    }) => {
      const row: CommentFixture = {
        id: `comment-${String(comments.length + 1)}`,
        newsId: args.data.newsId,
        authorPersonId: args.data.authorPersonId,
        body: args.data.body,
        hiddenAt: null,
        createdAt: new Date("2026-08-01T12:00:00.000Z"),
      };
      comments.push(row);
      return row;
    },
  );

  const update = vi.fn(
    async (args: {
      where: { id: string };
      data: { hiddenAt: Date; hiddenByPersonId: string };
    }) => {
      const row = comments.find((one) => one.id === args.where.id);
      if (row === undefined) {
        throw new Error(`no comment ${args.where.id}`);
      }
      row.hiddenAt = args.data.hiddenAt;
      return row;
    },
  );

  const count = vi.fn(
    async (args: {
      where: { authorPersonId: string; createdAt: { gte: Date } };
    }) =>
      comments.filter(
        (one) =>
          one.authorPersonId === args.where.authorPersonId &&
          one.createdAt.getTime() >= args.where.createdAt.gte.getTime(),
      ).length,
  );

  const prisma = {
    news: {
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          news.find((one) => one.id === args.where.id) ?? null,
      ),
      /*
       * The filter and the order are applied rather than assumed, for the reason
       * the note above gives: a findMany that ignored its `where` would let a
       * reader's list carry the board's drafts and still pass a test that only
       * counted the published ones, and one that ignored its `orderBy` would let
       * the newest-first rule be whatever order the fixture happens to be in.
       */
      findMany: vi.fn(async (args: { where: { published: boolean } }) =>
        news
          .filter((one) => one.published === args.where.published)
          .sort(
            (a, b) =>
              (b.publishedAt ?? b.createdAt).getTime() -
              (a.publishedAt ?? a.createdAt).getTime(),
          ),
      ),
    },
    newsComment: {
      findMany: vi.fn(async (args: { where: { newsId: string } }) =>
        comments
          .filter((one) => one.newsId === args.where.newsId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const row = comments.find((one) => one.id === args.where.id);
        if (row === undefined) {
          return null;
        }
        const item = news.find((one) => one.id === row.newsId);
        return { ...row, news: { published: item?.published === true } };
      }),
      count,
      create,
      update,
    },
    person: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        persons.filter((one) => args.where.id.in.includes(one.id)),
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          persons.find((one) => one.id === args.where.id) ?? null,
      ),
    },
    $transaction: vi.fn(
      async (run: (client: typeof prisma) => Promise<unknown>) => run(prisma),
    ),
  };

  const audit = {
    record: vi.fn(
      async (_entry: {
        action: string;
        actorPersonId?: string | null;
        targetPersonId?: string | null;
        context?: Record<string, unknown>;
      }) => undefined,
    ),
  };

  return {
    service: new NewsCommentService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
    ),
    prisma,
    audit,
    comments,
  };
}

/** A comment fixture, written now unless a date is given. */
function comment(overrides: Partial<CommentFixture> = {}): CommentFixture {
  return {
    id: "comment-1",
    newsId: NEWS_ID,
    authorPersonId: "person-astrid",
    body: "Tack for beskedet.",
    hiddenAt: null,
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    ...overrides,
  };
}

const ASTRID: PersonFixture = {
  id: "person-astrid",
  firstName: "Astrid",
  lastName: "Holm",
  protectedPersonalData: false,
};

const PROTECTED: PersonFixture = {
  id: "person-siv",
  firstName: "Siv",
  lastName: "Skyddad",
  protectedPersonalData: true,
};

describe("a comment is exactly as visible as its news item", () => {
  it("refuses a thread on a draft as it refuses one that does not exist", async () => {
    const { service } = build({});
    const reader = principal("person-astrid", ["news:comment"]);

    const onDraft = await service
      .list(DRAFT_ID, reader)
      .catch((error: unknown) => error);
    const onNothing = await service
      .list("news-nowhere", reader)
      .catch((error: unknown) => error);

    expect(onDraft).toBeInstanceOf(NewsCommentError);
    expect((onDraft as NewsCommentError).reason).toBe("news-not-found");
    // The same reason and the same status, so a caller holding news:comment
    // cannot walk the identifier space to learn which drafts the board has.
    expect((onNothing as NewsCommentError).reason).toBe("news-not-found");
    expect((onDraft as NewsCommentError).status).toBe(
      (onNothing as NewsCommentError).status,
    );
  });

  it("writes nothing at all into a draft's thread", async () => {
    const { service, prisma, audit } = build({});

    await expect(
      service.write({
        newsId: DRAFT_ID,
        authorPersonId: "person-astrid",
        body: "Hej.",
      }),
    ).rejects.toBeInstanceOf(NewsCommentError);

    // The refusal reaching the caller is not the property: a service that
    // inserted the row and then threw would pass an assertion on the error.
    expect(prisma.newsComment.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("offers the reader the published items, newest first, and no draft", async () => {
    const { service } = build({
      news: [
        newsItem({ id: "news-old", slug: "gammal", title: "Gammal nyhet" }),
        newsItem({
          id: "news-new",
          slug: "ny",
          title: "Ny nyhet",
          publishedAt: new Date("2026-08-20T08:00:00.000Z"),
        }),
        newsItem({
          id: DRAFT_ID,
          slug: "utkast",
          published: false,
          title: "Utkast",
          publishedAt: null,
        }),
      ],
    });

    const offered = await service.commentableNews();

    /*
     * The list and the threads are one rule read twice. Whatever is on this list
     * has a thread that opens, and the draft that is absent from it is refused as
     * an item that was never written - so a screen cannot show a notice it cannot
     * open, and the identifiers of the board's drafts are not on the wire.
     */
    expect(offered.map((item) => item.id)).toEqual(["news-new", "news-old"]);
    expect(offered.map((item) => item.title)).toEqual([
      "Ny nyhet",
      "Gammal nyhet",
    ]);
  });

  it("hands the reader the prose and never a block a renderer cannot vouch for", async () => {
    const { service } = build({
      news: [
        newsItem({
          content: {
            version: 1,
            blocks: [
              { type: "heading", level: 2, runs: [{ text: "Ta med" }] },
              {
                type: "paragraph",
                runs: [
                  { text: "Handskar" },
                  { text: "och en hink", link: "javascript:alert(1)" },
                ],
              },
              { type: "image", mediaFileId: "file-1", alt: "" },
            ],
          },
        }),
      ],
    });

    const [item] = await service.commentableNews();

    /*
     * The narrowing the website does, done here as well. A news item is an
     * announcement: a block that reads a picture or a list of other items out of
     * the database would make one notice a second place where what is disclosed
     * is decided, and this list is read by a browser that would happily render
     * whatever href it is handed. Both halves are asserted, because a body that
     * kept its text and its link would pass an assertion on the block types
     * alone.
     */
    expect(item?.content.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
    ]);
    const paragraph = item?.content.blocks[1];
    expect(
      paragraph?.type === "paragraph"
        ? paragraph.runs.map((run) => run.link)
        : undefined,
    ).toEqual([undefined, undefined]);
  });
});

describe("the personal identity number scan", () => {
  it("refuses the write and says where, without echoing the value", () => {
    const body = `Ring Anna, ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}, om porten.`;

    const error = (() => {
      try {
        refusePersonalIdentityNumbers(body);
        return null;
      } catch (cause: unknown) {
        return cause as NewsCommentError;
      }
    })();

    expect(error).toBeInstanceOf(NewsCommentError);
    expect(error?.reason).toBe("personal-identity-number");
    expect(error?.details?.()).toEqual({
      locations: [{ part: "body", offset: body.indexOf("1981") }],
    });

    // The thing the scan caught is exactly the thing that must not travel back.
    const published = JSON.stringify({
      message: error?.message,
      details: error?.details?.(),
    });
    expect(published).not.toContain(LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER);
    expect(published).not.toContain("198112189876");
  });

  it("stops the comment reaching the table", async () => {
    const { service, prisma } = build({});

    await expect(
      service.write({
        newsId: NEWS_ID,
        authorPersonId: "person-astrid",
        body: `Hen har ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}.`,
      }),
    ).rejects.toBeInstanceOf(NewsCommentError);

    expect(prisma.newsComment.create).not.toHaveBeenCalled();
  });

  it("lets an ordinary comment through", async () => {
    const { service, prisma } = build({ persons: [ASTRID] });

    await service.write({
      newsId: NEWS_ID,
      authorPersonId: ASTRID.id,
      body: "Tack for beskedet om porten.",
    });

    expect(prisma.newsComment.create).toHaveBeenCalledTimes(1);
  });
});

describe("the per-person write budget", () => {
  it("refuses the caller who has written their allowance for the window", async () => {
    const written = Array.from(
      { length: COMMENTS_PER_WRITE_WINDOW },
      (_unused, index) =>
        comment({
          id: `comment-old-${String(index)}`,
          authorPersonId: ASTRID.id,
          createdAt: new Date(),
        }),
    );
    const { service, prisma } = build({
      comments: written,
      persons: [ASTRID],
    });

    const error = await service
      .write({ newsId: NEWS_ID, authorPersonId: ASTRID.id, body: "En mer." })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NewsCommentError);
    expect((error as NewsCommentError).reason).toBe("too-many-comments");
    expect((error as NewsCommentError).status).toBe(429);
    expect(prisma.newsComment.create).not.toHaveBeenCalled();
  });

  it("counts this person's comments over the window and nobody else's", async () => {
    /*
     * The budget is one person's, and it is a count of what they wrote inside
     * the window. Three things could each be wrong without the refusal above
     * noticing: the window, the person, and whether an older comment still
     * counts. So the query is read back rather than inferred from the answer.
     */
    const outsideWindow = new Date(
      Date.now() - (WRITE_WINDOW_MINUTES + 1) * 60 * 1000,
    );
    const { service, prisma } = build({
      comments: [
        // This person, long enough ago that it is out of the window.
        comment({
          id: "old",
          authorPersonId: ASTRID.id,
          createdAt: outsideWindow,
        }),
        // Somebody else, inside it.
        comment({
          id: "theirs",
          authorPersonId: PROTECTED.id,
          createdAt: new Date(),
        }),
      ],
      persons: [ASTRID, PROTECTED],
    });

    await service.write({
      newsId: NEWS_ID,
      authorPersonId: ASTRID.id,
      body: "Tack.",
    });

    const asked = prisma.newsComment.count.mock.calls[0]?.[0].where;
    expect(asked?.authorPersonId).toBe(ASTRID.id);
    const window = Date.now() - (asked?.createdAt.gte.getTime() ?? 0);
    expect(window).toBeGreaterThanOrEqual(WRITE_WINDOW_MINUTES * 60 * 1000);
    // Within a second of the window rather than exactly it, because the service
    // reads its own clock. A window an order of magnitude out fails here.
    expect(window).toBeLessThan(WRITE_WINDOW_MINUTES * 60 * 1000 + 1000);
  });
});

describe("who a comment is attributed to", () => {
  it("names an ordinary author", async () => {
    const { service } = service_with_thread(
      [ASTRID],
      [comment({ authorPersonId: ASTRID.id })],
    );

    const thread = await service.list(
      NEWS_ID,
      principal("person-other", ["news:comment"]),
    );

    expect(thread[0]?.author).toEqual({
      kind: "resident",
      personId: ASTRID.id,
      name: "Astrid Holm",
    });
  });

  it("names a person with protected personal data to nobody, the board included", async () => {
    const { service } = service_with_thread(
      [PROTECTED],
      [comment({ id: "comment-1", authorPersonId: PROTECTED.id })],
    );

    for (const reader of [
      principal("person-other", ["news:comment"]),
      principal("person-board", ["news:comment", "site:manage"]),
    ]) {
      const thread = await service.list(NEWS_ID, reader);

      expect(thread[0]?.author).toEqual({
        kind: "protected",
        personId: PROTECTED.id,
      });
      // The name is not merely absent from the field it belongs in.
      expect(JSON.stringify(thread)).not.toContain("Siv");
      expect(JSON.stringify(thread)).not.toContain("Skyddad");
    }
  });

  it("says it no longer knows when the author has been purged away", async () => {
    // A comment is service tier and a person can be purged out from under one.
    const { service } = service_with_thread(
      [],
      [comment({ authorPersonId: "person-gone" })],
    );

    const thread = await service.list(
      NEWS_ID,
      principal("person-other", ["news:comment"]),
    );

    expect(thread[0]?.author).toEqual({ kind: "unknown" });
  });
});

describe("hiding a comment", () => {
  it("withholds the text from a reader and keeps the comment in the thread", async () => {
    const hidden = comment({
      id: "comment-1",
      authorPersonId: ASTRID.id,
      body: "Detta doldes.",
      hiddenAt: new Date("2026-08-02T12:00:00.000Z"),
    });
    const { service } = service_with_thread([ASTRID], [hidden]);

    const thread = await service.list(
      NEWS_ID,
      principal("person-other", ["news:comment"]),
    );

    // Struck through, not gone: a board that could make a comment disappear
    // would leave nobody reading the thread able to tell which had happened.
    expect(thread).toHaveLength(1);
    expect(thread[0]?.hiddenAt).toBe("2026-08-02T12:00:00.000Z");
    expect(thread[0]?.body).toBeNull();
    expect(JSON.stringify(thread)).not.toContain("Detta doldes");
  });

  it("shows the text to whoever moderates the website and to its author", async () => {
    const hidden = comment({
      id: "comment-1",
      authorPersonId: ASTRID.id,
      body: "Detta doldes.",
      hiddenAt: new Date("2026-08-02T12:00:00.000Z"),
    });
    const { service } = service_with_thread([ASTRID], [hidden]);

    const forBoard = await service.list(
      NEWS_ID,
      principal("person-board", ["news:comment", "site:manage"]),
    );
    const forAuthor = await service.list(
      NEWS_ID,
      principal(ASTRID.id, ["news:comment"]),
    );

    expect(forBoard[0]?.body).toBe("Detta doldes.");
    expect(forAuthor[0]?.body).toBe("Detta doldes.");
  });

  it("records the act against the person it was done to", async () => {
    const { service, audit } = service_with_thread(
      [ASTRID],
      [comment({ id: "comment-1", authorPersonId: ASTRID.id })],
    );

    await service.hide("comment-1", "person-board");

    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0]?.[0];
    expect(entry?.action).toBe("NEWS_COMMENT_HIDDEN");
    expect(entry?.actorPersonId).toBe("person-board");
    // The subject is whoever wrote it: their access report has to show a
    // moderation somebody else decided on.
    expect(entry?.targetPersonId).toBe(ASTRID.id);
  });

  it("is not an event the second time", async () => {
    // The precedent the publish path sets: a write that changes nothing writes
    // nothing, and a second press does not belong in the audit log.
    const { service, audit, prisma } = service_with_thread(
      [ASTRID],
      [
        comment({
          id: "comment-1",
          authorPersonId: ASTRID.id,
          hiddenAt: new Date("2026-08-02T12:00:00.000Z"),
        }),
      ],
    );

    await service.hide("comment-1", "person-board");

    expect(prisma.newsComment.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a comment on a draft as it refuses one that does not exist", async () => {
    const { service } = service_with_thread(
      [ASTRID],
      [
        comment({
          id: "comment-1",
          newsId: DRAFT_ID,
          authorPersonId: ASTRID.id,
        }),
      ],
    );

    const onDraft = await service
      .hide("comment-1", "person-board")
      .catch((cause: unknown) => cause);
    const onNothing = await service
      .hide("comment-nowhere", "person-board")
      .catch((cause: unknown) => cause);

    expect((onDraft as NewsCommentError).reason).toBe("comment-not-found");
    expect((onNothing as NewsCommentError).reason).toBe("comment-not-found");
  });
});

describe("what a written comment records", () => {
  it("names the notice and how much was written, never the text", async () => {
    /*
     * The audit log is append-only and exempt from every purge, so it outlives
     * the comment the purge erases. A body copied into the entry would be a
     * permanent record of what somebody said, inside the entry meant to record
     * only that they said something.
     */
    const { service, audit } = build({ persons: [ASTRID] });
    const body = "Tack for beskedet om porten.";

    await service.write({
      newsId: NEWS_ID,
      authorPersonId: ASTRID.id,
      body,
    });

    const entry = audit.record.mock.calls[0]?.[0];
    expect(entry?.action).toBe("NEWS_COMMENT_POSTED");
    expect(entry?.actorPersonId).toBe(ASTRID.id);
    expect(entry?.targetPersonId).toBe(ASTRID.id);
    expect(entry?.context).toEqual({
      newsId: NEWS_ID,
      slug: "portkoden-byts",
      bodyLength: body.length,
    });
    expect(JSON.stringify(entry?.context)).not.toContain("Tack");
  });
});

/** A service over a published item carrying these people and these comments. */
function service_with_thread(
  persons: PersonFixture[],
  comments: CommentFixture[],
) {
  return build({ persons, comments });
}
