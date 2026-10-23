import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import { parseFeedCursor } from "./feed-cursor";
import { FeedError } from "./feed.error";
import {
  COMMENT_WINDOW_MINUTES,
  COMMENTS_PER_PAGE,
  COMMENTS_PER_WRITE_WINDOW,
  PostCommentService,
  refuseTooManyComments,
} from "./post-comment.service";

/**
 * The rules a comment lives under, decided before any row is written.
 *
 * **Visibility is the post's, never the comment's own.** Every path asks the
 * feed's one check for the post a comment sits on, so a comment under a post in
 * a group is refused to somebody outside it exactly as a comment, or a post,
 * that does not exist - reading the thread, writing into it and liking one line
 * of it alike.
 *
 * **A post can close its thread.** A post with comments turned off takes none,
 * and a struck post takes none either: what the board withheld is not a thing
 * to answer in front of the others.
 *
 * **The write budget is per person and counted from the table**, over every
 * post at once, because a comment under a news item is a comment under its post
 * and one person has one budget for both screens.
 *
 * **A personal identity number is refused**, naming positions and never the
 * value.
 *
 * **A struck comment's text is withheld** from everybody but its author and a
 * board member who moderates, and its attribution stays.
 *
 * The clock is the test's own, so "now" is one instant every assertion can
 * name.
 */

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

const ALL_ID = "audience-all";
const GROUP_ID = "audience-garden";
const POST_ID = "post-garden";
const NOW = new Date("2026-09-17T09:00:00.000Z");

interface AudienceFixture {
  id: string;
  kind: "ALL" | "BOARD" | "GROUP" | "ADMIN";
  name: string | null;
  createdByPersonId: string | null;
}

/** A post, as far as the question of whether somebody may read it goes. */
interface PostFixture {
  id: string;
  audienceId: string;
  authorPersonId: string | null;
  newsId: string | null;
  commentsAllowed: boolean;
  struckAt: Date | null;
  createdAt: Date;
  /** Set on a post the purge has erased; absent on every other. */
  erasedAt?: Date | null;
}

interface CommentFixture {
  id: string;
  postId: string;
  authorPersonId: string;
  byBoard: boolean;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  struckAt: Date | null;
}

interface PersonFixture {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
  /** When this person's board term ended, null while held, absent if never. */
  seatEndedOn?: Date | null;
  /** When this person's residency ended, null while held, absent if never. */
  movedOutOn?: Date | null;
}

function commentFixture(
  fields: Pick<CommentFixture, "id" | "authorPersonId" | "body" | "createdAt"> &
    Partial<CommentFixture>,
): CommentFixture {
  return {
    postId: POST_ID,
    byBoard: false,
    editedAt: null,
    struckAt: null,
    ...fields,
  };
}

type Where = Record<string, unknown>;

/** Two column values, compared the way the database compares them. */
function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  throw new Error(`The fake cannot compare ${typeof a} with ${typeof b}.`);
}

/**
 * Whether a row satisfies a filter, read the way Prisma reads it.
 *
 * Strict rather than lenient: a column the row does not have, a relation the
 * caller did not supply, or an operator this does not know throws rather than
 * matching. A fake that quietly ignored a condition it did not understand would
 * let the service drop exactly that condition - the post a page is of, the
 * cursor's tie, the instant a post is shown from - and every test here would
 * still pass.
 */
function matches(
  row: object,
  where: Where,
  related: (relation: string, row: object) => object | null,
): boolean {
  const columns = row as Record<string, unknown>;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") {
      return (condition as Where[]).every((branch) =>
        matches(row, branch, related),
      );
    }
    if (key === "OR") {
      return (condition as Where[]).some((branch) =>
        matches(row, branch, related),
      );
    }
    if (!(key in columns)) {
      const other = related(key, row);
      return other !== null && matches(other, condition as Where, related);
    }
    const value = columns[key];
    if (condition === null || typeof condition !== "object") {
      return value === condition;
    }
    if (condition instanceof Date) {
      return value instanceof Date && compare(value, condition) === 0;
    }
    return Object.entries(condition).every(([operator, operand]) => {
      switch (operator) {
        case "lt":
          return value !== null && compare(value, operand) < 0;
        case "lte":
          return value !== null && compare(value, operand) <= 0;
        case "gt":
          return value !== null && compare(value, operand) > 0;
        case "gte":
          return value !== null && compare(value, operand) >= 0;
        default:
          throw new Error(`The fake does not answer ${key}.${operator}.`);
      }
    });
  });
}

type OrderBy = readonly Record<string, "asc" | "desc">[];

/** The comparator the query asked for, term by term. */
function byOrder(orderBy: OrderBy) {
  return (a: object, b: object): number => {
    for (const term of orderBy) {
      for (const [column, direction] of Object.entries(term)) {
        const difference = compare(
          (a as Record<string, unknown>)[column],
          (b as Record<string, unknown>)[column],
        );
        if (difference !== 0) {
          return direction === "asc" ? difference : -difference;
        }
      }
    }
    return 0;
  };
}

/** The seat clause as the service spells it, read back out of the query. */
interface SeatWhere {
  id?: string;
  boardPositions?: {
    some: { OR: [{ endedOn: null }, { endedOn: { gt: Date } }] };
  };
}

/** Whether this person's seat satisfies the clause, at the clock it carries. */
function holdsSeat(person: PersonFixture, where: SeatWhere): boolean {
  if (where.boardPositions === undefined) {
    return true;
  }
  if (person.seatEndedOn === undefined) {
    return false;
  }
  const [, future] = where.boardPositions.some.OR;
  return (
    person.seatEndedOn === null ||
    person.seatEndedOn.getTime() > future.endedOn.gt.getTime()
  );
}

function principal(personId: string, capabilities: Capability[]): Principal {
  return {
    personId,
    capabilities: new Set(capabilities),
    isAdmin: false,
    isBoardMember: false,
    isPropertyManager: false,
    isResident: true,
    isMember: true,
  };
}

/**
 * A database holding these audiences, posts, comments and people.
 *
 * Every query is implemented rather than stubbed with an answer, because what is
 * under test is what the service asks of it. The post a comment sits on is read
 * through the feed's own visibility check, so the membership half of this fake
 * is the feed service's: the group's written-down row and the residency that
 * says the person still lives here.
 */
function build(options: {
  audiences?: AudienceFixture[];
  posts?: PostFixture[];
  news?: { id: string; published: boolean }[];
  comments?: CommentFixture[];
  likes?: { commentId: string; personId: string }[];
  /** Who has reported which comment to the board. */
  commentReports?: { commentId: string; reporterPersonId: string }[];
  persons?: PersonFixture[];
  groupMembers?: { audienceId: string; personId: string }[];
  /**
   * The purge erases the post after the check before the transaction and
   * before the read under the share lock: the moment a plain read would miss.
   */
  erasedInFlight?: boolean;
}) {
  const audiences = options.audiences ?? [];
  const posts = options.posts ?? [];
  const news = options.news ?? [];
  const comments = [...(options.comments ?? [])];
  const likes = [...(options.likes ?? [])];
  const commentReports = options.commentReports ?? [];
  const persons = options.persons ?? [];
  const groupMembers = options.groupMembers ?? [];
  /** The earlier versions of comments, kept when their writers edited them. */
  const revisions: {
    commentId: string;
    body: string;
    writtenAt: Date;
    replacedAt: Date;
  }[] = [];

  function related(relation: string, row: object): object | null {
    if (relation !== "news") {
      throw new Error(`The fake has no relation ${relation}.`);
    }
    const { newsId } = row as PostFixture;
    return news.find((item) => item.id === newsId) ?? null;
  }

  /** A comment as the service selects it: its likes counted, and the reader's own. */
  function shaped(
    row: CommentFixture,
    select?: {
      likes?: { where: { personId: string } };
      reports?: { where: { reporterPersonId: string } };
    },
  ) {
    return {
      ...row,
      _count: {
        likes: likes.filter((like) => like.commentId === row.id).length,
      },
      likes: likes
        .filter(
          (like) =>
            like.commentId === row.id &&
            like.personId === select?.likes?.where.personId,
        )
        .map((like) => ({ personId: like.personId })),
      // The reader's own report, and nobody else's.
      reports: commentReports
        .filter(
          (report) =>
            report.commentId === row.id &&
            report.reporterPersonId === select?.reports?.where.reporterPersonId,
        )
        .map((report) => ({ id: `report-${report.commentId}` })),
    };
  }

  const commentCreate = vi.fn(
    async (args: {
      data: {
        postId: string;
        authorPersonId: string;
        body: string;
        createdAt?: Date;
      };
      select?: {
        likes?: { where: { personId: string } };
        reports?: { where: { reporterPersonId: string } };
      };
    }) => {
      const row = commentFixture({
        id: `comment-new-${String(comments.length + 1)}`,
        postId: args.data.postId,
        authorPersonId: args.data.authorPersonId,
        body: args.data.body,
        createdAt: args.data.createdAt ?? new Date(),
      });
      comments.push(row);
      return shaped(row, args.select);
    },
  );

  const commentCount = vi.fn(async (args: { where: Where }) => {
    return comments.filter((row) => matches(row, args.where, related)).length;
  });

  /** Every advisory lock key a call took, in order. */
  const locks: string[] = [];

  const prisma = {
    post: {
      findFirst: vi.fn(async (args: { where: Where }) => {
        const row = posts.find((each) => matches(each, args.where, related));
        if (row === undefined) {
          return null;
        }
        return {
          ...row,
          erasedAt: row.erasedAt ?? null,
          audience: audiences.find(
            (audience) => audience.id === row.audienceId,
          ),
        };
      }),
    },
    postComment: {
      findMany: vi.fn(
        async (args: {
          where: Where;
          orderBy: OrderBy;
          take?: number;
          select?: {
            likes?: { where: { personId: string } };
            reports?: { where: { reporterPersonId: string } };
          };
        }) => {
          const rows = comments
            .filter((row) => matches(row, args.where, related))
            .sort(byOrder(args.orderBy));
          return (
            args.take === undefined ? rows : rows.slice(0, args.take)
          ).map((row) => shaped(row, args.select));
        },
      ),
      findUnique: vi.fn(
        async (args: {
          where: { id: string };
          select?: {
            likes?: { where: { personId: string } };
            reports?: { where: { reporterPersonId: string } };
          };
        }) => {
          const row = comments.find((each) => each.id === args.where.id);
          return row === undefined ? null : shaped(row, args.select);
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: { body: string; editedAt: Date };
        }) => {
          const row = comments.find((each) => each.id === args.where.id);
          if (row === undefined) {
            throw new Error(`No comment ${args.where.id}.`);
          }
          Object.assign(row, args.data);
          return row;
        },
      ),
      /** The newest comment a stamp is taken after. */
      findFirst: vi.fn(async (args: { where: Where; orderBy: OrderBy }) => {
        const [row] = comments
          .filter((each) => matches(each, args.where, related))
          .sort(byOrder(args.orderBy));
        return row === undefined ? null : { createdAt: row.createdAt };
      }),
      count: commentCount,
      create: commentCreate,
    },
    postCommentRevision: {
      count: vi.fn(
        async (args: { where: { commentId: string } }) =>
          revisions.filter((each) => each.commentId === args.where.commentId)
            .length,
      ),
      create: vi.fn(async (args: { data: (typeof revisions)[number] }) => {
        revisions.push(args.data);
        return args.data;
      }),
      findMany: vi.fn(async (args: { where: { commentId: string } }) =>
        revisions
          .filter((each) => each.commentId === args.where.commentId)
          .sort((a, b) => b.replacedAt.getTime() - a.replacedAt.getTime()),
      ),
    },
    postCommentLike: {
      count: vi.fn(
        async (args: { where: { commentId: string } }) =>
          likes.filter((like) => like.commentId === args.where.commentId)
            .length,
      ),
      deleteMany: vi.fn(
        async (args: { where: { commentId: string; personId: string } }) => {
          const before = likes.length;
          for (let index = likes.length - 1; index >= 0; index -= 1) {
            const like = likes[index];
            if (
              like?.commentId === args.where.commentId &&
              like.personId === args.where.personId
            ) {
              likes.splice(index, 1);
            }
          }
          return { count: before - likes.length };
        },
      ),
    },
    groupMember: {
      findUnique: vi.fn(
        async (args: {
          where: {
            audienceId_personId: { audienceId: string; personId: string };
          };
        }) =>
          groupMembers.find(
            (member) =>
              member.audienceId === args.where.audienceId_personId.audienceId &&
              member.personId === args.where.audienceId_personId.personId,
          ) ?? null,
      ),
    },
    residency: {
      findFirst: vi.fn(
        async (args: {
          where: {
            personId: string;
            OR: [unknown, { movedOutOn: { gt: Date } }];
          };
        }) => {
          const person = persons.find(
            (each) => each.id === args.where.personId,
          );
          if (person?.movedOutOn === undefined) {
            return null;
          }
          const [, future] = args.where.OR;
          return person.movedOutOn === null ||
            person.movedOutOn.getTime() > future.movedOutOn.gt.getTime()
            ? { id: `residency-${person.id}` }
            : null;
        },
      ),
    },
    person: {
      findFirst: vi.fn(
        async (args: { where: SeatWhere }) =>
          persons.find(
            (person) =>
              person.id === args.where.id && holdsSeat(person, args.where),
          ) ?? null,
      ),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        persons.filter((person) => args.where.id.in.includes(person.id)),
      ),
    },
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("pg_advisory_xact_lock")) {
          locks.push(String(values[0]));
          return 1;
        }
        if (sql.includes('INSERT INTO "post_comment_like"')) {
          // Written once: ON CONFLICT DO NOTHING on the pair.
          const [commentId, personId] = values as [string, string];
          if (
            likes.some(
              (like) =>
                like.commentId === commentId && like.personId === personId,
            )
          ) {
            return 0;
          }
          likes.push({ commentId, personId });
          return 1;
        }
        throw new Error(`The fake does not answer: ${sql}`);
      },
    ),
    /*
     * The post's row read under a share lock, inside the transaction, and a
     * comment's under its own lock before an edit.
     */
    $queryRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes('FROM "post_comment"') && sql.includes("FOR UPDATE")) {
          const comment = comments.find((each) => each.id === values[0]);
          return comment === undefined ? [] : [{ ...comment }];
        }
        if (!sql.includes("FOR SHARE")) {
          throw new Error(`The fake does not answer: ${sql}`);
        }
        const row = posts.find((each) => each.id === values[0]);
        return row === undefined
          ? []
          : [
              {
                struckAt: row.struckAt,
                commentsAllowed: row.commentsAllowed,
                erasedAt:
                  options.erasedInFlight === true
                    ? new Date()
                    : (row.erasedAt ?? null),
              },
            ];
      },
    ),
  };

  Object.assign(prisma, {
    // One client either way: what a transaction guarantees is a property of the
    // database, and the lock inside it is what the tests below read.
    $transaction: vi.fn(async (work: (tx: typeof prisma) => Promise<unknown>) =>
      work(prisma),
    ),
  });

  return {
    service: new PostCommentService(prisma as unknown as PrismaService),
    prisma,
    comments,
    likes,
    revisions,
    locks,
    commentCount,
    commentCreate,
  };
}

const ALL: AudienceFixture = {
  id: ALL_ID,
  kind: "ALL",
  name: null,
  createdByPersonId: null,
};

const GROUP: AudienceFixture = {
  id: GROUP_ID,
  kind: "GROUP",
  name: "Trädgårdsgruppen",
  createdByPersonId: "person-nils",
};

/** In the group, and lives here. */
const MEMBER: PersonFixture = {
  id: "person-nils",
  firstName: "Nils",
  lastName: "Lindqvist",
  protectedPersonalData: false,
  movedOutOn: null,
};

/** In the group, lives here, and wrote the line the board struck. */
const BO: PersonFixture = {
  id: "person-bo",
  firstName: "Bo",
  lastName: "Ek",
  protectedPersonalData: false,
  movedOutOn: null,
};

/** Holds a seat, lives here, and was put into the group too. */
const SEATED: PersonFixture = {
  id: "person-astrid",
  firstName: "Astrid",
  lastName: "Lindqvist",
  protectedPersonalData: false,
  seatEndedOn: null,
  movedOutOn: null,
};

/** Lives here and holds a seat, and is not in the group. */
const OUTSIDER: PersonFixture = {
  id: "person-karin",
  firstName: "Karin",
  lastName: "Berg",
  protectedPersonalData: false,
  seatEndedOn: null,
  movedOutOn: null,
};

/** The group's post every test but the closed-thread ones comments on. */
const GROUP_POST: PostFixture = {
  id: POST_ID,
  audienceId: GROUP_ID,
  authorPersonId: MEMBER.id,
  newsId: null,
  commentsAllowed: true,
  struckAt: null,
  createdAt: new Date(Date.UTC(2026, 0, 1)),
};

/** A thread of `count` comments under the group's post, one an hour, oldest first. */
function commentsOverHours(count: number, authorPersonId: string) {
  return Array.from({ length: count }, (_, index) =>
    commentFixture({
      id: `comment-${String(index + 1).padStart(3, "0")}`,
      authorPersonId,
      body: `Svar ${String(index + 1)}.`,
      createdAt: new Date(Date.UTC(2026, 0, 2, index)),
    }),
  );
}

/** The group, its post, and whatever else a test puts in. */
function group(options: Parameters<typeof build>[0] = {}) {
  return build({
    audiences: [ALL, GROUP],
    posts: [GROUP_POST],
    persons: [MEMBER, BO, SEATED, OUTSIDER],
    groupMembers: [
      { audienceId: GROUP_ID, personId: MEMBER.id },
      { audienceId: GROUP_ID, personId: BO.id },
      { audienceId: GROUP_ID, personId: SEATED.id },
    ],
    ...options,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading a post's comments", () => {
  it("answers the newest page, oldest first inside it", async () => {
    /*
     * A reader opening a long thread lands where the conversation is, and reads
     * it top to bottom as it was written.
     */
    const { service } = group({
      comments: commentsOverHours(COMMENTS_PER_PAGE + 10, BO.id),
    });

    const page = await service.page(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
    );

    expect(page.comments).toHaveLength(COMMENTS_PER_PAGE);
    expect(page.comments[0]?.body).toBe("Svar 11.");
    expect(page.comments.at(-1)?.body).toBe(
      `Svar ${String(COMMENTS_PER_PAGE + 10)}.`,
    );
    expect(page.earlier).not.toBeNull();
    // The poll goes on from the newest comment on the page.
    expect(page.latest).toBe(
      `${new Date(Date.UTC(2026, 0, 2, COMMENTS_PER_PAGE + 9)).toISOString()}|comment-${String(COMMENTS_PER_PAGE + 10).padStart(3, "0")}`,
    );
  });

  it("says there is nothing earlier when the thread fits on one page", async () => {
    const { service } = group({ comments: commentsOverHours(3, BO.id) });

    const page = await service.page(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
    );

    expect(page.comments).toHaveLength(3);
    expect(page.earlier).toBeNull();
  });

  it("has no cursor for the poll while nobody has commented", async () => {
    const { service } = group();

    const page = await service.page(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
    );

    expect(page).toEqual({ comments: [], earlier: null, latest: null });
  });

  it("walks a whole thread backwards from the earlier cursor, every comment exactly once", async () => {
    const total = COMMENTS_PER_PAGE * 2 + 3;
    const written = commentsOverHours(total, BO.id);
    const { service } = group({ comments: written });
    const reader = principal(MEMBER.id, ["chat:participate"]);

    const seen: string[] = [];
    let cursor = null as string | null;
    for (;;) {
      const page: Awaited<ReturnType<typeof service.page>> = await service.page(
        reader,
        POST_ID,
        cursor === null ? null : parseFeedCursor(cursor),
      );
      seen.unshift(...page.comments.map((comment) => comment.id));
      if (page.earlier === null) {
        break;
      }
      cursor = page.earlier;
    }

    expect(seen).toEqual(written.map((comment) => comment.id));
  });

  it("reads only the comments of the post asked for", async () => {
    const { service } = group({
      posts: [GROUP_POST, { ...GROUP_POST, id: "post-other" }],
      comments: [
        commentFixture({
          id: "comment-here",
          authorPersonId: BO.id,
          body: "Här.",
          createdAt: NOW,
        }),
        commentFixture({
          id: "comment-elsewhere",
          postId: "post-other",
          authorPersonId: BO.id,
          body: "Där.",
          createdAt: NOW,
        }),
      ],
    });

    const page = await service.page(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
    );

    expect(page.comments.map((comment) => comment.id)).toEqual([
      "comment-here",
    ]);
  });

  it("refuses the thread of a post the reader may not read, as one that does not exist", async () => {
    const { service, prisma } = group({
      comments: commentsOverHours(2, BO.id),
    });
    const outsider = principal(OUTSIDER.id, [
      "chat:participate",
      "chat:moderate",
    ]);

    const notIn = await service
      .page(outsider, POST_ID)
      .catch((error: unknown) => error);
    const notThere = await service
      .page(outsider, "post-nothing")
      .catch((error: unknown) => error);

    expect(notIn).toBeInstanceOf(FeedError);
    expect((notIn as FeedError).reason).toBe("post-not-found");
    expect((notThere as FeedError).reason).toBe((notIn as FeedError).reason);
    expect((notThere as FeedError).status).toBe((notIn as FeedError).status);
    // Not one comment was read for somebody outside the group.
    expect(prisma.postComment.findMany).not.toHaveBeenCalled();
  });

  it("attributes each comment, and says how many like it and whether this reader does", async () => {
    const { service } = group({
      comments: [
        commentFixture({
          id: "comment-1",
          authorPersonId: BO.id,
          body: "Jag tar med en spade.",
          createdAt: NOW,
        }),
        commentFixture({
          id: "comment-2",
          authorPersonId: "person-erased",
          body: "Skrivet av nagon som ar borta.",
          createdAt: new Date(NOW.getTime() + 1),
        }),
      ],
      likes: [
        { commentId: "comment-1", personId: MEMBER.id },
        { commentId: "comment-1", personId: SEATED.id },
      ],
    });

    const page = await service.page(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
    );

    expect(page.comments[0]).toMatchObject({
      postId: POST_ID,
      author: { kind: "person", personId: BO.id, name: "Bo Ek" },
      likes: 2,
      liked: true,
    });
    expect(page.comments[1]?.author).toEqual({ kind: "unknown" });
    expect(page.comments[1]?.liked).toBe(false);
  });

  it("offers a comment for reporting to a reader who has not reported it, and not again to one who has", async () => {
    const { service } = group({
      comments: [
        commentFixture({
          id: "comment-1",
          authorPersonId: BO.id,
          body: "Jag tar med en spade.",
          createdAt: NOW,
        }),
      ],
      // The reader's own report, and nobody else's.
      commentReports: [{ commentId: "comment-1", reporterPersonId: MEMBER.id }],
    });

    const reporter = await service.page(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
    );
    const other = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      POST_ID,
    );

    expect(reporter.comments[0]?.mayReport).toBe(false);
    expect(other.comments[0]?.mayReport).toBe(true);
  });
});

describe("what has been written since a cursor", () => {
  it("delivers a thread forwards a page at a time, every comment exactly once, and says when more waits", async () => {
    /*
     * The thread a reader opened with its newest comment, and then more than a
     * page written under it: forwards from the cursor reaches every one, where
     * the newest page alone would leave the first of them behind a gap.
     */
    const total = COMMENTS_PER_PAGE * 2 + 3;
    const written = commentsOverHours(total, BO.id);
    const { service } = group({ comments: written });
    const reader = principal(MEMBER.id, ["chat:participate"]);
    const [first] = written;
    if (first === undefined) {
      throw new Error("The fixture wrote no comments.");
    }

    const opened = { createdAt: first.createdAt, id: first.id };
    const seen: string[] = [];
    const answers: boolean[] = [];
    let after = opened;
    for (;;) {
      const update = await service.since(reader, POST_ID, after);
      seen.push(...update.comments.map((comment) => comment.id));
      answers.push(update.more);
      const cursor = parseFeedCursor(update.cursor);
      if (cursor === null) {
        throw new Error("The update carried no cursor.");
      }
      after = cursor;
      if (!update.more) {
        break;
      }
    }

    expect(seen).toEqual(written.slice(1).map((comment) => comment.id));
    expect(answers).toEqual([true, true, false]);
  });

  it("breaks a tie on the instant by identifier, so a comment sharing its cursor's millisecond is not lost", async () => {
    const instant = new Date(Date.UTC(2026, 0, 3));
    const { service } = group({
      comments: ["comment-b", "comment-a", "comment-c"].map((id) =>
        commentFixture({
          id,
          authorPersonId: BO.id,
          body: id,
          createdAt: instant,
        }),
      ),
    });

    const update = await service.since(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
      { createdAt: instant, id: "comment-a" },
    );

    expect(update.comments.map((comment) => comment.id)).toEqual([
      "comment-b",
      "comment-c",
    ]);
    expect(update.more).toBe(false);
  });

  it("hands the cursor back when nothing has arrived, so an idle thread keeps its place", async () => {
    const written = commentsOverHours(2, BO.id);
    const { service } = group({ comments: written });
    const last = written[1];
    if (last === undefined) {
      throw new Error("The fixture wrote no comments.");
    }

    const update = await service.since(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
      { createdAt: last.createdAt, id: last.id },
    );

    expect(update).toEqual({
      comments: [],
      cursor: `${last.createdAt.toISOString()}|${last.id}`,
      more: false,
    });
  });

  it("refuses the thread of a post the reader may not read, as one that does not exist", async () => {
    const { service, prisma } = group({
      comments: commentsOverHours(2, BO.id),
    });
    const outsider = principal(OUTSIDER.id, [
      "chat:participate",
      "chat:moderate",
    ]);
    const after = { createdAt: new Date(Date.UTC(2026, 0, 1)), id: "x" };

    const notIn = await service
      .since(outsider, POST_ID, after)
      .catch((error: unknown) => error);
    const notThere = await service
      .since(outsider, "post-nothing", after)
      .catch((error: unknown) => error);

    expect((notIn as FeedError).reason).toBe("post-not-found");
    expect((notThere as FeedError).reason).toBe((notIn as FeedError).reason);
    expect(prisma.postComment.findMany).not.toHaveBeenCalled();
  });

  it("withholds a struck comment's text on the rule a page does", async () => {
    const { service } = group({
      comments: [
        commentFixture({
          id: "comment-struck",
          authorPersonId: BO.id,
          body: "Det här strök styrelsen.",
          createdAt: NOW,
          struckAt: NOW,
        }),
      ],
    });

    const update = await service.since(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
      { createdAt: new Date(NOW.getTime() - 1), id: "x" },
    );

    expect(update.comments[0]).toMatchObject({
      id: "comment-struck",
      body: null,
      author: { kind: "person", personId: BO.id },
    });
  });
});

describe("writing a comment", () => {
  it("writes under the writer's own lock and answers the comment as its author sees it", async () => {
    const { service, comments, locks } = group();

    const written = await service.write(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
      "Jag tar med kaffe.",
    );

    expect(written).toMatchObject({
      postId: POST_ID,
      author: { kind: "person", personId: MEMBER.id, name: "Nils Lindqvist" },
      byBoard: false,
      body: "Jag tar med kaffe.",
      createdAt: NOW.toISOString(),
      struckAt: null,
      likes: 0,
      liked: false,
    });
    expect(comments).toHaveLength(1);
    // One key for posts and comments alike, so the budget is counted under the
    // lock whichever of the two somebody is writing - and then the thread's
    // own, which the stamp is taken under.
    expect(locks).toEqual([
      `feed-person:${MEMBER.id}`,
      `post-thread:${POST_ID}`,
    ]);
  });

  it("stamps a comment after the newest under its post when the clock has not moved past it", async () => {
    /*
     * A neighbour's comment committed a moment ago at an instant this server's
     * clock has not reached. Stamped with the clock, this one would sort behind
     * a comment a reader's poll has already delivered, and never be delivered.
     */
    const ahead = new Date(NOW.getTime() + 5);
    const { service } = group({
      comments: [
        commentFixture({
          id: "comment-ahead",
          authorPersonId: BO.id,
          body: "Före.",
          createdAt: ahead,
        }),
        // Under another post, which a thread's order knows nothing about.
        commentFixture({
          id: "comment-elsewhere",
          postId: "post-other",
          authorPersonId: BO.id,
          body: "Där.",
          createdAt: new Date(NOW.getTime() + 60_000),
        }),
      ],
    });

    const written = await service.write(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
      "Efter.",
    );

    expect(written.createdAt).toBe(new Date(ahead.getTime() + 1).toISOString());
  });

  it("comments on a news item's post in Alla for somebody who lives here", async () => {
    // A board post is a news item, and its comments are the news thread's.
    const { service, comments } = build({
      audiences: [ALL],
      posts: [
        {
          id: "post-news",
          audienceId: ALL_ID,
          authorPersonId: null,
          newsId: "news-water",
          commentsAllowed: true,
          struckAt: null,
          createdAt: new Date(Date.UTC(2026, 0, 1)),
        },
      ],
      news: [{ id: "news-water", published: true }],
      persons: [MEMBER],
    });

    await service.write(
      principal(MEMBER.id, ["chat:participate"]),
      "post-news",
      "Tack för beskedet.",
    );

    expect(comments.map((comment) => comment.postId)).toEqual(["post-news"]);
  });

  it("refuses a post the writer may not read exactly as one that does not exist, and writes nothing", async () => {
    const { service, commentCreate } = build({
      audiences: [ALL, GROUP],
      posts: [
        GROUP_POST,
        {
          id: "post-taken-down",
          audienceId: ALL_ID,
          authorPersonId: null,
          newsId: "news-down",
          commentsAllowed: true,
          struckAt: null,
          createdAt: new Date(Date.UTC(2026, 0, 1)),
        },
      ],
      news: [{ id: "news-down", published: false }],
      persons: [OUTSIDER],
    });
    const outsider = principal(OUTSIDER.id, ["chat:participate"]);

    const notIn = await service
      .write(outsider, POST_ID, "Hej.")
      .catch((error: unknown) => error);
    const notThere = await service
      .write(outsider, "post-nothing", "Hej.")
      .catch((error: unknown) => error);
    // A news item taken down takes its post out of the feed, and its thread.
    const takenDown = await service
      .write(outsider, "post-taken-down", "Hej.")
      .catch((error: unknown) => error);

    expect((notIn as FeedError).reason).toBe("post-not-found");
    expect((notThere as FeedError).reason).toBe("post-not-found");
    expect((takenDown as FeedError).reason).toBe("post-not-found");
    expect((notThere as FeedError).status).toBe((notIn as FeedError).status);
    expect(commentCreate).not.toHaveBeenCalled();
  });

  it("refuses a post whose comments are turned off", async () => {
    const { service, commentCreate } = group({
      posts: [{ ...GROUP_POST, commentsAllowed: false }],
    });

    const error = await service
      .write(principal(MEMBER.id, ["chat:participate"]), POST_ID, "Hej.")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FeedError);
    expect((error as FeedError).reason).toBe("comments-closed");
    // Its reader can see the thread is closed, so the refusal says so.
    expect((error as FeedError).status).toBe(422);
    expect(commentCreate).not.toHaveBeenCalled();
  });

  it("refuses a post the purge has erased, whose comments stand on their own clocks", async () => {
    const { service, commentCreate } = group({
      posts: [{ ...GROUP_POST, erasedAt: new Date("2026-03-04T03:47:00Z") }],
    });

    const error = await service
      .write(principal(MEMBER.id, ["chat:participate"]), POST_ID, "Hej.")
      .catch((thrown: unknown) => thrown);

    expect((error as FeedError).reason).toBe("post-erased");
    // Its reader sees the post is erased, so the refusal says so.
    expect((error as FeedError).status).toBe(422);
    expect(commentCreate).not.toHaveBeenCalled();
  });

  it("refuses a comment whose post the purge erased while it was on its way", async () => {
    /*
     * The check before the transaction found the post standing. What decides
     * is the read under the share lock inside it, after the writer's own lock:
     * without it the comment would land under a post whose author's part had
     * just gone.
     */
    const { service, commentCreate, locks } = group({ erasedInFlight: true });

    await expect(
      service.write(
        principal(MEMBER.id, ["chat:participate"]),
        POST_ID,
        "Hej.",
      ),
    ).rejects.toMatchObject({ reason: "post-erased" });
    expect(locks).toEqual([`feed-person:${MEMBER.id}`]);
    expect(commentCreate).not.toHaveBeenCalled();
  });

  it("refuses a post the board struck through", async () => {
    // What the board withheld is not a thing to answer in front of the others.
    const { service, commentCreate } = group({
      posts: [{ ...GROUP_POST, struckAt: new Date("2026-03-03T09:00:00Z") }],
    });

    await expect(
      service.write(
        principal(MEMBER.id, ["chat:participate"]),
        POST_ID,
        "Hej.",
      ),
    ).rejects.toMatchObject({ reason: "comments-closed" });
    expect(commentCreate).not.toHaveBeenCalled();
  });

  it("refuses in order: the post, a closed thread, the budget, then a personal identity number", async () => {
    /*
     * Each case below would also fail every later check, so a service that
     * asked them in another order would answer it with a different reason.
     */
    const atBudget = (authorPersonId: string) =>
      Array.from({ length: COMMENTS_PER_WRITE_WINDOW }, (_, index) =>
        commentFixture({
          id: `comment-${authorPersonId}-${String(index)}`,
          authorPersonId,
          body: "Svar.",
          createdAt: NOW,
        }),
      );
    const body = `Det ar ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}.`;
    const closed = group({
      posts: [{ ...GROUP_POST, commentsAllowed: false }],
      comments: [...atBudget(OUTSIDER.id), ...atBudget(MEMBER.id)],
    });
    const open = group({ comments: atBudget(MEMBER.id) });

    await expect(
      closed.service.write(
        principal(OUTSIDER.id, ["chat:participate"]),
        POST_ID,
        body,
      ),
    ).rejects.toMatchObject({ reason: "post-not-found" });
    await expect(
      closed.service.write(
        principal(MEMBER.id, ["chat:participate"]),
        POST_ID,
        body,
      ),
    ).rejects.toMatchObject({ reason: "comments-closed" });
    await expect(
      open.service.write(
        principal(MEMBER.id, ["chat:participate"]),
        POST_ID,
        body,
      ),
    ).rejects.toMatchObject({ reason: "too-many-comments" });
    await expect(
      open.service.write(principal(BO.id, ["chat:participate"]), POST_ID, body),
    ).rejects.toMatchObject({ reason: "personal-identity-number" });
    expect(closed.commentCreate).not.toHaveBeenCalled();
    expect(open.commentCreate).not.toHaveBeenCalled();
  });

  it("refuses the comment past the window budget, counted over the window and every post", async () => {
    const { service, commentCount } = group({
      posts: [GROUP_POST, { ...GROUP_POST, id: "post-other" }],
      comments: Array.from({ length: COMMENTS_PER_WRITE_WINDOW }, (_, index) =>
        commentFixture({
          id: `comment-${String(index)}`,
          postId: "post-other",
          authorPersonId: MEMBER.id,
          body: "Svar.",
          createdAt: NOW,
        }),
      ),
    });

    const error = await service
      .write(principal(MEMBER.id, ["chat:participate"]), POST_ID, "En till.")
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ reason: "too-many-comments" });
    expect((error as FeedError).status).toBe(429);

    /*
     * The window it asked for, and not only that it refused. And no post in
     * it: the budget is the person's, across every thread and both screens.
     */
    const asked = commentCount.mock.calls.at(-1)?.[0].where as
      | { authorPersonId?: string; postId?: string; createdAt?: { gte?: Date } }
      | undefined;
    expect(asked?.authorPersonId).toBe(MEMBER.id);
    expect(asked?.postId).toBeUndefined();
    const since = asked?.createdAt?.gte;
    expect(since).toBeInstanceOf(Date);
    expect(Date.now() - (since as Date).getTime()).toBe(
      COMMENT_WINDOW_MINUTES * 60 * 1000,
    );
  });

  it("counts only this person's comments, and only inside the window", async () => {
    const { service } = group({
      comments: [
        ...Array.from({ length: COMMENTS_PER_WRITE_WINDOW }, (_, index) =>
          commentFixture({
            id: `comment-else-${String(index)}`,
            authorPersonId: BO.id,
            body: "Svar.",
            createdAt: NOW,
          }),
        ),
        ...Array.from({ length: COMMENTS_PER_WRITE_WINDOW }, (_, index) =>
          commentFixture({
            id: `comment-old-${String(index)}`,
            authorPersonId: MEMBER.id,
            body: "Svar.",
            createdAt: new Date(
              NOW.getTime() - (COMMENT_WINDOW_MINUTES + 1) * 60 * 1000,
            ),
          }),
        ),
      ],
    });

    await expect(
      service.write(
        principal(MEMBER.id, ["chat:participate"]),
        POST_ID,
        "Min forsta.",
      ),
    ).resolves.toMatchObject({ body: "Min forsta." });
  });

  it("refuses a personal identity number, naming the offset and never the digits", async () => {
    const { service, commentCreate } = group();
    const body = `Det ar ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER} som star i registret.`;

    const error = await service
      .write(principal(MEMBER.id, ["chat:participate"]), POST_ID, body)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FeedError);
    expect((error as FeedError).reason).toBe("personal-identity-number");
    const details = (error as FeedError).details();
    expect(details.locations).toEqual([
      { part: "body", offset: body.indexOf("19811218") },
    ]);
    expect(
      JSON.stringify({ ...details, message: (error as Error).message }),
    ).not.toContain("19811218");
    expect(commentCreate).not.toHaveBeenCalled();
  });
});

describe("the budget on its own", () => {
  it("answers with the caller's own refusal when it is given one", async () => {
    /*
     * The news screen's thread writes into the same table under its own
     * published refusal, and one person has one budget whichever screen they
     * write from.
     */
    const { prisma } = group({
      comments: Array.from({ length: COMMENTS_PER_WRITE_WINDOW }, (_, index) =>
        commentFixture({
          id: `comment-${String(index)}`,
          authorPersonId: MEMBER.id,
          body: "Svar.",
          createdAt: NOW,
        }),
      ),
    });
    const refusal = new Error("The news thread's own refusal.");

    await expect(
      refuseTooManyComments(
        prisma as unknown as PrismaService,
        MEMBER.id,
        () => refusal,
      ),
    ).rejects.toBe(refusal);
    await expect(
      refuseTooManyComments(prisma as unknown as PrismaService, BO.id),
    ).resolves.toBeUndefined();
  });
});

describe("liking a comment", () => {
  function thread() {
    return group({
      comments: [
        commentFixture({
          id: "comment-1",
          authorPersonId: BO.id,
          body: "Jag tar med en spade.",
          createdAt: NOW,
        }),
      ],
      likes: [{ commentId: "comment-1", personId: SEATED.id }],
    });
  }

  it("likes once however many times it is asked, and counts everybody's", async () => {
    const { service, likes } = thread();
    const reader = principal(MEMBER.id, ["chat:participate"]);

    const first = await service.like(reader, "comment-1", true);
    const second = await service.like(reader, "comment-1", true);

    expect(first).toEqual({ liked: true, likes: 2 });
    expect(second).toEqual({ liked: true, likes: 2 });
    expect(likes.filter((like) => like.personId === MEMBER.id)).toHaveLength(1);
  });

  it("takes the like back, and taking it back twice is taking it back once", async () => {
    const { service, likes } = thread();
    const reader = principal(MEMBER.id, ["chat:participate"]);

    await service.like(reader, "comment-1", true);
    const first = await service.like(reader, "comment-1", false);
    const second = await service.like(reader, "comment-1", false);

    expect(first).toEqual({ liked: false, likes: 1 });
    expect(second).toEqual({ liked: false, likes: 1 });
    expect(likes).toEqual([{ commentId: "comment-1", personId: SEATED.id }]);
  });

  it("answers a comment under a post the reader may not read exactly as one that does not exist", async () => {
    /*
     * A comment's identifier is a way into its post's audience, and the answer
     * has to be the same whether the comment is there or not - or liking would
     * tell an outsider which identifiers are lines in a group.
     */
    const { service, likes } = thread();
    const outsider = principal(OUTSIDER.id, ["chat:participate"]);

    const notIn = await service
      .like(outsider, "comment-1", true)
      .catch((error: unknown) => error);
    const notThere = await service
      .like(outsider, "comment-nothing", true)
      .catch((error: unknown) => error);

    expect(notIn).toBeInstanceOf(FeedError);
    expect((notIn as FeedError).reason).toBe("comment-not-found");
    expect((notThere as FeedError).reason).toBe((notIn as FeedError).reason);
    expect((notThere as FeedError).status).toBe((notIn as FeedError).status);
    expect((notIn as FeedError).status).toBe(404);
    expect(likes).toEqual([{ commentId: "comment-1", personId: SEATED.id }]);
  });
});

describe("a comment the board struck through", () => {
  const STRUCK_AT = new Date("2026-03-03T09:00:00.000Z");

  function struck() {
    return group({
      comments: [
        commentFixture({
          id: "comment-1",
          authorPersonId: BO.id,
          body: "Det har borde ingen lasa.",
          struckAt: STRUCK_AT,
          createdAt: NOW,
        }),
      ],
    });
  }

  it("withholds the text from the others and keeps the attribution", async () => {
    const { service } = struck();

    const page = await service.page(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
    );

    // A strike is a strike-through and never a disappearance.
    expect(page.comments[0]?.body).toBeNull();
    expect(page.comments[0]?.struckAt).toBe(STRUCK_AT.toISOString());
    expect(page.comments[0]?.author).toMatchObject({ name: "Bo Ek" });
  });

  it("shows the text to whoever wrote it", async () => {
    const { service } = struck();

    const page = await service.page(
      principal(BO.id, ["chat:participate"]),
      POST_ID,
    );

    expect(page.comments[0]?.body).toBe("Det har borde ingen lasa.");
  });

  it("shows the text to a board member who moderates", async () => {
    const { service } = struck();

    const page = await service.page(
      principal(SEATED.id, ["chat:participate", "chat:moderate"]),
      POST_ID,
    );

    expect(page.comments[0]?.body).toBe("Det har borde ingen lasa.");
  });

  it("withholds the text from the capability without a seat", async () => {
    // An administrator holds every capability, and one who lives here and is
    // in the group is not the board (ADR 0012).
    const { service } = struck();

    const page = await service.page(
      principal(MEMBER.id, ["chat:participate", "chat:moderate"]),
      POST_ID,
    );

    expect(page.comments[0]?.body).toBeNull();
  });

  it("withholds the text from a seat without the capability", async () => {
    const { service } = struck();

    const page = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      POST_ID,
    );

    expect(page.comments[0]?.body).toBeNull();
  });
});

describe("editing a comment", () => {
  const WRITTEN = new Date(Date.UTC(2026, 0, 2));

  function one(fields: Partial<CommentFixture> = {}) {
    return group({
      comments: [
        commentFixture({
          id: "comment-1",
          authorPersonId: BO.id,
          body: "Jag tar med kaffe.",
          createdAt: WRITTEN,
          ...fields,
        }),
      ],
    });
  }

  it("keeps the text that stood, and says the comment was edited", async () => {
    const { service, revisions } = one();

    const edited = await service.edit(
      principal(BO.id, ["chat:participate"]),
      "comment-1",
      "Jag tar med kaffe och bullar.",
    );

    expect(edited.body).toBe("Jag tar med kaffe och bullar.");
    expect(edited.editedAt).toBe(NOW.toISOString());
    expect(edited.mayReadHistory).toBe(true);
    expect(revisions).toEqual([
      {
        commentId: "comment-1",
        body: "Jag tar med kaffe.",
        writtenAt: WRITTEN,
        replacedAt: NOW,
      },
    ]);
  });

  it("offers the edit to its writer, and not on a struck comment", async () => {
    const standing = await one().service.page(
      principal(BO.id, ["chat:participate"]),
      POST_ID,
    );
    const others = await one().service.page(
      principal(MEMBER.id, ["chat:participate"]),
      POST_ID,
    );
    const struck = await one({ struckAt: NOW }).service.page(
      principal(BO.id, ["chat:participate"]),
      POST_ID,
    );

    expect(standing.comments[0]?.mayEdit).toBe(true);
    expect(others.comments[0]?.mayEdit).toBe(false);
    expect(struck.comments[0]?.mayEdit).toBe(false);
  });

  it("is refused to anybody but its writer, and on a struck comment", async () => {
    await expect(
      one().service.edit(
        principal(SEATED.id, ["chat:participate", "chat:moderate"]),
        "comment-1",
        "Något annat.",
      ),
    ).rejects.toMatchObject({ reason: "not-editable" });
    await expect(
      one({ struckAt: NOW }).service.edit(
        principal(BO.id, ["chat:participate"]),
        "comment-1",
        "Något annat.",
      ),
    ).rejects.toMatchObject({ reason: "not-editable" });
  });

  it("is refused as a comment that does not exist to somebody outside the group", async () => {
    await expect(
      one().service.edit(
        principal(OUTSIDER.id, ["chat:participate", "chat:moderate"]),
        "comment-1",
        "Något annat.",
      ),
    ).rejects.toMatchObject({ reason: "comment-not-found" });
  });

  it("refuses a personal identity number before anything is written", async () => {
    const { service, revisions } = one();

    await expect(
      service.edit(
        principal(BO.id, ["chat:participate"]),
        "comment-1",
        `Ring ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}`,
      ),
    ).rejects.toMatchObject({ reason: "personal-identity-number" });
    expect(revisions).toEqual([]);
  });

  it("shows the history to the writer and the board, and withholds it from a neighbour", async () => {
    const { service } = one();
    await service.edit(
      principal(BO.id, ["chat:participate"]),
      "comment-1",
      "Jag tar med te.",
    );

    const writer = await service.history(
      principal(BO.id, ["chat:participate"]),
      "comment-1",
    );
    const board = await service.history(
      principal(SEATED.id, ["chat:participate", "chat:moderate"]),
      "comment-1",
    );

    expect(writer.revisions).toEqual([
      {
        body: "Jag tar med kaffe.",
        writtenAt: WRITTEN.toISOString(),
        replacedAt: NOW.toISOString(),
      },
    ]);
    expect(board).toEqual(writer);
    await expect(
      service.history(principal(MEMBER.id, ["chat:participate"]), "comment-1"),
    ).rejects.toMatchObject({ reason: "history-withheld" });
  });
});
