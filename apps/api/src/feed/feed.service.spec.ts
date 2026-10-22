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
import type { MediaService } from "../media/media.service";
import { paragraphsContent } from "../site/page-content";
import {
  ATTACHABLE_HOURS,
  MAX_IMAGES_PER_POST,
  UPLOADS_PER_DAY,
} from "./feed-image";
import { feedCursor, parseFeedCursor } from "./feed-cursor";
import { FeedError, refusePersonalIdentityNumbers } from "./feed.error";
import { MAX_REVISIONS } from "./feed-revision";
import {
  type FeedQuery,
  FeedService,
  POST_MAX_LENGTH,
  POSTS_PER_PAGE,
  POSTS_PER_WRITE_WINDOW,
  WRITE_WINDOW_MINUTES,
} from "./feed.service";

/**
 * The rules the feed lives under, decided before any row is written.
 *
 * Every one of them is a rule a database cannot be asked about.
 *
 * **Membership is the security boundary, and it is derived.** Alla is whoever
 * lives here and whoever holds a board seat, Styrelsen is whoever holds a seat,
 * and a group is whoever is written into it and still lives here. A person
 * holding the capability, no seat and no residency is in no audience, a seat
 * that ended takes Styrelsen away on the next call, and a seat ending in the
 * future keeps it - the half of the predicate that a clause testing only for a
 * null end date would drop, and the half that costs somebody elected last week
 * their place in Styrelsen. Asserted against the clock the call takes rather
 * than against a stored flag, because that is what the service actually asks.
 *
 * **One refusal for two cases.** An audience that does not exist and an audience
 * this person is not in answer identically, down to the reason code, and so do
 * a post that does not exist and a post in an audience this person is not in -
 * or the identifier space can be walked to learn what groups the house has made
 * and what is said in them. A list, a search and a filter run inside the
 * reader's own audiences, and a search never matches text withheld from them.
 *
 * **A page is cut from the newest end and a cursor survives the row it names.**
 * Asserted by walking a whole audience backwards and insisting every post came
 * back exactly once - including the case where every post shares an instant,
 * which is the case a cursor on the instant alone gets wrong - and then by
 * deleting the row a cursor points at and reading the next page anyway.
 *
 * **The poll is the mirror of the page and is bounded.** A screen closed for a
 * week must not ask for a week of posts in one response, so the answer carries
 * a page, a cursor and the flag that says to ask again at once.
 *
 * **The write budget is per person and counted from the table.** The window it
 * asks for is asserted, not only the refusal, because a count over the wrong
 * window refuses and permits exactly when a correct one would in a fixture of
 * one.
 *
 * **The personal identity number scan names positions and never the value.**
 * What the scan caught is exactly what must not travel back into a response
 * body, a log, or a screen somebody else is looking at.
 *
 * **The read marker never moves backwards**, so two tabs cannot un-read each
 * other, and a person's own posts are never unread to them. **A post's read
 * record is written once** and never for its own author.
 *
 * The clock is the test's own, so "now" is one instant every assertion can
 * name: a post whose instant has not come is in nobody's feed, and a test about
 * that has to be able to say when now is.
 *
 * What the database itself does with these rows is `feed.int-spec.ts`.
 */

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

const ALL_ID = "audience-all";
const BOARD_ID = "audience-board";
const GROUP_ID = "audience-garden";
const ADMIN_ID = "audience-admin";
const NOW = new Date("2026-09-17T09:00:00.000Z");

interface AudienceFixture {
  id: string;
  kind: "ALL" | "BOARD" | "GROUP" | "ADMIN";
  name: string | null;
  createdByPersonId: string | null;
}

interface PostFixture {
  id: string;
  audienceId: string;
  authorPersonId: string | null;
  byBoard: boolean;
  namesAuthor: boolean;
  body: string | null;
  newsId: string | null;
  important: boolean;
  pinnedAt: Date | null;
  commentsAllowed: boolean;
  scheduledAt: Date | null;
  createdAt: Date;
  editedAt: Date | null;
  struckAt: Date | null;
  erasedAt: Date | null;
  issueId: string | null;
}

/** An issue report made from a post, as far as the feed reads it. */
interface IssueFixture {
  id: string;
  status: "NEW" | "IN_PROGRESS" | "DONE";
  reporterPersonId: string | null;
}

/** An earlier version of a post, kept when its author edited it. */
interface RevisionFixture {
  postId: string;
  body: string;
  writtenAt: Date;
  replacedAt: Date;
}

/** The news item a board post is, as far as the feed reads it. */
interface NewsFixture {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  /** The stored body, as the news module writes it. None when left out. */
  content?: unknown;
}

interface PersonFixture {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
  /**
   * When this person's board term ended, or null while they still hold it.
   *
   * `undefined` is somebody who has never been on the board at all, which is a
   * third case rather than a spelling of the second: a person with no row is who
   * the membership query has to answer "no" for.
   */
  seatEndedOn?: Date | null;
  /**
   * When this person's residency ended, or null while they still live here.
   *
   * `undefined` is somebody who has never lived here at all, which is the third
   * case again: an external board member holds a seat and no residency, and is
   * in Alla and Styrelsen and in no group.
   */
  movedOutOn?: Date | null;
  /**
   * Whether this person holds the administrator system role, which is what
   * puts somebody without a seat into Administratörer.
   */
  administrator?: boolean;
}

/** A stored file, as far as attaching one to a post reads it. */
interface FileFixture {
  id: string;
  visibility: "POST" | "INTERNAL" | "PUBLIC";
  uploadedByPersonId: string | null;
  createdAt: Date;
  width: number | null;
  height: number | null;
}

/** An image on a post: which file, on which post, where among its images. */
interface PostImageFixture {
  postId: string;
  fileId: string;
  sortOrder: number;
}

/** A post with every column the feed reads, the ones a test does not name at their defaults. */
function postFixture(
  fields: Pick<
    PostFixture,
    "id" | "audienceId" | "authorPersonId" | "body" | "createdAt"
  > &
    Partial<PostFixture>,
): PostFixture {
  return {
    byBoard: false,
    namesAuthor: true,
    newsId: null,
    important: false,
    pinnedAt: null,
    commentsAllowed: true,
    scheduledAt: null,
    editedAt: null,
    struckAt: null,
    erasedAt: null,
    issueId: null,
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
 * let the service drop exactly that condition - the audience, the instant a
 * post is shown from, the strike a search must not see through - and every test
 * here would still pass.
 *
 * A comparison with a null is never true, as it is not in SQL. That is the half
 * that makes the unread count's own spelling of "not this person" testable: a
 * filter that forgot a board post may name nobody would drop it here exactly as
 * the database drops it.
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
      // A relation, filtered through: absent is no match, as `is` reads it.
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
    const operators = condition as Record<string, unknown>;
    return Object.entries(operators).every(([operator, operand]) => {
      switch (operator) {
        case "in":
          return (operand as unknown[]).includes(value);
        case "not":
          return operand === null
            ? value !== null
            : value !== null && value !== operand;
        case "lt":
          return value !== null && compare(value, operand) < 0;
        case "lte":
          return value !== null && compare(value, operand) <= 0;
        case "gt":
          return value !== null && compare(value, operand) > 0;
        case "gte":
          return value !== null && compare(value, operand) >= 0;
        case "contains": {
          if (typeof value !== "string" || typeof operand !== "string") {
            return false;
          }
          return operators.mode === "insensitive"
            ? value.toLowerCase().includes(operand.toLowerCase())
            : value.includes(operand);
        }
        case "mode":
          // A modifier of `contains`, read there.
          return true;
        default:
          throw new Error(`The fake does not answer ${key}.${operator}.`);
      }
    });
  });
}

/** How the service orders posts: column by column, as the query lists them. */
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

/**
 * Whether this person's seat satisfies the clause, at the clock it carries.
 *
 * Implemented rather than stubbed, because the two halves of the predicate are
 * exactly what the tests below are about: a service asking only for a null end
 * date would pass every assertion a stub made true.
 */
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

/**
 * A principal whose flags say nothing true about anybody. The feed asks the
 * register who lives here and who holds a seat, and a test whose principal
 * carried the right flags could not tell a service that read them from one that
 * asked.
 */
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

/** A read of the whole feed with nothing narrowing it, and what a test narrows. */
function query(narrowed: Partial<FeedQuery> = {}): FeedQuery {
  return {
    audienceId: null,
    search: null,
    from: null,
    important: false,
    ...narrowed,
  };
}

/**
 * A database holding these audiences, posts, people and read records.
 *
 * Every query is implemented rather than stubbed with an answer, because what is
 * under test is what the service asks of it. A `count` that ignored its `where`
 * would let the budget test pass whatever window the service asked for, and a
 * `findMany` that ignored its audience would let a read return another
 * audience's posts and still look right.
 */
function build(options: {
  audiences?: AudienceFixture[];
  posts?: PostFixture[];
  news?: NewsFixture[];
  persons?: PersonFixture[];
  reads?: { audienceId: string; personId: string; readAt: Date }[];
  postReads?: { postId: string; personId: string; readAt: Date }[];
  likes?: { postId: string; personId: string }[];
  /** Who has reported which post to the board. */
  postReports?: { postId: string; reporterPersonId: string }[];
  comments?: { postId: string }[];
  groupMembers?: { audienceId: string; personId: string }[];
  files?: FileFixture[];
  postImages?: PostImageFixture[];
  issues?: IssueFixture[];
  revisions?: RevisionFixture[];
  /** Erase every audience the moment a write takes an audience's lock. */
  sweptOnLock?: boolean;
}) {
  const files = [...(options.files ?? [])];
  const issues = options.issues ?? [];
  const revisions = [...(options.revisions ?? [])];
  const postImages = [...(options.postImages ?? [])];
  const audiences = [...(options.audiences ?? [])];
  const posts = [...(options.posts ?? [])];
  const news = options.news ?? [];
  const persons = options.persons ?? [];
  const reads = [...(options.reads ?? [])];
  const postReads = [...(options.postReads ?? [])];
  const likes = [...(options.likes ?? [])];
  const postReports = options.postReports ?? [];
  const comments = options.comments ?? [];
  const groupMembers = (options.groupMembers ?? []).map((member, index) => ({
    ...member,
    joinedAt: new Date(Date.UTC(2026, 0, 1, index)),
  }));

  /** The one relation a post is filtered through: the news item it is. */
  function related(relation: string, row: object): object | null {
    if (relation !== "news") {
      throw new Error(`The fake has no relation ${relation}.`);
    }
    const { newsId } = row as PostFixture;
    return news.find((item) => item.id === newsId) ?? null;
  }

  function matching(where: Where): PostFixture[] {
    return posts.filter((row) => matches(row, where, related));
  }

  /**
   * A post as the service selects it: the row, its audience and news item, its
   * counts, and the reader's own like and nobody else's.
   */
  function shaped(
    row: PostFixture,
    select?: {
      likes?: { where: { personId: string } };
      reports?: { where: { reporterPersonId: string } };
    },
  ) {
    const item = news.find((each) => each.id === row.newsId);
    return {
      ...row,
      issue: issues.find((issue) => issue.id === row.issueId) ?? null,
      audience: audiences.find((audience) => audience.id === row.audienceId),
      news:
        item === undefined
          ? null
          : {
              id: item.id,
              slug: item.slug,
              title: item.title,
              content: item.content ?? null,
            },
      _count: {
        likes: likes.filter((like) => like.postId === row.id).length,
        comments: comments.filter((comment) => comment.postId === row.id)
          .length,
        reads: postReads.filter((read) => read.postId === row.id).length,
      },
      likes: likes
        .filter(
          (like) =>
            like.postId === row.id &&
            like.personId === select?.likes?.where.personId,
        )
        .map((like) => ({ personId: like.personId })),
      // The reader's own report, and nobody else's.
      reports: postReports
        .filter(
          (report) =>
            report.postId === row.id &&
            report.reporterPersonId === select?.reports?.where.reporterPersonId,
        )
        .map((report) => ({ id: `report-${report.postId}` })),
      images: postImages
        .filter((image) => image.postId === row.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((image) => {
          const file = files.find((each) => each.id === image.fileId);
          return {
            file: {
              id: image.fileId,
              width: file?.width ?? null,
              height: file?.height ?? null,
            },
          };
        }),
    };
  }

  const postCreate = vi.fn(
    async (args: {
      data: {
        audienceId: string;
        authorPersonId: string;
        body: string;
        createdAt: Date;
      };
    }) => {
      const row = postFixture({
        id: `post-${String(posts.length + 1).padStart(3, "0")}-new`,
        audienceId: args.data.audienceId,
        authorPersonId: args.data.authorPersonId,
        body: args.data.body,
        createdAt: args.data.createdAt,
      });
      posts.push(row);
      return { id: row.id };
    },
  );

  const postCount = vi.fn(async (args: { where: Where }) => {
    return matching(args.where).length;
  });

  /** Every advisory lock key a call took, in order. */
  const locks: string[] = [];

  /*
   * The question a write asks of its images, answered column by column and
   * refusing a condition it does not know: a fake that ignored the uploader or
   * the age would let a service that forgot either pass.
   */
  const mediaFileCount = vi.fn(
    async (args: {
      where: {
        id?: { in: string[] };
        visibility: string;
        uploadedByPersonId: string;
        postImage?: null;
        createdAt: { gte: Date };
      };
    }) => {
      const known = [
        "id",
        "visibility",
        "uploadedByPersonId",
        "postImage",
        "createdAt",
      ];
      for (const key of Object.keys(args.where)) {
        if (!known.includes(key)) {
          throw new Error(`The fake does not answer mediaFile.${key}.`);
        }
      }
      const { where } = args;
      return files.filter(
        (file) =>
          (where.id === undefined || where.id.in.includes(file.id)) &&
          file.visibility === where.visibility &&
          file.uploadedByPersonId === where.uploadedByPersonId &&
          (!("postImage" in where) ||
            !postImages.some((image) => image.fileId === file.id)) &&
          file.createdAt.getTime() >= where.createdAt.gte.getTime(),
      ).length;
    },
  );

  const postImageCreateMany = vi.fn(
    async (args: { data: PostImageFixture[] }) => {
      postImages.push(...args.data);
      return { count: args.data.length };
    },
  );

  /** The media layer, as far as an upload for a post reaches it. */
  const media = {
    upload: vi.fn(
      async (input: {
        visibility: string;
        uploadedByPersonId: string;
        showsIdentifiablePersons: boolean;
      }) => {
        const id = `file-${String(files.length + 1)}`;
        files.push({
          id,
          visibility: input.visibility as FileFixture["visibility"],
          uploadedByPersonId: input.uploadedByPersonId,
          createdAt: new Date(),
          width: 640,
          height: 480,
        });
        return { id, url: `/api/media/${id}`, width: 640, height: 480 };
      },
    ),
  };

  const prisma = {
    mediaFile: { count: mediaFileCount },
    postImage: { createMany: postImageCreateMany },
    audience: {
      findFirst: vi.fn(
        async (args: { where: { kind: AudienceFixture["kind"] } }) =>
          audiences.find((audience) => audience.kind === args.where.kind) ??
          null,
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          audiences.find((audience) => audience.id === args.where.id) ?? null,
      ),
    },
    post: {
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
          const rows = matching(args.where).sort(byOrder(args.orderBy));
          return (
            args.take === undefined ? rows : rows.slice(0, args.take)
          ).map((row) => shaped(row, args.select));
        },
      ),
      findFirst: vi.fn(
        async (args: {
          where: Where;
          orderBy?: OrderBy;
          select?: {
            likes?: { where: { personId: string } };
            reports?: { where: { reporterPersonId: string } };
          };
        }) => {
          const [row] = matching(args.where).sort(byOrder(args.orderBy ?? []));
          return row === undefined ? null : shaped(row, args.select);
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
          const row = posts.find((each) => each.id === args.where.id);
          return row === undefined ? null : shaped(row, args.select);
        },
      ),
      count: postCount,
      create: postCreate,
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: { body: string; editedAt: Date };
        }) => {
          const row = posts.find((each) => each.id === args.where.id);
          if (row === undefined) {
            throw new Error(`No post ${args.where.id}.`);
          }
          Object.assign(row, args.data);
          return row;
        },
      ),
    },
    postRevision: {
      count: vi.fn(
        async (args: { where: { postId: string } }) =>
          revisions.filter((each) => each.postId === args.where.postId).length,
      ),
      create: vi.fn(async (args: { data: RevisionFixture }) => {
        revisions.push(args.data);
        return args.data;
      }),
      findMany: vi.fn(async (args: { where: { postId: string } }) =>
        revisions
          .filter((each) => each.postId === args.where.postId)
          .sort((a, b) => b.replacedAt.getTime() - a.replacedAt.getTime()),
      ),
    },
    audienceRead: {
      findUnique: vi.fn(
        async (args: {
          where: {
            audienceId_personId: { audienceId: string; personId: string };
          };
        }) =>
          reads.find(
            (row) =>
              row.audienceId === args.where.audienceId_personId.audienceId &&
              row.personId === args.where.audienceId_personId.personId,
          ) ?? null,
      ),
    },
    postRead: {
      count: vi.fn(
        async (args: { where: { postId: string } }) =>
          postReads.filter((read) => read.postId === args.where.postId).length,
      ),
    },
    postLike: {
      count: vi.fn(
        async (args: { where: { postId: string } }) =>
          likes.filter((like) => like.postId === args.where.postId).length,
      ),
      deleteMany: vi.fn(
        async (args: { where: { postId: string; personId: string } }) => {
          const before = likes.length;
          for (let index = likes.length - 1; index >= 0; index -= 1) {
            const like = likes[index];
            if (
              like?.postId === args.where.postId &&
              like.personId === args.where.personId
            ) {
              likes.splice(index, 1);
            }
          }
          return { count: before - likes.length };
        },
      ),
    },
    /*
     * The two halves of a group's membership, implemented rather than stubbed:
     * the row that says somebody was written down, and the residency that says
     * they still live here. A fake that answered the first alone would let a
     * service that never asked the second pass every test below.
     */
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
      findMany: vi.fn(async (args: { where: { personId: string } }) =>
        groupMembers
          .filter((member) => member.personId === args.where.personId)
          .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
          .map((member) => ({
            audience: audiences.find(
              (audience) => audience.id === member.audienceId,
            ),
          })),
      ),
    },
    /** The administrator grant, the half of Administratörer a seat is not. */
    systemRole: {
      findUnique: vi.fn(
        async (args: {
          where: { personId_role: { personId: string; role: "ADMIN" } };
        }) =>
          persons.some(
            (person) =>
              person.id === args.where.personId_role.personId &&
              person.administrator === true,
          )
            ? { id: `role-${args.where.personId_role.personId}` }
            : null,
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
    /*
     * The statements the service writes in SQL, each implemented as the one
     * statement it is: the marker that never moves backwards, the read record
     * and the like that are written once, and the derived audience created only
     * if it is absent. The comparison is the whole of what those tests are
     * about, and a fake that merely recorded the call would let a service
     * overwriting the row unconditionally pass.
     */
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("pg_advisory_xact_lock")) {
          /*
           * A lock a write takes. Recorded rather than implemented: what one
           * process waits for is not something a fake in one process can show,
           * and `group.int-spec.ts` is where the write and the sweep meet a real
           * database.
           */
          const key = String(values[0]);
          locks.push(key);
          /*
           * The sweep, committing while this write waited for the audience's
           * lock. It is the only moment the group can go: membership was
           * decided before the lock and the insert comes after it.
           */
          if (options.sweptOnLock === true && key.startsWith("audience:")) {
            audiences.length = 0;
          }
          return 1;
        }
        const table = /INSERT INTO "(\w+)"/.exec(sql)?.[1];
        switch (table) {
          case "audience": {
            // ON CONFLICT DO NOTHING against the partial unique index.
            const kind = values[0] as AudienceFixture["kind"];
            if (audiences.some((audience) => audience.kind === kind)) {
              return 0;
            }
            audiences.push({
              id: `audience-${String(audiences.length + 1)}`,
              kind,
              name: null,
              createdByPersonId: null,
            });
            return 1;
          }
          case "audience_read": {
            const [audienceId, personId, readAt] = values as [
              string,
              string,
              Date,
            ];
            const standing = reads.find(
              (row) =>
                row.audienceId === audienceId && row.personId === personId,
            );
            if (standing === undefined) {
              reads.push({ audienceId, personId, readAt });
              return 1;
            }
            if (readAt.getTime() > standing.readAt.getTime()) {
              standing.readAt = readAt;
            }
            return 1;
          }
          case "post_read": {
            /*
             * Selected from the post rather than given as values, so the post
             * is read in the same statement: an erased one inserts nothing.
             */
            const [personId, readAt, postId] = values as [string, Date, string];
            if (
              !sql.includes('"erasedAt" IS NULL') ||
              posts.find((post) => post.id === postId)?.erasedAt !== null
            ) {
              return 0;
            }
            if (
              postReads.some(
                (read) => read.postId === postId && read.personId === personId,
              )
            ) {
              return 0;
            }
            postReads.push({ postId, personId, readAt });
            return 1;
          }
          case "post_like": {
            const [postId, personId] = values as [string, string];
            if (
              likes.some(
                (like) => like.postId === postId && like.personId === personId,
              )
            ) {
              return 0;
            }
            likes.push({ postId, personId });
            return 1;
          }
          default:
            throw new Error(`The fake does not answer: ${sql}`);
        }
      },
    ),
    /*
     * The post's row read under a share lock, before a like is written, and
     * under its own lock before an edit.
     */
    $queryRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        const post = posts.find((each) => each.id === values[0]);
        if (sql.includes("FOR UPDATE")) {
          return post === undefined ? [] : [{ ...post }];
        }
        if (!sql.includes("FOR SHARE")) {
          throw new Error(`The fake does not answer: ${sql}`);
        }
        return post === undefined
          ? []
          : [
              {
                struckAt: post.struckAt,
                commentsAllowed: post.commentsAllowed,
                erasedAt: post.erasedAt,
              },
            ];
      },
    ),
  };

  Object.assign(prisma, {
    /*
     * The transaction a write runs in, which exists here so the locks inside it
     * are taken at all. One client either way: what a transaction guarantees is
     * a property of the database, and every test in this file is about what the
     * service asks rather than about what the database promises.
     */
    $transaction: vi.fn(async (work: (tx: typeof prisma) => Promise<unknown>) =>
      work(prisma),
    ),
  });

  return {
    service: new FeedService(
      prisma as unknown as PrismaService,
      media as unknown as MediaService,
    ),
    prisma,
    media,
    files,
    postImages,
    postImageCreateMany,
    audiences,
    posts,
    reads,
    postReads,
    likes,
    groupMembers,
    revisions,
    locks,
    postCount,
    postCreate,
  };
}

/** The house: everybody who lives here and everybody holding a seat. */
const ALL: AudienceFixture = {
  id: ALL_ID,
  kind: "ALL",
  name: null,
  createdByPersonId: null,
};

/** Styrelsen, which most tests read because its membership is one seat. */
const BOARD: AudienceFixture = {
  id: BOARD_ID,
  kind: "BOARD",
  name: null,
  createdByPersonId: null,
};

/** Administratörer: the instance's administrators, and the board. */
const ADMINS: AudienceFixture = {
  id: ADMIN_ID,
  kind: "ADMIN",
  name: null,
  createdByPersonId: null,
};

/** A group, made by the resident who wanted it. */
const GROUP: AudienceFixture = {
  id: GROUP_ID,
  kind: "GROUP",
  name: "Trädgårdsgruppen",
  createdByPersonId: "person-nils",
};

/** Holds a seat and lives here: in Alla, in Styrelsen, and in any group they are written into. */
const SEATED: PersonFixture = {
  id: "person-astrid",
  firstName: "Astrid",
  lastName: "Lindqvist",
  protectedPersonalData: false,
  seatEndedOn: null,
  movedOutOn: null,
};

/**
 * Holds no seat and lives nowhere: the administrator's case. They hold every
 * capability and are in no audience.
 */
const NO_SEAT: PersonFixture = {
  id: "person-ingrid",
  firstName: "Ingrid",
  lastName: "Holm",
  protectedPersonalData: false,
};

/**
 * Lives here and holds no seat: in Alla, and in the groups they are written
 * into. A person of their own rather than the administrator with a residency
 * added, so a test holding both cannot have one answer for the other.
 */
const RESIDENT: PersonFixture = {
  id: "person-nils",
  firstName: "Nils",
  lastName: "Lindqvist",
  protectedPersonalData: false,
  movedOutOn: null,
};

/** An audience with `count` posts, one an hour, oldest first. */
function postsOverHours(
  count: number,
  authorPersonId: string,
  audienceId: string = BOARD_ID,
): PostFixture[] {
  return Array.from({ length: count }, (_, index) =>
    postFixture({
      id: `post-${String(index + 1).padStart(3, "0")}`,
      audienceId,
      authorPersonId,
      body: `Rad ${String(index + 1)}.`,
      createdAt: new Date(Date.UTC(2026, 0, 1, index)),
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("who is in which audience", () => {
  it("offers Alla, Styrelsen and Administratörer to somebody holding a seat", async () => {
    const { service } = build({
      audiences: [ALL, BOARD, ADMINS],
      persons: [SEATED],
    });

    const answer = await service.audiences(
      principal(SEATED.id, ["chat:participate"]),
    );

    // Alla first because it is the house, then Styrelsen, then Administratörer,
    // which the board is in because it writes there.
    expect(answer.audiences.map((audience) => audience.id)).toEqual([
      ALL_ID,
      BOARD_ID,
      ADMIN_ID,
    ]);
    expect(answer.audiences.map((audience) => audience.kind)).toEqual([
      "ALL",
      "BOARD",
      "ADMIN",
    ]);
  });

  it("offers Alla to a seat holder who lives nowhere, and no group", async () => {
    /*
     * An external board member: in Alla because the board answers for what is
     * written there, and in no group, because a group is for the people who
     * live here - whatever the member list says.
     */
    const external: PersonFixture = {
      id: "person-extern",
      firstName: "Karin",
      lastName: "Berg",
      protectedPersonalData: false,
      seatEndedOn: null,
    };
    const { service } = build({
      audiences: [ALL, BOARD, ADMINS, GROUP],
      persons: [external],
      groupMembers: [{ audienceId: GROUP_ID, personId: external.id }],
    });

    const answer = await service.audiences(
      principal(external.id, ["chat:participate"]),
    );

    expect(answer.audiences.map((audience) => audience.kind)).toEqual([
      "ALL",
      "BOARD",
      "ADMIN",
    ]);
    expect(answer.mayCreateGroup).toBe(false);
  });

  it("offers Alla to somebody who lives here and holds no seat, and not Styrelsen or Administratörer", async () => {
    const { service } = build({
      audiences: [ALL, BOARD, ADMINS],
      persons: [RESIDENT],
    });

    const answer = await service.audiences(
      principal(RESIDENT.id, ["chat:participate"]),
    );

    expect(answer.audiences.map((audience) => audience.kind)).toEqual(["ALL"]);
  });

  it("offers nothing to somebody holding the capability, no seat and no residency", async () => {
    /*
     * The administrator's case, and the one the screen has to put into words.
     * They hold every capability, no seat and no residency, so they reach the
     * endpoint and find no audience - which is an answer rather than a fault.
     */
    const { service } = build({
      audiences: [ALL, BOARD, GROUP],
      persons: [NO_SEAT],
      groupMembers: [{ audienceId: GROUP_ID, personId: NO_SEAT.id }],
    });

    expect(
      (await service.audiences(principal(NO_SEAT.id, ["chat:participate"])))
        .audiences,
    ).toEqual([]);
  });

  it("offers the administrator Administratörer, and nothing else", async () => {
    /*
     * The grant puts them into the one audience written to them. It is not a
     * residency and not a seat, so Alla, Styrelsen and every group stay shut,
     * whatever a member list says.
     */
    const administrator: PersonFixture = { ...NO_SEAT, administrator: true };
    const { service } = build({
      audiences: [ALL, BOARD, ADMINS, GROUP],
      persons: [administrator],
      groupMembers: [{ audienceId: GROUP_ID, personId: administrator.id }],
    });

    const answer = await service.audiences(
      principal(administrator.id, ["chat:participate"]),
    );

    expect(answer.audiences.map((audience) => audience.id)).toEqual([ADMIN_ID]);
    expect(answer.mayCreateGroup).toBe(false);
  });

  it("creates Alla, Styrelsen and Administratörer on the first read by somebody holding a seat", async () => {
    const { service, audiences } = build({ persons: [SEATED] });

    const answer = await service.audiences(
      principal(SEATED.id, ["chat:participate"]),
    );

    expect(audiences.map((audience) => audience.kind)).toEqual([
      "ALL",
      "BOARD",
      "ADMIN",
    ]);
    expect(answer.audiences.map((audience) => audience.id)).toEqual(
      audiences.map((audience) => audience.id),
    );
  });

  it("does not create an audience for somebody who could not read it", async () => {
    const { service, audiences, prisma } = build({ persons: [NO_SEAT] });

    await service.audiences(principal(NO_SEAT.id, ["chat:participate"]));

    expect(audiences).toEqual([]);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("keeps Styrelsen for a term that ends in the future", async () => {
    /*
     * A board can minute in April that a term runs to the annual meeting, and
     * that person is on the board until the date arrives. A membership clause
     * testing only for a null end date would throw them out of Styrelsen the
     * day the minute was written.
     */
    const { service } = build({
      audiences: [ALL, BOARD, ADMINS],
      persons: [{ ...SEATED, seatEndedOn: new Date("2027-05-01T00:00:00Z") }],
    });

    expect(
      (
        await service.audiences(principal(SEATED.id, ["chat:participate"]))
      ).audiences.map((audience) => audience.kind),
    ).toEqual(["ALL", "BOARD", "ADMIN"]);
  });

  it("takes Styrelsen away on the next call after the term has ended", async () => {
    // Alla stays, because they still live here; Styrelsen and Administratörer
    // do not.
    const { service } = build({
      audiences: [ALL, BOARD, ADMINS],
      persons: [{ ...SEATED, seatEndedOn: new Date("2026-05-01T00:00:00Z") }],
    });

    expect(
      (
        await service.audiences(principal(SEATED.id, ["chat:participate"]))
      ).audiences.map((audience) => audience.kind),
    ).toEqual(["ALL"]);
  });

  it("lists the groups after the derived audiences, in the order the person was put into them", async () => {
    // A list that reordered itself as audiences were written to would move the
    // one somebody was about to press.
    const workParty: AudienceFixture = {
      id: "audience-workparty",
      kind: "GROUP",
      name: "Städdagen",
      createdByPersonId: SEATED.id,
    };
    const { service } = build({
      audiences: [GROUP, workParty, ADMINS, BOARD, ALL],
      persons: [SEATED],
      groupMembers: [
        { audienceId: workParty.id, personId: SEATED.id },
        { audienceId: GROUP_ID, personId: SEATED.id },
      ],
    });

    const answer = await service.audiences(
      principal(SEATED.id, ["chat:participate"]),
    );

    expect(answer.audiences.map((audience) => audience.id)).toEqual([
      ALL_ID,
      BOARD_ID,
      ADMIN_ID,
      workParty.id,
      GROUP_ID,
    ]);
  });
});

describe("the one refusal", () => {
  it("answers an audience this person is not in exactly as one that does not exist", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      persons: [SEATED, RESIDENT],
    });
    const stranger = principal(RESIDENT.id, ["chat:participate"]);

    const notIn = await service
      .page(stranger, query({ audienceId: BOARD_ID }))
      .catch((error: unknown) => error);
    const notThere = await service
      .page(stranger, query({ audienceId: "audience-nothing" }))
      .catch((error: unknown) => error);

    expect(notIn).toBeInstanceOf(FeedError);
    expect(notThere).toBeInstanceOf(FeedError);
    expect((notIn as FeedError).reason).toBe("audience-not-found");
    expect((notThere as FeedError).reason).toBe((notIn as FeedError).reason);
    expect((notThere as FeedError).status).toBe((notIn as FeedError).status);
  });

  it("refuses a group to somebody who is not in it, as one that does not exist", async () => {
    /*
     * The whole of what makes a group invisible. Somebody holding a board seat
     * is refused a group they were not put into exactly as they are refused an
     * audience that is not there, so the identifier space cannot be walked to
     * learn which groups the house has made.
     */
    const { service } = build({
      audiences: [ALL, BOARD, GROUP],
      persons: [SEATED],
    });

    await expect(
      service.page(
        principal(SEATED.id, ["chat:participate"]),
        query({ audienceId: GROUP_ID }),
      ),
    ).rejects.toMatchObject({ reason: "audience-not-found" });
  });

  it("refuses the poll for an audience the reader is not in with the same answer", async () => {
    const { service } = build({
      audiences: [ALL, BOARD, GROUP],
      persons: [SEATED],
    });

    await expect(
      service.since(
        principal(SEATED.id, ["chat:participate"]),
        query({ audienceId: GROUP_ID }),
        { createdAt: new Date(Date.UTC(2025, 0, 1)), id: "" },
      ),
    ).rejects.toMatchObject({ reason: "audience-not-found" });
  });

  it("refuses the write with the same answer", async () => {
    const { service, postCreate } = build({
      audiences: [ALL, BOARD],
      persons: [RESIDENT],
    });

    await expect(
      service.write(principal(RESIDENT.id, ["chat:participate"]), {
        audienceId: BOARD_ID,
        body: "Hej.",
      }),
    ).rejects.toMatchObject({ reason: "audience-not-found" });
    // And nothing was written: a service that refused with the right code after
    // having inserted the row would satisfy a test that only read the error.
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("answers a group's post asked for by identifier from outside exactly as one that does not exist", async () => {
    /*
     * The post's own address is the route a list cannot guard. A seat holder
     * who is not in the group is refused its post as they are refused an
     * identifier nobody ever wrote to, down to the status.
     */
    const { service } = build({
      audiences: [ALL, BOARD, GROUP],
      posts: [
        postFixture({
          id: "post-garden",
          audienceId: GROUP_ID,
          authorPersonId: RESIDENT.id,
          body: "Plommonen är mogna.",
          createdAt: new Date(Date.UTC(2026, 0, 1)),
        }),
      ],
      persons: [SEATED, RESIDENT],
      groupMembers: [{ audienceId: GROUP_ID, personId: RESIDENT.id }],
    });
    const outsider = principal(SEATED.id, [
      "chat:participate",
      "chat:moderate",
    ]);

    const notIn = await service
      .post(outsider, "post-garden")
      .catch((error: unknown) => error);
    const notThere = await service
      .post(outsider, "post-nothing")
      .catch((error: unknown) => error);

    expect(notIn).toBeInstanceOf(FeedError);
    expect((notIn as FeedError).reason).toBe("post-not-found");
    expect((notThere as FeedError).reason).toBe((notIn as FeedError).reason);
    expect((notThere as FeedError).status).toBe((notIn as FeedError).status);

    // And the member reads it.
    await expect(
      service.post(principal(RESIDENT.id, ["chat:participate"]), "post-garden"),
    ).resolves.toMatchObject({ body: "Plommonen är mogna." });
  });

  it("answers a post whose instant has not come as one that does not exist", async () => {
    // A scheduled post is in nobody's feed until it appears, and its address
    // says nothing about it before then either.
    const { service } = build({
      audiences: [ALL],
      posts: [
        postFixture({
          id: "post-scheduled",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Imorgon.",
          scheduledAt: NOW,
          createdAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        }),
      ],
      persons: [SEATED],
    });

    await expect(
      service.post(
        principal(SEATED.id, ["chat:participate"]),
        "post-scheduled",
      ),
    ).rejects.toMatchObject({ reason: "post-not-found" });
  });
});

describe("reading the feed", () => {
  it("answers the newest page, newest first", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: postsOverHours(POSTS_PER_PAGE + 10, SEATED.id),
      persons: [SEATED],
    });

    const page = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      query({ audienceId: BOARD_ID }),
    );

    expect(page.posts).toHaveLength(POSTS_PER_PAGE);
    // The newest end: the last post written is the first one on the page.
    expect(page.posts[0]?.body).toBe(`Rad ${String(POSTS_PER_PAGE + 10)}.`);
    expect(page.posts.at(-1)?.body).toBe("Rad 11.");
    expect(page.earlier).not.toBeNull();
    // The poll starts from the newest post on the screen.
    expect(page.latest).toBe(
      feedCursor({
        id: `post-${String(POSTS_PER_PAGE + 10).padStart(3, "0")}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, POSTS_PER_PAGE + 9)),
      }),
    );
  });

  it("says there is nothing earlier when the feed fits on one page", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: postsOverHours(3, SEATED.id),
      persons: [SEATED],
    });

    const page = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      query({ audienceId: BOARD_ID }),
    );

    // Null is the whole of the answer to "is there more", so a reader is never
    // left inferring it from a page that came back short.
    expect(page.earlier).toBeNull();
    expect(page.posts).toHaveLength(3);
  });

  it("says there is nothing to poll from while the feed is empty", async () => {
    // ADR 0010's empty room: the screen re-reads its first page until it has
    // a cursor.
    const { service } = build({ audiences: [ALL, BOARD], persons: [SEATED] });

    const page = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      query(),
    );

    expect(page).toEqual({
      pinned: [],
      scheduled: [],
      posts: [],
      earlier: null,
      latest: null,
    });
  });

  it("walks a whole audience backwards, showing every post exactly once", async () => {
    const total = POSTS_PER_PAGE * 2 + 7;
    const written = postsOverHours(total, SEATED.id);
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: written,
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const seen: string[] = [];
    let cursor = null as string | null;
    for (;;) {
      const page: Awaited<ReturnType<typeof service.page>> = await service.page(
        reader,
        query({ audienceId: BOARD_ID }),
        cursor === null ? null : parseFeedCursor(cursor),
      );
      seen.push(...page.posts.map((post) => post.id));
      if (page.earlier === null) {
        break;
      }
      cursor = page.earlier;
    }

    // Every post once, and in the order the feed is read: newest first.
    expect(seen).toEqual(written.map((post) => post.id).reverse());
  });

  it("walks an audience whose posts all share one instant", async () => {
    /*
     * The case a cursor on the instant alone gets wrong. The column keeps
     * milliseconds and posts written together can carry the same instant
     * exactly - and the boundary then falls between two of them in whichever
     * order the database answered.
     */
    const instant = new Date("2026-03-01T10:00:00.000Z");
    const total = POSTS_PER_PAGE + 5;
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: Array.from({ length: total }, (_, index) =>
        postFixture({
          id: `post-${String(index + 1).padStart(3, "0")}`,
          audienceId: BOARD_ID,
          authorPersonId: SEATED.id,
          body: `Rad ${String(index + 1)}.`,
          createdAt: instant,
        }),
      ),
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const first = await service.page(reader, query({ audienceId: BOARD_ID }));
    const second = await service.page(
      reader,
      query({ audienceId: BOARD_ID }),
      parseFeedCursor(first.earlier ?? ""),
    );

    const seen = [
      ...first.posts.map((post) => post.id),
      ...second.posts.map((post) => post.id),
    ];
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("pages past a post purged out from under the reader", async () => {
    /*
     * The whole reason the comparison is written out rather than handed to the
     * query builder's own cursor option. That one names a row and reads the
     * boundary values back out of it; a post is erased on its own clock a year
     * at a time, so between one page and the next the row can be gone - and a
     * cursor whose row has gone matches nothing at all.
     */
    const { service, posts } = build({
      audiences: [ALL, BOARD],
      posts: postsOverHours(POSTS_PER_PAGE + 4, SEATED.id),
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const first = await service.page(reader, query({ audienceId: BOARD_ID }));
    const boundary = parseFeedCursor(first.earlier ?? "");
    // The purge reaches the row the cursor names between the two reads.
    const index = posts.findIndex((row) => row.id === boundary?.id);
    posts.splice(index, 1);

    const second = await service.page(
      reader,
      query({ audienceId: BOARD_ID }),
      boundary,
    );

    // The four older than the boundary, all of them, although the row the
    // cursor was taken from is no longer there to be read back.
    expect(second.posts).toHaveLength(4);
    expect(second.posts.map((post) => post.id)).not.toContain(boundary?.id);
    expect(second.earlier).toBeNull();
  });

  it("reads every audience the reader is in, and none other", async () => {
    // With no audience asked for, the feed is the reader's own audiences
    // together - and a group they are not in contributes nothing to it.
    const { service } = build({
      audiences: [ALL, BOARD, GROUP],
      posts: [
        postFixture({
          id: "post-all",
          audienceId: ALL_ID,
          authorPersonId: RESIDENT.id,
          body: "Hissen står still.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 1)),
        }),
        postFixture({
          id: "post-board",
          audienceId: BOARD_ID,
          authorPersonId: SEATED.id,
          body: "Offerten på taket.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 2)),
        }),
        postFixture({
          id: "post-garden",
          audienceId: GROUP_ID,
          authorPersonId: RESIDENT.id,
          body: "Plommonen är mogna.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 3)),
        }),
      ],
      persons: [SEATED, RESIDENT],
      groupMembers: [{ audienceId: GROUP_ID, personId: RESIDENT.id }],
    });

    const board = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      query(),
    );
    const resident = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query(),
    );

    expect(board.posts.map((post) => post.id)).toEqual([
      "post-board",
      "post-all",
    ]);
    expect(resident.posts.map((post) => post.id)).toEqual([
      "post-garden",
      "post-all",
    ]);
  });

  it("keeps a post out of the feed until its instant, and a board post while its news item is down", async () => {
    /*
     * A scheduled post is stored with the instant it is to appear, and a board
     * post is a news item: taking the notice down takes it out of the feed.
     */
    const { service } = build({
      audiences: [ALL],
      posts: [
        postFixture({
          id: "post-shown",
          audienceId: ALL_ID,
          authorPersonId: RESIDENT.id,
          body: "Synlig.",
          createdAt: new Date(Date.UTC(2026, 0, 1)),
        }),
        postFixture({
          id: "post-scheduled",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Imorgon.",
          scheduledAt: NOW,
          createdAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        }),
        postFixture({
          id: "post-taken-down",
          audienceId: ALL_ID,
          authorPersonId: null,
          byBoard: true,
          namesAuthor: false,
          body: null,
          newsId: "news-down",
          createdAt: new Date(Date.UTC(2026, 0, 2)),
        }),
      ],
      news: [
        { id: "news-down", slug: "nere", title: "Nere", published: false },
      ],
      persons: [SEATED, RESIDENT],
    });

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query(),
    );

    expect(page.posts.map((post) => post.id)).toEqual(["post-shown"]);
  });

  it("attributes a post whose author the register no longer holds", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: [
        postFixture({
          id: "post-1",
          audienceId: BOARD_ID,
          authorPersonId: "person-erased",
          body: "Skrivet av nagon som ar borta.",
          createdAt: NOW,
        }),
      ],
      persons: [SEATED],
    });

    const page = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      query({ audienceId: BOARD_ID }),
    );

    // The feed says "we no longer know" rather than showing an empty name or
    // breaking: a post is service tier and a person can be purged out from
    // under one.
    expect(page.posts[0]?.author).toEqual({ kind: "unknown" });
    expect(page.posts[0]?.body).toBe("Skrivet av nagon som ar borta.");
  });

  it("names nobody with protected personal data, the board included", async () => {
    /*
     * Withheld from every reader of the audience although every one of them
     * holds `protectedData:reveal` with their seat. That capability is what lets
     * somebody perform an act of revealing and be recorded doing it; a name
     * that simply appeared in a payload nothing audits is not that act, and the
     * association's own record of processing says these people are masked
     * everywhere.
     */
    const protectedColleague: PersonFixture = {
      id: "person-skyddad",
      firstName: "Elisabet",
      lastName: "Rydberg",
      protectedPersonalData: true,
      seatEndedOn: null,
    };
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: [
        postFixture({
          id: "post-1",
          audienceId: BOARD_ID,
          authorPersonId: protectedColleague.id,
          body: "Jag tar offerten.",
          createdAt: NOW,
        }),
      ],
      persons: [SEATED, protectedColleague],
    });

    const page = await service.page(
      principal(SEATED.id, ["chat:participate", "protectedData:reveal"]),
      query({ audienceId: BOARD_ID }),
    );

    expect(page.posts[0]?.author).toEqual({
      kind: "protected",
      personId: protectedColleague.id,
    });
    // The words stay: what is withheld is the attribution and never the post.
    expect(page.posts[0]?.body).toBe("Jag tar offerten.");
  });

  it("names the writer of a post as Styrelsen only when they chose to be named", async () => {
    // A board post speaks for the board. Its writer is on it only "via" their
    // own choice, and nothing ever named a news item's author.
    const { service } = build({
      audiences: [ALL],
      posts: [
        postFixture({
          id: "post-unnamed",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          byBoard: true,
          namesAuthor: false,
          body: null,
          newsId: "news-water",
          createdAt: new Date(Date.UTC(2026, 0, 1, 1)),
        }),
        postFixture({
          id: "post-named",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          byBoard: true,
          namesAuthor: true,
          body: null,
          newsId: "news-roof",
          createdAt: new Date(Date.UTC(2026, 0, 1, 2)),
        }),
      ],
      news: [
        {
          id: "news-water",
          slug: "vattnet",
          title: "Vattnet stängs av",
          published: true,
          content: paragraphsContent([
            "Tisdag 9-12.",
            "Fyll en kanna kvällen före.",
          ]),
        },
        { id: "news-roof", slug: "taket", title: "Taket", published: true },
      ],
      persons: [SEATED, RESIDENT],
    });

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query(),
    );
    const byId = new Map(page.posts.map((post) => [post.id, post]));

    expect(byId.get("post-unnamed")?.author).toBeNull();
    expect(byId.get("post-unnamed")?.byBoard).toBe(true);
    // The item's text as the card shows it: its paragraphs, a blank line
    // between each.
    expect(byId.get("post-unnamed")?.news).toEqual({
      id: "news-water",
      slug: "vattnet",
      title: "Vattnet stängs av",
      text: "Tisdag 9-12.\n\nFyll en kanna kvällen före.",
    });
    expect(byId.get("post-named")?.author).toEqual({
      kind: "person",
      personId: SEATED.id,
      name: "Astrid Lindqvist",
    });
  });

  it("counts the likes, comments and reads on a post, and says whether this reader likes it", async () => {
    const { service } = build({
      audiences: [ALL],
      posts: [
        postFixture({
          id: "post-1",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Plommon vid grinden.",
          createdAt: NOW,
        }),
      ],
      persons: [SEATED, RESIDENT],
      likes: [
        { postId: "post-1", personId: RESIDENT.id },
        { postId: "post-1", personId: "person-somebody-else" },
      ],
      comments: [
        { postId: "post-1" },
        { postId: "post-1" },
        { postId: "post-1" },
      ],
      postReads: [{ postId: "post-1", personId: RESIDENT.id, readAt: NOW }],
    });

    const resident = await service.post(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
    );
    const author = await service.post(
      principal(SEATED.id, ["chat:participate"]),
      "post-1",
    );

    expect(resident).toMatchObject({
      likes: 2,
      liked: true,
      comments: 3,
      readBy: 1,
    });
    // Counts, never names: who liked it is not on the post.
    expect(author.liked).toBe(false);
    expect(author.likes).toBe(2);
  });
});

describe("pinned posts", () => {
  function pinnedFeed() {
    return build({
      audiences: [ALL],
      posts: [
        ...postsOverHours(POSTS_PER_PAGE + 2, RESIDENT.id, ALL_ID),
        postFixture({
          id: "post-pinned-old",
          audienceId: ALL_ID,
          authorPersonId: null,
          byBoard: true,
          namesAuthor: false,
          body: null,
          newsId: "news-rules",
          pinnedAt: new Date(Date.UTC(2026, 1, 1)),
          createdAt: new Date(Date.UTC(2025, 5, 1)),
        }),
        postFixture({
          id: "post-pinned-new",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Läs detta först.",
          pinnedAt: new Date(Date.UTC(2026, 2, 1)),
          createdAt: new Date(Date.UTC(2025, 6, 1)),
        }),
      ],
      news: [
        {
          id: "news-rules",
          slug: "ordningsregler",
          title: "Ordningsregler",
          published: true,
        },
      ],
      persons: [SEATED, RESIDENT],
    });
  }

  it("puts them on top of the first page, newest pin first, and not among the posts", async () => {
    const { service } = pinnedFeed();

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query(),
    );

    expect(page.pinned.map((post) => post.id)).toEqual([
      "post-pinned-new",
      "post-pinned-old",
    ]);
    expect(page.pinned.every((post) => post.pinned)).toBe(true);
    expect(page.posts.map((post) => post.id)).not.toContain("post-pinned-new");
    expect(page.posts).toHaveLength(POSTS_PER_PAGE);
  });

  it("leaves them off every page read from a cursor", async () => {
    // A pinned post is on top of the feed rather than at a place in it, so it
    // is on no page below - and the reader of an older page already holds the
    // cursor the poll continues from.
    const { service } = pinnedFeed();
    const reader = principal(RESIDENT.id, ["chat:participate"]);

    const first = await service.page(reader, query());
    const second = await service.page(
      reader,
      query(),
      parseFeedCursor(first.earlier ?? ""),
    );

    expect(second.pinned).toEqual([]);
    expect(second.latest).toBeNull();
    expect(second.posts.map((post) => post.id)).toEqual([
      "post-002",
      "post-001",
    ]);
    expect(second.earlier).toBeNull();
  });

  it("polls from the newest post on the screen when a pinned one is newer than the page", async () => {
    /*
     * The poll delivers what was written after the screen was drawn, and the
     * screen holds the pinned posts too. A cursor taken from the page alone
     * would hand back a pinned post the screen already shows.
     */
    const { service } = build({
      audiences: [ALL],
      posts: [
        ...postsOverHours(2, RESIDENT.id, ALL_ID),
        postFixture({
          id: "post-pinned",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Nyast och fäst.",
          pinnedAt: NOW,
          createdAt: new Date(Date.UTC(2026, 5, 1)),
        }),
      ],
      persons: [SEATED, RESIDENT],
    });

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query(),
    );

    expect(page.latest).toBe(
      feedCursor({
        id: "post-pinned",
        createdAt: new Date(Date.UTC(2026, 5, 1)),
      }),
    );
  });
});

describe("narrowing the feed", () => {
  function mixedFeed() {
    return build({
      audiences: [ALL, BOARD],
      posts: [
        postFixture({
          id: "post-neighbour",
          audienceId: ALL_ID,
          authorPersonId: RESIDENT.id,
          body: "Cykelrummet går inte att låsa.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 1)),
        }),
        postFixture({
          id: "post-board",
          audienceId: ALL_ID,
          authorPersonId: null,
          byBoard: true,
          namesAuthor: false,
          body: null,
          newsId: "news-water",
          important: true,
          createdAt: new Date(Date.UTC(2026, 0, 1, 2)),
        }),
        postFixture({
          id: "post-styrelsen",
          audienceId: BOARD_ID,
          authorPersonId: SEATED.id,
          body: "Vattnet: vi ringer rörmokaren.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 3)),
        }),
      ],
      news: [
        {
          id: "news-water",
          slug: "vattnet",
          title: "Vattnet stängs av på torsdag",
          published: true,
        },
      ],
      persons: [SEATED, RESIDENT],
    });
  }

  it("reads posts written as Styrelsen, or by the neighbours as themselves", async () => {
    const { service } = mixedFeed();
    const reader = principal(SEATED.id, ["chat:participate"]);

    const board = await service.page(reader, query({ from: "board" }));
    const neighbours = await service.page(
      reader,
      query({ from: "neighbours" }),
    );

    expect(board.posts.map((post) => post.id)).toEqual(["post-board"]);
    // A board member writing in Styrelsen as themselves is not a post written
    // as Styrelsen.
    expect(neighbours.posts.map((post) => post.id)).toEqual([
      "post-styrelsen",
      "post-neighbour",
    ]);
  });

  it("reads only what the board marked important", async () => {
    const { service } = mixedFeed();

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query({ important: true }),
    );

    expect(page.posts.map((post) => post.id)).toEqual(["post-board"]);
  });

  it("searches a post's text and a news item's title, whatever the case, inside the reader's audiences", async () => {
    const { service } = mixedFeed();

    const resident = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query({ search: "VATTNET" }),
    );
    const board = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      query({ search: "vattnet" }),
    );

    // The board's own post says it too, and is in no audience the resident is in.
    expect(resident.posts.map((post) => post.id)).toEqual(["post-board"]);
    expect(board.posts.map((post) => post.id)).toEqual([
      "post-styrelsen",
      "post-board",
    ]);
  });

  it("narrows the poll by the same query as the page", async () => {
    const { service } = mixedFeed();

    const update = await service.since(
      principal(SEATED.id, ["chat:participate"]),
      query({ from: "board" }),
      { createdAt: new Date(Date.UTC(2025, 0, 1)), id: "" },
    );

    expect(update.posts.map((post) => post.id)).toEqual(["post-board"]);
  });
});

describe("searching past a strike", () => {
  /*
   * A struck post's text is withheld from everybody in the group but its author
   * and the board. A search that matched it would tell the others the words
   * were there, one guess at a time, so for them it is matched by nothing it
   * said.
   */
  function struckGroup() {
    return build({
      audiences: [ALL, BOARD, GROUP],
      posts: [
        postFixture({
          id: "post-struck",
          audienceId: GROUP_ID,
          authorPersonId: "person-bo",
          body: "Grannen i 1202 spelar musik hela natten.",
          struckAt: new Date("2026-03-03T09:00:00.000Z"),
          createdAt: new Date(Date.UTC(2026, 0, 1, 1)),
        }),
        postFixture({
          id: "post-standing",
          audienceId: GROUP_ID,
          authorPersonId: RESIDENT.id,
          body: "Musik i trädgården på lördag?",
          createdAt: new Date(Date.UTC(2026, 0, 1, 2)),
        }),
      ],
      persons: [
        RESIDENT,
        SEATED,
        {
          id: "person-bo",
          firstName: "Bo",
          lastName: "Ek",
          protectedPersonalData: false,
          movedOutOn: null,
        },
      ],
      groupMembers: [
        { audienceId: GROUP_ID, personId: RESIDENT.id },
        { audienceId: GROUP_ID, personId: SEATED.id },
        { audienceId: GROUP_ID, personId: "person-bo" },
      ],
    });
  }

  it("never matches a struck post's text for a reader who neither wrote it nor moderates", async () => {
    const { service } = struckGroup();

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query({ search: "musik" }),
    );

    expect(page.posts.map((post) => post.id)).toEqual(["post-standing"]);
  });

  it("does not match it for the capability without a seat either", async () => {
    // An administrator holds every capability, and one who lives here and is
    // in the group is not the board (ADR 0012).
    const { service } = struckGroup();

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate", "chat:moderate"]),
      query({ search: "musik" }),
    );

    expect(page.posts.map((post) => post.id)).toEqual(["post-standing"]);
  });

  it("matches it for its author", async () => {
    const { service } = struckGroup();

    const page = await service.page(
      principal("person-bo", ["chat:participate"]),
      query({ search: "musik" }),
    );

    expect(page.posts.map((post) => post.id)).toEqual([
      "post-standing",
      "post-struck",
    ]);
  });

  it("matches it for a board member who moderates", async () => {
    const { service } = struckGroup();

    const page = await service.page(
      principal(SEATED.id, ["chat:participate", "chat:moderate"]),
      query({ search: "musik" }),
    );

    expect(page.posts.map((post) => post.id)).toEqual([
      "post-standing",
      "post-struck",
    ]);
  });
});

describe("the poll", () => {
  it("answers only what was written after the cursor", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: postsOverHours(5, SEATED.id),
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const page = await service.page(reader, query({ audienceId: BOARD_ID }));
    const update = await service.since(
      reader,
      query({ audienceId: BOARD_ID }),
      parseFeedCursor(page.latest ?? "") ?? { createdAt: NOW, id: "" },
    );

    expect(update.posts).toEqual([]);
    expect(update.more).toBe(false);
    // The cursor handed in comes back, so a screen polling an idle feed keeps
    // its place rather than restarting from the beginning of the feed.
    expect(update.cursor).toBe(page.latest);
  });

  it("brings in what somebody else wrote, oldest first", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: postsOverHours(2, SEATED.id),
      persons: [SEATED, { ...RESIDENT, seatEndedOn: null }],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);
    const page = await service.page(reader, query({ audienceId: BOARD_ID }));

    const colleague = principal(RESIDENT.id, ["chat:participate"]);
    await service.write(colleague, { audienceId: BOARD_ID, body: "Först." });
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    await service.write(colleague, { audienceId: BOARD_ID, body: "Sedan." });

    const update = await service.since(
      reader,
      query({ audienceId: BOARD_ID }),
      parseFeedCursor(page.latest ?? "") ?? { createdAt: NOW, id: "" },
    );

    expect(update.posts.map((post) => post.body)).toEqual(["Först.", "Sedan."]);
    expect(update.cursor).not.toBe(page.latest);
    expect(update.more).toBe(false);
  });

  it("bounds a screen that has been closed for a week", async () => {
    /*
     * A cursor read that is not bounded is an outage. The answer is a page, a
     * cursor and the flag that says to ask again at once, so catching up is
     * several small reads rather than one that times out.
     */
    const written = postsOverHours(POSTS_PER_PAGE * 2, SEATED.id);
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: written,
      persons: [SEATED],
    });

    const update = await service.since(
      principal(SEATED.id, ["chat:participate"]),
      query({ audienceId: BOARD_ID }),
      { createdAt: new Date(Date.UTC(2025, 0, 1)), id: "" },
    );

    expect(update.posts).toHaveLength(POSTS_PER_PAGE);
    expect(update.posts[0]?.id).toBe(written[0]?.id);
    expect(update.more).toBe(true);
    // The next poll continues from the newest post this one delivered.
    const last = written[POSTS_PER_PAGE - 1];
    expect(update.cursor).toBe(last === undefined ? null : feedCursor(last));
  });

  it("delivers a scheduled post on the first poll after its instant", async () => {
    /*
     * Stored with the instant it is to appear, so a poll's cursor - never later
     * than the moment it was taken - is still behind it when it appears, and
     * the post is delivered rather than skipped because it was written earlier.
     */
    const appears = new Date(NOW.getTime() + 60 * 60 * 1000);
    const { service } = build({
      audiences: [ALL],
      posts: [
        ...postsOverHours(1, RESIDENT.id, ALL_ID),
        postFixture({
          id: "post-scheduled",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Om en timme.",
          scheduledAt: NOW,
          createdAt: appears,
        }),
      ],
      persons: [SEATED, RESIDENT],
    });
    const reader = principal(RESIDENT.id, ["chat:participate"]);

    const page = await service.page(reader, query());
    const before = await service.since(
      reader,
      query(),
      parseFeedCursor(page.latest ?? "") ?? { createdAt: NOW, id: "" },
    );
    vi.setSystemTime(appears);
    const after = await service.since(
      reader,
      query(),
      parseFeedCursor(before.cursor) ?? { createdAt: NOW, id: "" },
    );

    expect(before.posts).toEqual([]);
    expect(after.posts.map((post) => post.id)).toEqual(["post-scheduled"]);
  });
});

describe("writing", () => {
  it("refuses in order: the audience, then the budget, then a personal identity number", async () => {
    /*
     * The audience first because it is the cheapest and the least revealing: a
     * caller learns only what they would learn by asking to read it. Each case
     * below would also fail every later check, so a service that asked them in
     * another order would answer it with a different reason.
     */
    const atBudget = (authorPersonId: string) =>
      Array.from({ length: POSTS_PER_WRITE_WINDOW }, (_, index) =>
        postFixture({
          id: `post-${authorPersonId}-${String(index)}`,
          audienceId: ALL_ID,
          authorPersonId,
          body: "Rad.",
          createdAt: NOW,
        }),
      );
    const outsider: PersonFixture = {
      id: "person-outsider",
      firstName: "Ulla",
      lastName: "Ut",
      protectedPersonalData: false,
    };
    const { service, postCreate } = build({
      audiences: [ALL, BOARD],
      posts: [...atBudget(outsider.id), ...atBudget(RESIDENT.id)],
      persons: [outsider, RESIDENT, SEATED],
    });
    const body = `Det ar ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}.`;

    await expect(
      service.write(principal(outsider.id, ["chat:participate"]), {
        audienceId: ALL_ID,
        body,
      }),
    ).rejects.toMatchObject({ reason: "audience-not-found" });
    await expect(
      service.write(principal(RESIDENT.id, ["chat:participate"]), {
        audienceId: ALL_ID,
        body,
      }),
    ).rejects.toMatchObject({ reason: "too-many-posts" });
    await expect(
      service.write(principal(SEATED.id, ["chat:participate"]), {
        audienceId: ALL_ID,
        body,
      }),
    ).rejects.toMatchObject({ reason: "personal-identity-number" });
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("refuses the post past the window budget, counted over the window", async () => {
    const { service, postCount } = build({
      audiences: [ALL, BOARD],
      posts: Array.from({ length: POSTS_PER_WRITE_WINDOW }, (_, index) =>
        postFixture({
          id: `post-${String(index)}`,
          audienceId: BOARD_ID,
          authorPersonId: SEATED.id,
          body: "Rad.",
          createdAt: new Date(),
        }),
      ),
      persons: [SEATED],
    });

    const error = await service
      .write(principal(SEATED.id, ["chat:participate"]), {
        audienceId: BOARD_ID,
        body: "En till.",
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ reason: "too-many-posts" });
    expect((error as FeedError).status).toBe(429);

    /*
     * The window it asked for, and not only that it refused. A count over the
     * wrong window refuses and permits exactly when a correct one would in a
     * fixture of one.
     */
    const asked = postCount.mock.calls.at(-1)?.[0].where as
      | {
          authorPersonId?: string;
          byBoard?: boolean;
          createdAt?: { gte?: Date };
        }
      | undefined;
    expect(asked?.authorPersonId).toBe(SEATED.id);
    const since = asked?.createdAt?.gte;
    expect(since).toBeInstanceOf(Date);
    expect(Date.now() - (since as Date).getTime()).toBe(
      WRITE_WINDOW_MINUTES * 60 * 1000,
    );
    // What the board posts as Styrelsen is the board's, and is not on the
    // writer's own budget.
    expect(asked?.byBoard).toBe(false);
  });

  it("counts only this person's own posts against the budget", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: [
        ...Array.from({ length: POSTS_PER_WRITE_WINDOW }, (_, index) =>
          postFixture({
            id: `post-${String(index)}`,
            audienceId: BOARD_ID,
            authorPersonId: "person-somebody-else",
            body: "Rad.",
            createdAt: new Date(),
          }),
        ),
        ...Array.from({ length: POSTS_PER_WRITE_WINDOW }, (_, index) =>
          postFixture({
            id: `post-board-${String(index)}`,
            audienceId: ALL_ID,
            authorPersonId: SEATED.id,
            byBoard: true,
            namesAuthor: false,
            body: null,
            newsId: `news-${String(index)}`,
            createdAt: new Date(),
          }),
        ),
      ],
      persons: [SEATED],
    });

    await expect(
      service.write(principal(SEATED.id, ["chat:participate"]), {
        audienceId: BOARD_ID,
        body: "Min forsta.",
      }),
    ).resolves.toMatchObject({ body: "Min forsta." });
  });

  it("refuses a personal identity number, naming the offset and never the digits", async () => {
    const { service, postCreate } = build({
      audiences: [ALL, BOARD],
      persons: [SEATED],
    });
    const body = `Det ar ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER} som star i registret.`;

    const error = await service
      .write(principal(SEATED.id, ["chat:participate"]), {
        audienceId: BOARD_ID,
        body,
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FeedError);
    expect((error as FeedError).reason).toBe("personal-identity-number");
    const details = (error as FeedError).details();
    expect(details.locations).toEqual([
      { part: "body", offset: body.indexOf("19811218") },
    ]);
    /*
     * The value is exactly what must not travel back. Asserted over the whole
     * serialised refusal rather than over the locations alone, because the
     * message and the details are both answered to the caller.
     */
    expect(
      JSON.stringify({ ...details, message: (error as Error).message }),
    ).not.toContain("19811218");
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("attributes the written post to its author", async () => {
    const { service } = build({ audiences: [ALL, BOARD], persons: [SEATED] });

    const written = await service.write(
      principal(SEATED.id, ["chat:participate"]),
      { audienceId: BOARD_ID, body: "Taket ar klart." },
    );

    expect(written.author).toEqual({
      kind: "person",
      personId: SEATED.id,
      name: "Astrid Lindqvist",
    });
    expect(written.body).toBe("Taket ar klart.");
    expect(written.byBoard).toBe(false);
    expect(written.audience).toMatchObject({ id: BOARD_ID, kind: "BOARD" });
  });

  it("writes to a group for somebody in it", async () => {
    const { service, posts } = build({
      audiences: [ALL, GROUP],
      persons: [RESIDENT],
      groupMembers: [{ audienceId: GROUP_ID, personId: RESIDENT.id }],
    });

    await service.write(principal(RESIDENT.id, ["chat:participate"]), {
      audienceId: GROUP_ID,
      body: "Vi ses vid komposten.",
    });

    expect(posts.map((post) => post.audienceId)).toEqual([GROUP_ID]);
  });
});

describe("images on a post", () => {
  /** An upload of this person's for a post, made a minute ago and on no post. */
  function upload(
    id: string,
    overrides: Partial<FileFixture> = {},
  ): FileFixture {
    return {
      id,
      visibility: "POST",
      uploadedByPersonId: RESIDENT.id,
      createdAt: new Date(NOW.getTime() - 60_000),
      width: 800,
      height: 600,
      ...overrides,
    };
  }

  it("puts the uploads on the post in the order they were named", async () => {
    const { service, postImages } = build({
      audiences: [ALL],
      persons: [RESIDENT],
      files: [upload("file-a"), upload("file-b")],
    });

    const written = await service.write(
      principal(RESIDENT.id, ["chat:participate"]),
      {
        audienceId: ALL_ID,
        body: "Cykelrummet efter stormen.",
        imageIds: ["file-b", "file-a"],
      },
    );

    expect(postImages.map((image) => [image.fileId, image.sortOrder])).toEqual([
      ["file-b", 0],
      ["file-a", 1],
    ]);
    expect(written.images).toEqual([
      { id: "file-b", url: "/api/media/file-b", width: 800, height: 600 },
      { id: "file-a", url: "/api/media/file-a", width: 800, height: 600 },
    ]);
  });

  it("refuses more than a post carries, before anything is written", async () => {
    const ids = Array.from(
      { length: MAX_IMAGES_PER_POST + 1 },
      (_, index) => `file-${String(index)}`,
    );
    const { service, postCreate } = build({
      audiences: [ALL],
      persons: [RESIDENT],
      files: ids.map((id) => upload(id)),
    });

    const error = await service
      .write(principal(RESIDENT.id, ["chat:participate"]), {
        audienceId: ALL_ID,
        body: "Ett album.",
        imageIds: ids,
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ reason: "too-many-images" });
    expect((error as FeedError).status).toBe(422);
    expect(postCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["somebody else's upload", { uploadedByPersonId: SEATED.id }],
    ["a file that is not an upload for a post", { visibility: "INTERNAL" }],
    [
      "an upload older than a post takes",
      {
        createdAt: new Date(
          NOW.getTime() - ATTACHABLE_HOURS * 60 * 60 * 1000 - 1,
        ),
      },
    ],
  ] as const)(
    "refuses %s as if it were not there, and writes nothing",
    async (_case, overrides) => {
      const { service, postCreate, postImageCreateMany } = build({
        audiences: [ALL],
        persons: [RESIDENT, SEATED],
        files: [upload("file-a", overrides as Partial<FileFixture>)],
      });

      const error = await service
        .write(principal(RESIDENT.id, ["chat:participate"]), {
          audienceId: ALL_ID,
          body: "Se bilden.",
          imageIds: ["file-a"],
        })
        .catch((thrown: unknown) => thrown);

      expect(error).toMatchObject({ reason: "image-not-found" });
      expect((error as FeedError).status).toBe(404);
      expect(postCreate).not.toHaveBeenCalled();
      expect(postImageCreateMany).not.toHaveBeenCalled();
    },
  );

  it("refuses an upload already on a post, and one that does not exist", async () => {
    const { service, postCreate } = build({
      audiences: [ALL],
      persons: [RESIDENT],
      files: [upload("file-a")],
      postImages: [{ postId: "post-earlier", fileId: "file-a", sortOrder: 0 }],
    });
    const writer = principal(RESIDENT.id, ["chat:participate"]);

    for (const imageIds of [["file-a"], ["file-missing"]]) {
      await expect(
        service.write(writer, {
          audienceId: ALL_ID,
          body: "En gang till.",
          imageIds,
        }),
      ).rejects.toMatchObject({ reason: "image-not-found" });
    }
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("checks the images under the writer's own lock", async () => {
    // So two posts written at once cannot both take one upload.
    const { service, prisma, locks } = build({
      audiences: [ALL],
      persons: [RESIDENT],
      files: [upload("file-a")],
    });
    const counted: number[] = [];
    prisma.mediaFile.count.mockImplementationOnce(async () => {
      counted.push(locks.length);
      return 1;
    });

    await service.write(principal(RESIDENT.id, ["chat:participate"]), {
      audienceId: ALL_ID,
      body: "Se bilden.",
      imageIds: ["file-a"],
    });

    expect(locks[0]).toMatch(/person/);
    expect(counted[0]).toBeGreaterThanOrEqual(1);
  });

  it("withholds the images of a struck post with its text, and shows them to its author", async () => {
    const struck = postFixture({
      id: "post-struck",
      audienceId: GROUP_ID,
      authorPersonId: RESIDENT.id,
      body: "Det har ar grannen.",
      createdAt: new Date(NOW.getTime() - 60_000),
      struckAt: NOW,
    });
    const neighbour: PersonFixture = {
      id: "person-neighbour",
      firstName: "Nils",
      lastName: "Granne",
      protectedPersonalData: false,
      movedOutOn: null,
    };
    const fixture = {
      audiences: [ALL, GROUP],
      persons: [RESIDENT, neighbour],
      posts: [struck],
      groupMembers: [
        { audienceId: GROUP_ID, personId: RESIDENT.id },
        { audienceId: GROUP_ID, personId: neighbour.id },
      ],
      files: [upload("file-a")],
      postImages: [{ postId: struck.id, fileId: "file-a", sortOrder: 0 }],
    };

    const asNeighbour = await build(fixture).service.post(
      principal(neighbour.id, ["chat:participate"]),
      struck.id,
    );
    const asAuthor = await build(fixture).service.post(
      principal(RESIDENT.id, ["chat:participate"]),
      struck.id,
    );

    expect(asNeighbour.body).toBeNull();
    expect(asNeighbour.images).toEqual([]);
    expect(asAuthor.images.map((image) => image.id)).toEqual(["file-a"]);
  });

  it("shows no images on an erased post", async () => {
    const erased = postFixture({
      id: "post-erased",
      audienceId: ALL_ID,
      authorPersonId: null,
      body: null,
      createdAt: new Date(NOW.getTime() - 60_000),
      erasedAt: NOW,
    });
    const { service } = build({
      audiences: [ALL],
      persons: [RESIDENT],
      posts: [erased],
      files: [upload("file-a")],
      postImages: [{ postId: erased.id, fileId: "file-a", sortOrder: 0 }],
    });

    const view = await service.post(
      principal(RESIDENT.id, ["chat:participate"]),
      erased.id,
    );

    expect(view.images).toEqual([]);
  });
});

describe("uploading an image for a post", () => {
  const image = { bytes: Buffer.from("png"), fileName: "trappan.png" };

  it("stores it as a post's image, declared as showing people, by its uploader", async () => {
    const { service, media } = build({ audiences: [ALL], persons: [RESIDENT] });

    const uploaded = await service.uploadImage(
      principal(RESIDENT.id, ["chat:participate"]),
      image,
    );

    expect(uploaded).toEqual({
      id: "file-1",
      url: "/api/media/file-1",
      width: 640,
      height: 480,
    });
    expect(media.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: "POST",
        showsIdentifiablePersons: true,
        uploadedByPersonId: RESIDENT.id,
        channel: "WEB",
        // The log outlives the post and no purge reaches it.
        recordFileName: false,
      }),
    );
    // No capability: a group's picture is read through the group or not at all.
    expect(media.upload.mock.calls[0]?.[0]).not.toHaveProperty(
      "requiredCapability",
    );
  });

  it("refuses somebody in no audience before a byte is stored", async () => {
    const { service, media } = build({
      audiences: [ALL],
      persons: [NO_SEAT],
    });

    await expect(
      service.uploadImage(principal(NO_SEAT.id, ["chat:participate"]), image),
    ).rejects.toMatchObject({ reason: "audience-not-found" });
    expect(media.upload).not.toHaveBeenCalled();
  });

  it("refuses past the day's uploads, counting this person's and only the day's", async () => {
    const ofTheDay = Array.from({ length: UPLOADS_PER_DAY }, (_, index) => ({
      id: `file-day-${String(index)}`,
      visibility: "POST" as const,
      uploadedByPersonId: RESIDENT.id,
      createdAt: new Date(NOW.getTime() - 60_000),
      width: null,
      height: null,
    }));
    const { service, media } = build({
      audiences: [ALL],
      persons: [RESIDENT, SEATED],
      files: ofTheDay,
    });

    const error = await service
      .uploadImage(principal(RESIDENT.id, ["chat:participate"]), image)
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ reason: "too-many-uploads" });
    expect((error as FeedError).status).toBe(429);
    expect(media.upload).not.toHaveBeenCalled();

    // Somebody else's day is their own.
    await expect(
      service.uploadImage(principal(SEATED.id, ["chat:participate"]), image),
    ).resolves.toMatchObject({ url: expect.stringMatching(/^\/api\/media\//) });
  });
});

describe("writing against the sweep and the poll", () => {
  it("takes the writer's lock, the audience's, and the feed's order, in that order", async () => {
    /*
     * The nightly sweep erases a group that has held nothing for a year, and it
     * decides that from a read of the posts. A post committed between that read
     * and the delete is erased by the cascade, and its author is told it was
     * stored. Both sides take the same key, so one of them waits: what the key
     * is matters, because two spellings would be two locks that never meet.
     */
    const { service, locks } = build({
      audiences: [ALL, BOARD],
      persons: [SEATED],
    });

    await service.write(principal(SEATED.id, ["chat:participate"]), {
      audienceId: BOARD_ID,
      body: "Ett inlägg.",
    });

    // The writer's own lock first, under which the allowance is counted, the
    // audience's after it, and the feed's order last, around the stamp.
    expect(locks).toEqual([
      `feed-person:${SEATED.id}`,
      `audience:${BOARD_ID}`,
      "feed-order",
    ]);
  });

  it("stamps a post after the newest in the feed, so a poll cannot skip it", async () => {
    /*
     * A screen polls with the newest post it holds as its cursor. A post
     * stamped at or before that instant - two writers in one millisecond, or a
     * clock that reads earlier than the last stamp - would never reach it. The
     * newest in any audience, because one poll covers every audience a person
     * is in.
     */
    const newest = new Date(Date.now() + 60_000);
    const { service, postCreate } = build({
      audiences: [ALL, BOARD],
      persons: [SEATED],
      posts: [
        postFixture({
          id: "post-newest",
          audienceId: ALL_ID,
          authorPersonId: RESIDENT.id,
          body: "Före.",
          createdAt: newest,
        }),
      ],
    });

    await service.write(principal(SEATED.id, ["chat:participate"]), {
      audienceId: BOARD_ID,
      body: "Efter.",
    });

    const stamped = postCreate.mock.calls[0]?.[0].data.createdAt;
    expect(stamped?.getTime()).toBe(newest.getTime() + 1);
  });

  it("stamps a post with the clock when the newest is a scheduled one", async () => {
    // A scheduled post's instant is the one it was asked to appear at, and a
    // post written now belongs before it rather than after it.
    const { service, postCreate } = build({
      audiences: [ALL, BOARD],
      persons: [SEATED],
      posts: [
        postFixture({
          id: "post-scheduled",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Nästa vecka.",
          scheduledAt: new Date(NOW.getTime() - 60_000),
          createdAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
        }),
      ],
    });

    await service.write(principal(SEATED.id, ["chat:participate"]), {
      audienceId: BOARD_ID,
      body: "Nu.",
    });

    expect(postCreate.mock.calls[0]?.[0].data.createdAt).toEqual(NOW);
  });

  it("refuses an audience the sweep erased, rather than failing on the write", async () => {
    /*
     * Read again under the lock. Membership is decided before the lock, so the
     * group can be erased while this write waits for it - and without the
     * second read the insert meets the foreign key and answers a fault where
     * the audience's own refusal belongs.
     */
    const { service, posts } = build({
      audiences: [ALL, GROUP],
      persons: [RESIDENT],
      groupMembers: [{ audienceId: GROUP_ID, personId: RESIDENT.id }],
      sweptOnLock: true,
    });

    await expect(
      service.write(principal(RESIDENT.id, ["chat:participate"]), {
        audienceId: GROUP_ID,
        body: "Ett inlägg.",
      }),
    ).rejects.toMatchObject({ reason: "audience-not-found" });
    expect(posts).toEqual([]);
  });
});

describe("the read marker", () => {
  it("counts what this person has not read, and never their own", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: [
        ...postsOverHours(3, "person-somebody-else"),
        postFixture({
          id: "post-own",
          audienceId: BOARD_ID,
          authorPersonId: SEATED.id,
          body: "Min egen.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 9)),
        }),
      ],
      persons: [SEATED],
    });

    const answer = await service.audiences(
      principal(SEATED.id, ["chat:participate"]),
    );
    const board = answer.audiences.find((audience) => audience.id === BOARD_ID);

    // Somebody who has just written a post does not have an unread one.
    expect(board?.unread).toBe(3);
    expect(board?.lastPostAt).toBe(
      new Date(Date.UTC(2026, 0, 1, 9)).toISOString(),
    );
  });

  it("counts a board post that names nobody, and nothing not yet shown", async () => {
    /*
     * A board post may have no person on it at all, and "not this person" in
     * SQL is never true of a null - so a count that spelled it as one comparison
     * would leave the board's own notice uncounted for everybody. A post whose
     * instant has not come, or whose news item is down, is in nobody's feed and
     * is new to nobody.
     */
    const { service } = build({
      audiences: [ALL],
      posts: [
        postFixture({
          id: "post-neighbour",
          audienceId: ALL_ID,
          authorPersonId: "person-somebody-else",
          body: "Plommon.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 1)),
        }),
        postFixture({
          id: "post-own",
          audienceId: ALL_ID,
          authorPersonId: RESIDENT.id,
          body: "Min egen.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 2)),
        }),
        postFixture({
          id: "post-board",
          audienceId: ALL_ID,
          authorPersonId: null,
          byBoard: true,
          namesAuthor: false,
          body: null,
          newsId: "news-water",
          createdAt: new Date(Date.UTC(2026, 0, 1, 3)),
        }),
        postFixture({
          id: "post-down",
          audienceId: ALL_ID,
          authorPersonId: null,
          byBoard: true,
          namesAuthor: false,
          body: null,
          newsId: "news-down",
          createdAt: new Date(Date.UTC(2026, 0, 1, 4)),
        }),
        postFixture({
          id: "post-scheduled",
          audienceId: ALL_ID,
          authorPersonId: "person-somebody-else",
          body: "Imorgon.",
          scheduledAt: NOW,
          createdAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        }),
      ],
      news: [
        {
          id: "news-water",
          slug: "vattnet",
          title: "Vattnet",
          published: true,
        },
        { id: "news-down", slug: "nere", title: "Nere", published: false },
      ],
      persons: [RESIDENT],
    });

    const answer = await service.audiences(
      principal(RESIDENT.id, ["chat:participate"]),
    );

    expect(answer.audiences).toEqual([
      {
        id: ALL_ID,
        kind: "ALL",
        name: null,
        unread: 2,
        lastPostAt: new Date(Date.UTC(2026, 0, 1, 3)).toISOString(),
        // Never opened: there is no last visit to measure "new" from.
        readAt: null,
      },
    ]);
  });

  it("counts only what arrived after the marker", async () => {
    const { service } = build({
      audiences: [ALL, BOARD],
      posts: postsOverHours(4, "person-somebody-else"),
      persons: [SEATED],
      reads: [
        {
          audienceId: BOARD_ID,
          personId: SEATED.id,
          readAt: new Date(Date.UTC(2026, 0, 1, 1)),
        },
      ],
    });

    const answer = await service.audiences(
      principal(SEATED.id, ["chat:participate"]),
    );

    const board = answer.audiences.find((audience) => audience.id === BOARD_ID);
    expect(board?.unread).toBe(2);
    // The marker itself, which the screen's "new since your last visit" is
    // drawn from.
    expect(board?.readAt).toBe(new Date(Date.UTC(2026, 0, 1, 1)).toISOString());
  });

  it("never moves backwards", async () => {
    /*
     * Two tabs open on one audience would otherwise un-read each other, and a
     * marker that went backwards would announce posts the person had already
     * read.
     */
    const later = new Date("2026-09-17T08:30:00.000Z");
    const earlier = new Date("2026-09-17T08:00:00.000Z");
    const { service, reads } = build({
      audiences: [ALL, BOARD],
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    await service.markAudienceRead(reader, BOARD_ID, later);
    const answer = await service.markAudienceRead(reader, BOARD_ID, earlier);

    expect(reads).toHaveLength(1);
    expect(reads[0]?.readAt).toEqual(later);
    // And the loser is told the marker that actually stands rather than the
    // instant it sent.
    expect(answer.readAt).toBe(later.toISOString());
  });

  it("never marks further ahead than the server's own clock", async () => {
    /*
     * The marker is forward-only, which is what makes an instant from the future
     * a one-way door: a device with a wrong clock, or a request somebody
     * composed, would set a marker no later call could lower, and from then on
     * every post counts as read for that person - including ones written
     * afterwards. Nothing moves a marker backwards, so there is no repair.
     *
     * Capped at the server's clock instead. A marker can only ever say somebody
     * has read as far as something that already exists.
     */
    const wellPastNow = new Date(NOW.getTime() + 60 * 60 * 1000);
    const { service, reads, posts } = build({
      audiences: [ALL, BOARD],
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const answer = await service.markAudienceRead(
      reader,
      BOARD_ID,
      wellPastNow,
    );

    expect(reads[0]?.readAt).toEqual(NOW);
    expect(answer.readAt).toBe(NOW.toISOString());

    /*
     * Written by somebody else half an hour later: after the marker the cap
     * left, and before the instant the caller asked for. Uncapped, the marker
     * would stand past it and it would count as read.
     */
    const writtenLater = new Date(NOW.getTime() + 30 * 60 * 1000);
    vi.setSystemTime(writtenLater);
    posts.push(
      postFixture({
        id: "post-written-after-the-call",
        audienceId: BOARD_ID,
        authorPersonId: "person-somebody-else",
        body: "Skrivet efter.",
        createdAt: writtenLater,
      }),
    );

    // And the audience is not silently all-read from now on.
    const { audiences } = await service.audiences(reader);
    expect(audiences.find((audience) => audience.id === BOARD_ID)?.unread).toBe(
      1,
    );
  });

  it("marks an instant in the past exactly as it was given", async () => {
    // The cap is a ceiling and not a rewrite: the ordinary case is the newest
    // post on screen, which is always already in the past.
    const { service, reads } = build({
      audiences: [ALL, BOARD],
      persons: [SEATED],
    });
    const shownAt = new Date(Date.now() - 5 * 60 * 1000);

    await service.markAudienceRead(
      principal(SEATED.id, ["chat:participate"]),
      BOARD_ID,
      shownAt,
    );

    expect(reads[0]?.readAt).toEqual(shownAt);
  });

  it("is refused for an audience this person is not in", async () => {
    const { service, reads } = build({
      audiences: [ALL, BOARD],
      persons: [RESIDENT],
    });

    await expect(
      service.markAudienceRead(
        principal(RESIDENT.id, ["chat:participate"]),
        BOARD_ID,
        NOW,
      ),
    ).rejects.toMatchObject({ reason: "audience-not-found" });
    expect(reads).toEqual([]);
  });
});

describe("the read record on a post", () => {
  function onePost() {
    return build({
      audiences: [ALL],
      posts: [
        postFixture({
          id: "post-1",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Vattnet stängs av på torsdag.",
          createdAt: new Date(Date.UTC(2026, 0, 1)),
        }),
      ],
      persons: [SEATED, RESIDENT, { ...RESIDENT, id: "person-eva" }],
    });
  }

  it("is written once, and the first instant stands", async () => {
    // Opening a post twice is having read it once.
    const { service, postReads } = onePost();
    const reader = principal(RESIDENT.id, ["chat:participate"]);

    const first = await service.markPostRead(reader, "post-1");
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const second = await service.markPostRead(reader, "post-1");

    expect(postReads).toEqual([
      { postId: "post-1", personId: RESIDENT.id, readAt: NOW },
    ]);
    expect(first).toEqual({ readBy: 1 });
    expect(second).toEqual({ readBy: 1 });
  });

  it("counts everybody who has opened it", async () => {
    const { service } = onePost();

    await service.markPostRead(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
    );
    const answer = await service.markPostRead(
      principal("person-eva", ["chat:participate"]),
      "post-1",
    );

    expect(answer).toEqual({ readBy: 2 });
  });

  it("is never written for the post's own author", async () => {
    // They wrote it rather than read it, and "Läst av" counts the house.
    const { service, postReads } = onePost();

    const answer = await service.markPostRead(
      principal(SEATED.id, ["chat:participate"]),
      "post-1",
    );

    expect(postReads).toEqual([]);
    expect(answer).toEqual({ readBy: 0 });
  });

  it("is refused for a post this person may not read, and writes nothing", async () => {
    const { service, postReads } = onePost();

    await expect(
      service.markPostRead(
        principal(NO_SEAT.id, ["chat:participate"]),
        "post-1",
      ),
    ).rejects.toMatchObject({ reason: "post-not-found" });
    expect(postReads).toEqual([]);
  });
});

describe("liking a post", () => {
  function onePost() {
    return build({
      audiences: [ALL],
      posts: [
        postFixture({
          id: "post-1",
          audienceId: ALL_ID,
          authorPersonId: SEATED.id,
          body: "Plommon vid grinden.",
          createdAt: new Date(Date.UTC(2026, 0, 1)),
        }),
      ],
      persons: [SEATED, RESIDENT],
      likes: [{ postId: "post-1", personId: "person-somebody-else" }],
    });
  }

  it("likes once however many times it is asked, and counts everybody's", async () => {
    const { service, likes } = onePost();
    const reader = principal(RESIDENT.id, ["chat:participate"]);

    const first = await service.like(reader, "post-1", true);
    const second = await service.like(reader, "post-1", true);

    expect(first).toEqual({ liked: true, likes: 2 });
    expect(second).toEqual({ liked: true, likes: 2 });
    expect(likes.filter((like) => like.personId === RESIDENT.id)).toHaveLength(
      1,
    );
  });

  it("takes the like back, and taking it back twice is taking it back once", async () => {
    const { service, likes } = onePost();
    const reader = principal(RESIDENT.id, ["chat:participate"]);

    await service.like(reader, "post-1", true);
    const first = await service.like(reader, "post-1", false);
    const second = await service.like(reader, "post-1", false);

    expect(first).toEqual({ liked: false, likes: 1 });
    expect(second).toEqual({ liked: false, likes: 1 });
    // Only this reader's own like went.
    expect(likes).toEqual([
      { postId: "post-1", personId: "person-somebody-else" },
    ]);
  });

  it("is refused for a post this person may not read", async () => {
    const { service, likes } = onePost();

    await expect(
      service.like(principal(NO_SEAT.id, ["chat:participate"]), "post-1", true),
    ).rejects.toMatchObject({ reason: "post-not-found" });
    expect(likes).toHaveLength(1);
  });
});

describe("an erased post", () => {
  /*
   * A resident's post whose year ran out while a comment under it had not. The
   * purge took its author and its text; the row is the place the comments
   * still answer, and nothing else.
   */
  const ERASED_AT = new Date(Date.UTC(2026, 0, 2, 3, 47));

  function erased() {
    return build({
      audiences: [ALL],
      posts: [
        postFixture({
          id: "post-erased",
          audienceId: ALL_ID,
          authorPersonId: null,
          body: null,
          createdAt: new Date(Date.UTC(2025, 0, 1)),
          erasedAt: ERASED_AT,
        }),
      ],
      persons: [RESIDENT],
    });
  }
  const reader = principal(RESIDENT.id, ["chat:participate"]);

  it("is shown as erased, naming nobody and taking no comment", async () => {
    const { service } = erased();

    const view = await service.post(reader, "post-erased");

    // Not attributed to the board, which a post naming nobody otherwise is.
    expect(view).toMatchObject({
      author: null,
      byBoard: false,
      body: null,
      erasedAt: ERASED_AT.toISOString(),
      commentsAllowed: false,
    });
  });

  it("refuses a like, and takes nothing when a like is taken back", async () => {
    const { service, likes } = erased();

    await expect(
      service.like(reader, "post-erased", true),
    ).rejects.toMatchObject({ reason: "post-erased", status: 422 });
    await expect(service.like(reader, "post-erased", false)).resolves.toEqual({
      liked: false,
      likes: 0,
    });
    expect(likes).toHaveLength(0);
  });

  it("records nothing when it is opened, and does not refuse it", async () => {
    const { service, postReads } = erased();

    await expect(service.markPostRead(reader, "post-erased")).resolves.toEqual({
      readBy: 0,
    });
    expect(postReads).toHaveLength(0);
  });

  it("is new to nobody", async () => {
    const { service } = erased();

    const answer = await service.audiences(reader);

    expect(
      answer.audiences.find((audience) => audience.id === ALL_ID),
    ).toMatchObject({ unread: 0 });
  });
});

describe("the cursor", () => {
  it("round-trips a post", () => {
    const row = { id: "post-1", createdAt: NOW };

    expect(parseFeedCursor(feedCursor(row))).toEqual({
      createdAt: NOW,
      id: "post-1",
    });
  });

  it.each([
    ["", "empty"],
    ["not-a-cursor", "one half"],
    ["2026-09-17T09:00:00.000Z|post|extra", "a second separator"],
    ["|post-1", "no instant"],
    ["2026-09-17T09:00:00.000Z|", "no identifier"],
    ["2026-09-17|post-1", "a date rather than an instant"],
    ["2026-09-17T09:00:00Z|post-1", "an instant spelled another way"],
    ["not-an-instant|post-1", "a value that is not a moment"],
  ])("refuses %s (%s)", (value) => {
    /*
     * Null rather than a lenient reading, and the controller turns it into a
     * refusal. Answering the newest page to somebody who asked for an older one
     * would tell a reader the feed ends where it does not.
     */
    expect(parseFeedCursor(value)).toBeNull();
  });
});

describe("the guardrail on its own", () => {
  it("permits a post with no personal identity number in it", () => {
    expect(() =>
      refusePersonalIdentityNumbers("Vi far tre offerter pa taket."),
    ).not.toThrow();
  });

  it("permits a post at the cap", () => {
    expect(() =>
      refusePersonalIdentityNumbers("a".repeat(POST_MAX_LENGTH)),
    ).not.toThrow();
  });
});

describe("a group as the audiences endpoint answers it", () => {
  it("offers a group to somebody written down who still lives here", async () => {
    const { service } = build({
      audiences: [ALL, GROUP],
      persons: [RESIDENT],
      groupMembers: [{ audienceId: GROUP_ID, personId: RESIDENT.id }],
    });

    const answer = await service.audiences(
      principal(RESIDENT.id, ["chat:participate"]),
    );

    expect(answer.audiences.map((audience) => audience.kind)).toEqual([
      "ALL",
      "GROUP",
    ]);
    expect(answer.audiences[1]?.name).toBe("Trädgårdsgruppen");
  });

  it("takes the group away the day the residency ends", async () => {
    /*
     * Decided by the register rather than by anybody striking a name off a
     * list: a place in a group ends the day somebody moves out, exactly as a
     * booking allowance bites on the day it says. The row is still there and
     * answers nothing - and with no seat, Alla goes with it.
     */
    const movedOut = {
      ...RESIDENT,
      movedOutOn: new Date("2026-05-01T00:00:00Z"),
    };
    const { service, groupMembers } = build({
      audiences: [ALL, GROUP],
      persons: [movedOut],
      groupMembers: [{ audienceId: GROUP_ID, personId: movedOut.id }],
    });

    const answer = await service.audiences(
      principal(movedOut.id, ["chat:participate"]),
    );

    expect(answer.audiences).toEqual([]);
    expect(groupMembers).toHaveLength(1);
    await expect(
      service.page(
        principal(movedOut.id, ["chat:participate"]),
        query({ audienceId: GROUP_ID }),
      ),
    ).rejects.toMatchObject({ reason: "audience-not-found" });
  });

  it("keeps the group for a move-out date that has not arrived", async () => {
    // The same half of the predicate the seat has, and the same failure if it
    // were dropped: somebody who has given notice still lives here.
    const leaving = {
      ...RESIDENT,
      movedOutOn: new Date("2027-05-01T00:00:00Z"),
    };
    const { service } = build({
      audiences: [ALL, GROUP],
      persons: [leaving],
      groupMembers: [{ audienceId: GROUP_ID, personId: leaving.id }],
    });

    expect(
      (
        await service.audiences(principal(leaving.id, ["chat:participate"]))
      ).audiences.map((audience) => audience.kind),
    ).toEqual(["ALL", "GROUP"]);
  });

  it("says who may make a group, and it is not the administrator", async () => {
    /*
     * No capability answers this: what makes somebody able to start a group is
     * living here. The administrator holds every capability and lives nowhere,
     * so the screen has to be told that the form is not for them rather than
     * left to offer it and be refused.
     */
    const resident = await build({
      persons: [RESIDENT],
    }).service.audiences(principal(RESIDENT.id, ["chat:participate"]));
    const administrator = await build({
      persons: [NO_SEAT],
    }).service.audiences(principal(NO_SEAT.id, ["chat:participate"]));

    expect(resident.mayCreateGroup).toBe(true);
    expect(administrator.mayCreateGroup).toBe(false);
  });
});

describe("a post the board struck through", () => {
  const STRUCK_AT = new Date("2026-03-03T09:00:00.000Z");

  function group() {
    return build({
      audiences: [ALL, BOARD, GROUP],
      posts: [
        postFixture({
          id: "post-1",
          audienceId: GROUP_ID,
          authorPersonId: "person-bo",
          body: "Det har borde ingen lasa.",
          struckAt: STRUCK_AT,
          createdAt: NOW,
        }),
      ],
      persons: [
        RESIDENT,
        SEATED,
        {
          id: "person-bo",
          firstName: "Bo",
          lastName: "Ek",
          protectedPersonalData: false,
          movedOutOn: null,
        },
      ],
      groupMembers: [
        { audienceId: GROUP_ID, personId: RESIDENT.id },
        { audienceId: GROUP_ID, personId: SEATED.id },
        { audienceId: GROUP_ID, personId: "person-bo" },
      ],
    });
  }

  it("withholds the text from the group and keeps the attribution", async () => {
    const { service } = group();

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate"]),
      query({ audienceId: GROUP_ID }),
    );

    // A strike is a strike-through and never a disappearance: the post is
    // still in the group, still attributed, and the date says what happened.
    expect(page.posts[0]?.body).toBeNull();
    expect(page.posts[0]?.struckAt).toBe(STRUCK_AT.toISOString());
    expect(page.posts[0]?.author).toMatchObject({ name: "Bo Ek" });
  });

  it("withholds it on the post's own address too", async () => {
    const { service } = group();

    const post = await service.post(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
    );

    expect(post.body).toBeNull();
  });

  it("shows the text to whoever wrote it", async () => {
    const { service } = group();

    const page = await service.page(
      principal("person-bo", ["chat:participate"]),
      query({ audienceId: GROUP_ID }),
    );

    expect(page.posts[0]?.body).toBe("Det har borde ingen lasa.");
  });

  it("shows the text to a board member who moderates", async () => {
    /*
     * The board reads the post in the queue it was reported into, and reads it
     * here too - a board member who is in the group would otherwise be shown a
     * withheld post they had just decided about.
     */
    const { service } = group();

    const post = await service.post(
      principal(SEATED.id, ["chat:participate", "chat:moderate"]),
      "post-1",
    );

    expect(post.body).toBe("Det har borde ingen lasa.");
  });

  it("withholds the text from the capability without a seat", async () => {
    // An administrator holds every capability, and one who lives here and
    // is in the group is not the board (ADR 0012).
    const { service } = group();

    const page = await service.page(
      principal(RESIDENT.id, ["chat:participate", "chat:moderate"]),
      query({ audienceId: GROUP_ID }),
    );

    expect(page.posts[0]?.body).toBeNull();
  });

  it("withholds the text from a seat without the capability", async () => {
    // Both halves, as the report queue asks them: the seat alone is a board
    // member reading as a neighbour.
    const { service } = group();

    const page = await service.page(
      principal(SEATED.id, ["chat:participate"]),
      query({ audienceId: GROUP_ID }),
    );

    expect(page.posts[0]?.body).toBeNull();
  });
});

describe("what a reader may do with a post", () => {
  const EDITED_AT = new Date("2026-09-10T09:00:00.000Z");

  function house(posts: PostFixture[], issues: IssueFixture[] = []) {
    return build({
      audiences: [ALL, BOARD],
      posts,
      issues,
      persons: [SEATED, RESIDENT, { ...RESIDENT, id: "person-bo" }],
    });
  }

  function resident(fields: Partial<PostFixture> = {}): PostFixture {
    return postFixture({
      id: "post-1",
      audienceId: ALL_ID,
      authorPersonId: RESIDENT.id,
      body: "Hissen står still igen.",
      createdAt: new Date(Date.UTC(2026, 0, 1)),
      ...fields,
    });
  }

  it("lets the author edit their own post, and nobody else", async () => {
    const { service } = house([resident()]);

    const own = await service.post(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
    );
    const board = await service.post(
      principal(SEATED.id, ["chat:participate", "chat:moderate"]),
      "post-1",
    );

    expect(own.mayEdit).toBe(true);
    expect(board.mayEdit).toBe(false);
  });

  it("does not offer an edit of a struck post or of one written as Styrelsen", async () => {
    const { service } = house([
      resident({ struckAt: EDITED_AT }),
      resident({
        id: "post-2",
        authorPersonId: SEATED.id,
        byBoard: true,
      }),
    ]);

    const struck = await service.post(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
    );
    const asBoard = await service.post(
      principal(SEATED.id, ["chat:participate"]),
      "post-2",
    );

    expect(struck.mayEdit).toBe(false);
    expect(asBoard.mayEdit).toBe(false);
  });

  it("opens an edited post's history to its author and the board only", async () => {
    const { service } = house([resident({ editedAt: EDITED_AT })]);

    const author = await service.post(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
    );
    const board = await service.post(
      principal(SEATED.id, ["chat:participate", "chat:moderate"]),
      "post-1",
    );
    const seatWithoutCapability = await service.post(
      principal(SEATED.id, ["chat:participate"]),
      "post-1",
    );

    expect(author.mayReadHistory).toBe(true);
    expect(board.mayReadHistory).toBe(true);
    expect(seatWithoutCapability.mayReadHistory).toBe(false);
  });

  it("offers the must-read list on an important post to the board alone", async () => {
    const { service } = house([
      resident({
        authorPersonId: SEATED.id,
        byBoard: true,
        important: true,
      }),
    ]);

    const board = await service.post(
      principal(SEATED.id, ["chat:participate", "chat:moderate"]),
      "post-1",
    );
    const neighbour = await service.post(
      principal(RESIDENT.id, ["chat:participate", "chat:moderate"]),
      "post-1",
    );

    expect(board.mayListNotRead).toBe(true);
    // An account holding the capability and no seat is not the board.
    expect(neighbour.mayListNotRead).toBe(false);
  });

  it("offers an issue report to the author and the board, not to a neighbour", async () => {
    const { service } = house([resident()]);
    const reports: Capability[] = ["chat:participate", "issues:report"];

    const author = await service.post(
      principal(RESIDENT.id, reports),
      "post-1",
    );
    const board = await service.post(principal(SEATED.id, reports), "post-1");
    const neighbour = await service.post(
      principal("person-bo", reports),
      "post-1",
    );
    const withoutCapability = await service.post(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
    );

    expect(author.mayReportIssue).toBe(true);
    expect(board.mayReportIssue).toBe(true);
    expect(neighbour.mayReportIssue).toBe(false);
    expect(withoutCapability.mayReportIssue).toBe(false);
  });

  it("shows a report's status to its reporter and whoever handles issues, and offers no second report", async () => {
    const { service } = house(
      [resident({ issueId: "issue-1" })],
      [{ id: "issue-1", status: "IN_PROGRESS", reporterPersonId: SEATED.id }],
    );

    const reporter = await service.post(
      principal(SEATED.id, ["chat:participate", "issues:report"]),
      "post-1",
    );
    const handler = await service.post(
      principal("person-bo", ["chat:participate", "issues:handle"]),
      "post-1",
    );
    const author = await service.post(
      principal(RESIDENT.id, ["chat:participate", "issues:report"]),
      "post-1",
    );

    expect(reporter.issue).toEqual({ id: "issue-1", status: "IN_PROGRESS" });
    expect(handler.issue).toEqual({ id: "issue-1", status: "IN_PROGRESS" });
    // The post's author did not make the report and does not handle issues:
    // the report is not theirs to read, and one has been made.
    expect(author.issue).toBeNull();
    expect(author.mayReportIssue).toBe(false);
    expect(reporter.mayReportIssue).toBe(false);
  });
});

describe("editing a post", () => {
  const WRITTEN = new Date(Date.UTC(2026, 0, 1));

  function onePost(fields: Partial<PostFixture> = {}) {
    return build({
      audiences: [ALL, BOARD],
      posts: [
        postFixture({
          id: "post-1",
          audienceId: ALL_ID,
          authorPersonId: RESIDENT.id,
          body: "Städdag på lördag.",
          createdAt: WRITTEN,
          ...fields,
        }),
      ],
      persons: [SEATED, RESIDENT],
    });
  }

  it("keeps the text that stood, and says the post was edited", async () => {
    const { service, revisions } = onePost();
    const author = principal(RESIDENT.id, ["chat:participate"]);

    const edited = await service.edit(author, "post-1", "Städdag på söndag.");

    expect(edited.body).toBe("Städdag på söndag.");
    expect(edited.editedAt).toBe(NOW.toISOString());
    expect(revisions).toEqual([
      {
        postId: "post-1",
        body: "Städdag på lördag.",
        writtenAt: WRITTEN,
        replacedAt: NOW,
      },
    ]);
  });

  it("dates a second version from the edit that wrote it", async () => {
    const earlier = new Date("2026-09-01T09:00:00.000Z");
    const { service, revisions } = onePost({ editedAt: earlier });

    await service.edit(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
      "Städdag på söndag.",
    );

    expect(revisions[0]?.writtenAt).toEqual(earlier);
  });

  it("records nothing for text that is what the post already says", async () => {
    const { service, revisions } = onePost();

    const answer = await service.edit(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
      "Städdag på lördag.",
    );

    expect(answer.editedAt).toBeNull();
    expect(revisions).toEqual([]);
  });

  it("is refused to anybody but its author", async () => {
    const { service, revisions } = onePost();

    await expect(
      service.edit(
        principal(SEATED.id, ["chat:participate", "chat:moderate"]),
        "post-1",
        "Inställt.",
      ),
    ).rejects.toMatchObject({ reason: "not-editable" });
    expect(revisions).toEqual([]);
  });

  it("is refused on a struck post", async () => {
    const { service } = onePost({ struckAt: NOW });

    await expect(
      service.edit(
        principal(RESIDENT.id, ["chat:participate"]),
        "post-1",
        "Något annat.",
      ),
    ).rejects.toMatchObject({ reason: "not-editable" });
  });

  it("is refused as a post that does not exist to somebody outside its audience", async () => {
    const { service } = onePost();

    await expect(
      service.edit(
        principal(NO_SEAT.id, ["chat:participate"]),
        "post-1",
        "Något annat.",
      ),
    ).rejects.toMatchObject({ reason: "post-not-found" });
  });

  it("refuses a personal identity number before anything is written", async () => {
    const { service, revisions } = onePost();

    await expect(
      service.edit(
        principal(RESIDENT.id, ["chat:participate"]),
        "post-1",
        `Ring ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}`,
      ),
    ).rejects.toMatchObject({ reason: "personal-identity-number" });
    expect(revisions).toEqual([]);
  });

  it("refuses an edit past the history it keeps", async () => {
    const { service, revisions } = onePost();
    for (let index = 0; index < MAX_REVISIONS; index += 1) {
      revisions.push({
        postId: "post-1",
        body: `Version ${String(index)}`,
        writtenAt: WRITTEN,
        replacedAt: WRITTEN,
      });
    }

    await expect(
      service.edit(
        principal(RESIDENT.id, ["chat:participate"]),
        "post-1",
        "En till.",
      ),
    ).rejects.toMatchObject({ reason: "too-many-edits" });
    expect(revisions).toHaveLength(MAX_REVISIONS);
  });

  it("shows the history to the author and the board, and withholds it from a neighbour", async () => {
    const { service } = onePost();
    await service.edit(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
      "Städdag på söndag.",
    );

    const author = await service.history(
      principal(RESIDENT.id, ["chat:participate"]),
      "post-1",
    );
    const board = await service.history(
      principal(SEATED.id, ["chat:participate", "chat:moderate"]),
      "post-1",
    );

    expect(author.revisions).toEqual([
      {
        body: "Städdag på lördag.",
        writtenAt: WRITTEN.toISOString(),
        replacedAt: NOW.toISOString(),
      },
    ]);
    expect(board).toEqual(author);
    await expect(
      service.history(principal(SEATED.id, ["chat:participate"]), "post-1"),
    ).rejects.toMatchObject({ reason: "history-withheld" });
  });
});
