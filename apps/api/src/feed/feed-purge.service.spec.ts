import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import type { MediaService } from "../media/media.service";
import { FEED_PURGE_QUEUE, FeedPurgeService } from "./feed-purge.service";

/**
 * The things about the feed purge that are decided before any row is touched,
 * and that a database cannot be asked about.
 *
 * Which people a run selects, which is what decides whether every expired post
 * and comment is eventually reached or some are reached never. The bound on a
 * run exists so the first run on a long-lived instance cannot erase a decade in
 * one loop, and it is applied by the database - so anybody excluded after the
 * query has already spent it. Held people excluded afterwards would fill run
 * after run with work that cannot be done, and the posts behind them would
 * outlive their retention window with nothing reporting a fault. That is the
 * failure a count in a summary looks fine through, which is why it is asserted
 * here.
 *
 * That the hold is read under the lock rather than beside it. Both are ordinary
 * awaits on the transaction client, so nothing about the source says which came
 * first; the order is the whole of the guarantee, and the only way to state it
 * is to record the calls and read them back.
 *
 * What one person's erasure takes. A post written as Styrelsen is a news item
 * and is never on this clock, however old; a resident's post goes with what hung
 * on its text, and never with a comment somebody else wrote under it: that is
 * the other writer's data, on their own clock and under their own hold, so the
 * post is erased and its row kept until the last of them has gone (ADR 0026).
 *
 * And what the audit entry may carry. This is the only entry the feed writes for
 * a post at all - writing one writes none - so it is the log's whole account of
 * what somebody wrote, and it must name the person and the counts and not a
 * word of what was said: the table is append-only and exempt from every purge,
 * so text copied in here would outlive the rows the entry says were erased.
 *
 * This purge replaced two, the chat's and the news comments', and asserts what
 * both of theirs did. The window arithmetic is `feed-retention.spec.ts`, and
 * what actually happens to the rows is `feed.int-spec.ts` and
 * `group.int-spec.ts`.
 */

const RETENTION_DAYS = 365;
const NOW = new Date("2027-06-01T03:47:00.000Z");

/**
 * A post's text, as a database failure would quote it back.
 *
 * Stood in for a real one so the assertion that it does not reach the log has
 * something to look for.
 */
const REVEALING_BODY = "Vi bor saga upp vicevarden i 1202";

/** How many people one run may take, mirrored from the service. */
const MAX_PERSONS_PER_RUN = 500;

/** Long enough ago that the window has run out. */
const EXPIRED = new Date("2025-01-01T10:00:00.000Z");

/** The day before the run: a year short of erasable. */
const YESTERDAY = new Date("2027-05-31T10:00:00.000Z");

interface Post {
  id: string;
  /** Null only on a post written as Styrelsen that names nobody. */
  authorPersonId: string | null;
  byBoard: boolean;
  createdAt: Date;
  /** Set once the purge has erased it and kept the row for its comments. */
  erasedAt: Date | null;
}

interface Comment {
  id: string;
  postId: string;
  authorPersonId: string;
  createdAt: Date;
}

/** What else the feed holds of one person, as the deletes on a request find it. */
interface Traces {
  memberships: number;
  readMarkers: number;
  postReads: number;
  postLikes: number;
  commentLikes: number;
  reports: number;
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
 * Strict rather than lenient: a column the row does not have, or an operator
 * this does not know, throws rather than matching. A fake that quietly ignored
 * a condition it did not understand would let the service drop exactly that
 * condition - `byBoard: false`, say - and every test here would still pass.
 */
function matches(row: object, where: Where): boolean {
  const columns = row as Record<string, unknown>;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      return (condition as Where[]).some((branch) => matches(row, branch));
    }
    if (!(key in columns)) {
      throw new Error(`The fake has no column ${key}.`);
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
        case "in":
          return (operand as unknown[]).includes(value);
        case "notIn":
          return !(operand as unknown[]).includes(value);
        case "lte":
          return compare(value, operand) <= 0;
        case "gt":
          return compare(value, operand) > 0;
        default:
          throw new Error(`The fake does not answer ${key}.${operator}.`);
      }
    });
  });
}

/** Takes every row matching a filter out of a table, and answers how many. */
function deleteWhere<Row extends object>(rows: Row[], where: Where): number {
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && matches(row, where)) {
      rows.splice(index, 1);
      count += 1;
    }
  }
  return count;
}

/**
 * A database holding these posts, comments and open holds.
 *
 * `groupBy`, the reads and the deletes are implemented against the rows rather
 * than stubbed with an answer, because the property under test is what the
 * service asks of them: a fake that returned a fixed list would pass whatever
 * the query said. So this one honours the `createdAt` filter, the `byBoard`
 * condition, the `notIn` exclusion, the sort and the bound, which is exactly
 * the contract the real one is being relied on for - and a delete takes the
 * rows its filter names and no others, so a post written as Styrelsen that the
 * filter let through would be gone from the fixture afterwards.
 */
function build(options: {
  posts?: Post[];
  comments?: Comment[];
  heldPersonIds?: string[];
  restrictedPersonIds?: string[];
  erasureRequestedPersonIds?: string[];
  /**
   * The rows go between the scan and the transaction: the last of somebody's
   * posts and comments was taken by something else while the run was in
   * flight. The branch a database cannot be asked to produce on demand.
   */
  goneBeforeErasure?: boolean;
  /** What else the feed holds of each person, for a granted request to take. */
  traces?: Record<string, Partial<Traces>>;
  /**
   * The audiences this database holds.
   *
   * Of every kind, and each with however many posts are in it, because the
   * sweep asks for exactly those two things beside the date: a fake holding
   * only empty groups would pass a sweep that had dropped either condition and
   * taken Styrelsen, Alla or a group somebody is writing in.
   */
  audiences?: {
    id: string;
    kind: "ALL" | "BOARD" | "GROUP";
    createdAt: Date;
    posts?: number;
  }[];
  /** Write into this audience the moment the sweep takes its lock. */
  writtenInOnLock?: string;
  /** The audience whose delete the database refuses, every time it is tried. */
  refusedAudienceId?: string;
  /** Places in a group held by people who no longer live here. */
  formerMembers?: { audienceId: string; personId: string }[];
  /** The people whose place the database refuses to delete, every time. */
  refusedMemberPersonIds?: string[];
  /**
   * The person whose move-in commits the moment the sweep takes their
   * residency key: the move-in held it, and the sweep waited for it.
   */
  movesBackInOnLock?: string;
  /** Images on posts: which file is on which post. */
  images?: { postId: string; fileId: string }[];
  /**
   * Files held POST, with when they were uploaded and by whom. One no image
   * names is an upload that never went on a post.
   */
  files?: {
    id: string;
    createdAt: Date;
    uploadedByPersonId?: string | null;
  }[];
  /** The files whose removal fails, every time it is tried. */
  refusedFileIds?: string[];
  /**
   * The person a hold comes to stand over the moment somebody takes their
   * legal hold key: the placement held it, and whoever wanted it waited for
   * the placement to commit.
   */
  heldOnLock?: string;
}) {
  const images = [...(options.images ?? [])];
  const files = (options.files ?? []).map((file) => ({
    uploadedByPersonId: null,
    ...file,
  }));
  const posts = [...(options.posts ?? [])];
  const comments = [...(options.comments ?? [])];
  const held = options.heldPersonIds ?? [];
  const restricted = options.restrictedPersonIds ?? [];
  const requested = options.erasureRequestedPersonIds ?? [];
  const withheld = [...new Set([...held, ...restricted])];
  const traces = options.traces ?? {};
  const audiences = (options.audiences ?? []).map((audience) => ({
    posts: 0,
    ...audience,
  }));
  /** Who holds a residency today, as the transaction reads it. */
  const residents = new Set<string>();

  /**
   * One person reference per author, as the database groups them: sorted, and
   * cut to the bound after the filter rather than before it.
   */
  function groupByAuthor(rows: readonly (Post | Comment)[]) {
    return vi.fn(
      async (args: { by: ["authorPersonId"]; where: Where; take: number }) => {
        const ids = [
          ...new Set(
            rows
              .filter((row) => matches(row, args.where))
              .map((row) => row.authorPersonId),
          ),
        ]
          .sort((a, b) =>
            a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0,
          )
          .slice(0, args.take);
        return ids.map((authorPersonId) => ({ authorPersonId }));
      },
    );
  }
  const postGroupBy = groupByAuthor(posts);
  const commentGroupBy = groupByAuthor(comments);

  /** Every call the transaction made, in the order it made them. */
  const calls: string[] = [];

  /** Every advisory lock key the sweep took, in order. */
  const locks: string[] = [];

  /** The count a trace delete reports, for the person its filter names. */
  function traceCount(where: Where, kind: keyof Traces): number {
    const personId = (where.personId ?? where.reporterPersonId) as string;
    return traces[personId]?.[kind] ?? 0;
  }

  const tx = {
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        void strings;
        const key = String(values[0]);
        if (key.startsWith("audience:")) {
          calls.push("lockAudience");
          locks.push(key);
          /*
           * Somebody writing in the group while the sweep waited for the lock.
           * It is the only moment a group can stop being empty, because the
           * delete below re-reads it under the same key.
           */
          const written = audiences.find(
            (audience) => audience.id === options.writtenInOnLock,
          );
          if (written !== undefined) {
            written.posts += 1;
          }
          return 1;
        }
        const movesBackIn = options.movesBackInOnLock;
        if (movesBackIn !== undefined && key === `residency:${movesBackIn}`) {
          residents.add(movesBackIn);
        }
        const heldOnLock = options.heldOnLock;
        if (heldOnLock !== undefined && key === `legal-hold:${heldOnLock}`) {
          withheld.push(heldOnLock);
        }
        // The namespace of the key, so the order the keys are taken in is
        // what is asserted.
        calls.push(`lock:${key.split(":")[0] ?? key}`);
        return 1;
      },
    ),
    residency: {
      findFirst: vi.fn(async (args: { where: { personId: string } }) => {
        calls.push("readResidency");
        return residents.has(args.where.personId) ? { id: "res-1" } : null;
      }),
    },
    groupMember: {
      deleteMany: vi.fn(
        async (args: { where: { audienceId?: string; personId: string } }) => {
          if (options.refusedMemberPersonIds?.includes(args.where.personId)) {
            throw new Error("refused");
          }
          calls.push("deleteMember");
          // One place, taken from a former resident; or every place, on a
          // granted request.
          return {
            count:
              args.where.audienceId === undefined
                ? traceCount(args.where, "memberships")
                : 1,
          };
        },
      ),
    },
    audienceRead: {
      deleteMany: vi.fn(
        async (args: { where: { audienceId?: string; personId: string } }) => {
          calls.push("deleteReadMarkers");
          return {
            count:
              args.where.audienceId === undefined
                ? traceCount(args.where, "readMarkers")
                : 1,
          };
        },
      ),
    },
    /*
     * Each of these is deleted two ways: what one person holds, on a granted
     * request, and what hung on the text of posts being erased. Told apart by
     * the filter, because the second goes on the window and the first never
     * does.
     */
    postRead: {
      deleteMany: vi.fn(async (args: { where: Where }) => {
        if (args.where.postId !== undefined) {
          calls.push("deleteReadsOnPosts");
          return { count: 0 };
        }
        calls.push("deletePostReads");
        return { count: traceCount(args.where, "postReads") };
      }),
    },
    postLike: {
      deleteMany: vi.fn(async (args: { where: Where }) => {
        if (args.where.postId !== undefined) {
          calls.push("deleteLikesOnPosts");
          return { count: 0 };
        }
        calls.push("deletePostLikes");
        return { count: traceCount(args.where, "postLikes") };
      }),
    },
    postCommentLike: {
      deleteMany: vi.fn(async (args: { where: Where }) => {
        calls.push("deleteCommentLikes");
        return { count: traceCount(args.where, "commentLikes") };
      }),
    },
    postReport: {
      deleteMany: vi.fn(async (args: { where: Where }) => {
        if (args.where.postId !== undefined) {
          calls.push("deleteReportsOnPosts");
          return { count: 0 };
        }
        calls.push("deleteReports");
        return { count: traceCount(args.where, "reports") };
      }),
    },
    person: {
      findMany: vi.fn(async (args: { where: { id: string } }) => {
        calls.push("readWithheld");
        return withheld.includes(args.where.id) ? [{ id: args.where.id }] : [];
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        calls.push("readRestriction");
        return {
          processingRestrictedAt: restricted.includes(args.where.id)
            ? new Date("2027-05-01T00:00:00.000Z")
            : null,
        };
      }),
    },
    dataSubjectRequest: {
      findFirst: vi.fn(async (args: { where: { personId: string } }) => {
        calls.push("readRequest");
        return requested.includes(args.where.personId) ? { id: "req-1" } : null;
      }),
    },
    legalHold: {
      findFirst: vi.fn(async () => {
        calls.push("readHold");
        return held.length > 0 ? { id: "hold-1" } : null;
      }),
    },
    post: {
      findMany: vi.fn(async (args: { where: Where }) => {
        calls.push("findPosts");
        return posts
          .filter((post) => matches(post, args.where))
          .map((post) => ({ id: post.id }));
      }),
      /*
       * The erasure: the author's part off the row, which stays. Applied to the
       * rows the filter names, so a post the filter let through would show as
       * erased afterwards.
       */
      updateMany: vi.fn(
        async (args: { where: Where; data: Record<string, unknown> }) => {
          calls.push("erasePosts");
          const erased = posts.filter((post) => matches(post, args.where));
          for (const post of erased) {
            Object.assign(post, args.data);
          }
          return { count: erased.length };
        },
      ),
      deleteMany: vi.fn(async (args: { where: Where }) => {
        /*
         * A comment's key to its post refuses a cascade, so a post with a
         * comment still under it is refused here as the database refuses it.
         * The service asks for the posts with none under them, and a fake that
         * ignored that condition would delete the ones it has to keep.
         */
        const { comments: under, ...where } = args.where as Where & {
          comments?: { none: object };
        };
        const answered = (post: Post) =>
          comments.some((comment) => comment.postId === post.id);
        const doomed = posts.filter(
          (post) =>
            matches(post, where) && (under === undefined || !answered(post)),
        );
        if (doomed.some(answered)) {
          throw new Error("violates foreign key constraint on post_comment");
        }
        calls.push("deletePosts");
        for (const post of doomed) {
          posts.splice(posts.indexOf(post), 1);
        }
        return { count: doomed.length };
      }),
    },
    postComment: {
      deleteMany: vi.fn(async (args: { where: Where }) => {
        calls.push("deleteComments");
        return { count: deleteWhere(comments, args.where) };
      }),
      count: vi.fn(async (args: { where: Where }) => {
        calls.push("countCommentsUnderPosts");
        return comments.filter((comment) => matches(comment, args.where))
          .length;
      }),
    },
    postRevision: {
      deleteMany: vi.fn(async () => {
        calls.push("deleteRevisions");
        return { count: 0 };
      }),
    },
    /*
     * Not recorded in `calls`: where the images are read and deleted among the
     * rest of what hangs on a post is not an ordering anything depends on, and
     * the order the other cases assert is the one that is.
     */
    postImage: {
      findMany: vi.fn(async (args: { where: Where }) =>
        images
          .filter((image) => matches(image, args.where))
          .map((image) => ({ fileId: image.fileId })),
      ),
      deleteMany: vi.fn(async (args: { where: Where }) => ({
        count: deleteWhere(images, args.where),
      })),
      count: vi.fn(async (args: { where: { fileId: string } }) => {
        calls.push("readImageOnPost");
        return images.filter((image) => image.fileId === args.where.fileId)
          .length;
      }),
    },
    audience: {
      /*
       * The delete repeats every condition the scan used, and so does this: the
       * lock above it is only worth taking if what the scan found is checked
       * again under it, and a fake that deleted by identifier alone would let
       * that re-check be dropped without a test noticing.
       */
      deleteMany: vi.fn(
        async (args: {
          where: {
            id: string;
            kind: "GROUP";
            createdAt: { lte: Date };
            posts: { none: object };
          };
        }) => {
          calls.push("deleteGroups");
          if (args.where.id === options.refusedAudienceId) {
            throw new Error(`the database refused ${args.where.id}`);
          }
          const index = audiences.findIndex(
            (audience) =>
              audience.id === args.where.id &&
              audience.kind === args.where.kind &&
              audience.posts === 0 &&
              args.where.posts.none !== undefined &&
              audience.createdAt.getTime() <=
                args.where.createdAt.lte.getTime(),
          );
          if (index < 0) {
            return { count: 0 };
          }
          audiences.splice(index, 1);
          return { count: 1 };
        },
      ),
    },
  };

  const prisma = {
    /*
     * The sweep for uploads on no post, answered from the rows: a fake that
     * took every POST file would pass a sweep that had dropped either the
     * "on no post" condition, the age or the uploaders it leaves out.
     */
    mediaFile: {
      findMany: vi.fn(
        async (args: {
          where: {
            visibility: "POST";
            postImage: null;
            createdAt: { lt: Date };
            OR?: (
              | { uploadedByPersonId: null }
              | { uploadedByPersonId: { notIn: string[] } }
            )[];
          };
          take: number;
        }) =>
          files
            .filter(
              (file) =>
                args.where.visibility === "POST" &&
                args.where.postImage === null &&
                !images.some((image) => image.fileId === file.id) &&
                file.createdAt.getTime() < args.where.createdAt.lt.getTime() &&
                (args.where.OR === undefined ||
                  args.where.OR.some((either) =>
                    either.uploadedByPersonId === null
                      ? file.uploadedByPersonId === null
                      : file.uploadedByPersonId !== null &&
                        !either.uploadedByPersonId.notIn.includes(
                          file.uploadedByPersonId,
                        ),
                  )),
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, args.take)
            .map((file) => ({ id: file.id })),
      ),
    },
    post: {
      groupBy: postGroupBy,
      /*
       * The sweep for an erased post nothing stands under any more. Answered
       * from the rows: a fake that took every erased post would pass a sweep
       * that had dropped the condition and taken comments' places from under
       * them.
       */
      deleteMany: vi.fn(
        async (args: {
          where: { erasedAt: { not: null }; comments: { none: object } };
        }) => {
          const empty = posts.filter(
            (post) =>
              post.erasedAt !== null &&
              args.where.erasedAt.not === null &&
              args.where.comments.none !== undefined &&
              !comments.some((comment) => comment.postId === post.id),
          );
          for (const post of empty) {
            posts.splice(posts.indexOf(post), 1);
          }
          return { count: empty.length };
        },
      ),
    },
    postComment: { groupBy: commentGroupBy },
    /*
     * The sweep for a group that holds nothing. Implemented rather than stubbed,
     * because what it asks is the whole of the rule: a group made recently is
     * one waiting to be written in, and only the cutoff tells the two apart.
     */
    audience: {
      findMany: vi.fn(
        async (args: {
          where: {
            kind: "GROUP";
            createdAt: { lte: Date };
            posts: { none: object };
          };
          take?: number;
        }) =>
          audiences
            .filter(
              (audience) =>
                audience.kind === args.where.kind &&
                // Answered from the rows rather than assumed: the sweep asks
                // for a group with no post in it, and a fake that ignored
                // that would answer with groups people are writing in.
                (args.where.posts.none === undefined || audience.posts === 0) &&
                audience.createdAt.getTime() <=
                  args.where.createdAt.lte.getTime(),
            )
            .slice(0, args.take)
            .map((audience) => ({ id: audience.id })),
      ),
    },
    person: {
      findMany: vi.fn(
        async (args: {
          where: {
            OR?: unknown[];
            dataSubjectRequests?: unknown;
            residencies?: unknown;
          };
        }) =>
          // The questions the run asks of the register, told apart by their
          // shape: a hold or a restriction, a granted erasure request, and
          // who lives here - nobody in this fake holds a place in a group, so
          // the last is answered with nobody.
          (args.where.dataSubjectRequests !== undefined
            ? requested
            : args.where.residencies !== undefined
              ? []
              : withheld
          ).map((id) => ({ id })),
      ),
    },
    groupMember: {
      /*
       * Paged as the database pages it, by the key and the bound: a fake that
       * answered every page with every row would never tell a sweep that reads
       * past its first page from one that does not.
       */
      findMany: vi.fn(async (args: { where: Where; take: number }) =>
        [...(options.formerMembers ?? [])]
          .sort(
            (a, b) =>
              a.audienceId.localeCompare(b.audienceId) ||
              a.personId.localeCompare(b.personId),
          )
          .filter((place) => matches(place, args.where))
          .slice(0, args.take),
      ),
    },
    legalHold: {
      findMany: vi.fn(async () => held.map((personId) => ({ personId }))),
    },
    $transaction: vi.fn(
      async (run: (client: typeof tx) => Promise<unknown>) => {
        if (options.goneBeforeErasure === true) {
          posts.length = 0;
          comments.length = 0;
        }
        return run(tx);
      },
    ),
  };

  const audit = {
    record: vi.fn(
      async (_entry: {
        action?: string;
        targetPersonId?: string | null;
        context?: Record<string, unknown>;
      }) => undefined,
    ),
  };

  /*
   * The media layer, whose removal is the row and then the bytes. Recorded so a
   * case can say which files went and when, and refusing the files a case
   * names, as a database that would not delete the row would.
   *
   * It asks the caller's `keep` on the transaction client before the row
   * goes, as the real one does, so what the purge reads there - the hold key,
   * the hold, the image row - is read where the deletion is decided. A file
   * whose row is already gone has been removed by somebody else, and its id is
   * named as `removeFile` only once it has actually gone.
   */
  const media = {
    remove: vi.fn(
      async (
        fileId: string,
        _actor: string | null,
        _channel: string,
        removal: {
          recordFileName?: boolean;
          keep?: (
            client: typeof tx,
            file: {
              id: string;
              visibility: "POST";
              uploadedByPersonId: string | null;
              createdAt: Date;
            },
          ) => Promise<boolean>;
        } = {},
      ) => {
        if (options.refusedFileIds?.includes(fileId)) {
          throw new Error(`the database refused ${fileId}`);
        }
        const file = files.find((each) => each.id === fileId);
        if (
          removal.keep !== undefined &&
          (await removal.keep(tx, {
            id: fileId,
            visibility: "POST",
            uploadedByPersonId: file?.uploadedByPersonId ?? null,
            createdAt: file?.createdAt ?? NOW,
          }))
        ) {
          calls.push(`keepFile:${fileId}`);
          return false;
        }
        calls.push(`removeFile:${fileId}`);
        files.splice(
          files.findIndex((each) => each.id === fileId),
          file === undefined ? 0 : 1,
        );
        deleteWhere(images, { fileId });
        return true;
      },
    ),
  };

  const jobs = {
    instance: { unschedule: vi.fn(async (_name: string) => undefined) },
    work: vi.fn(async (_name: string, _handler: () => Promise<void>) => {}),
    schedule: vi.fn(
      async (_name: string, _cron: string, _data: object) => undefined,
    ),
  };

  return {
    service: new FeedPurgeService(
      { NODE_ENV: "test" } as Env,
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      jobs as unknown as JobQueueService,
      media as unknown as MediaService,
    ),
    prisma,
    audit,
    jobs,
    media,
    images,
    files,
    calls,
    postGroupBy,
    commentGroupBy,
    posts,
    comments,
    audiences,
    locks,
    deletePosts: tx.post.deleteMany,
    erasePosts: tx.post.updateMany,
    deleteComments: tx.postComment.deleteMany,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A resident's post, written long enough ago to be erasable. */
function expiredPostBy(authorPersonId: string): Post {
  return {
    id: `post-${authorPersonId}`,
    authorPersonId,
    byBoard: false,
    createdAt: EXPIRED,
    erasedAt: null,
  };
}

/** A comment, written long enough ago to be erasable, under somebody's post. */
function expiredCommentBy(authorPersonId: string, postId: string): Comment {
  return {
    id: `comment-${authorPersonId}`,
    postId,
    authorPersonId,
    createdAt: EXPIRED,
  };
}

/** A post written as Styrelsen, which is a news item and on no clock here. */
const BOARD_POST: Post = {
  id: "post-board",
  authorPersonId: "astrid",
  byBoard: true,
  createdAt: EXPIRED,
  erasedAt: null,
};

/** Every advisory lock `purgePerson` takes, before it reads anything. */
const PURGE_LOCKS = [
  "lock:legal-hold",
  "lock:residency",
  "lock:board-position",
  "lock:system-role",
  "lock:system-role",
];

describe("choosing who a run erases for", () => {
  it("leaves out the people a legal hold stands against", async () => {
    const { service } = build({
      posts: [expiredPostBy("aa"), expiredPostBy("bb")],
      heldPersonIds: ["aa"],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "bb",
    ]);
  });

  it("tells a hold, a restriction and a granted erasure apart", async () => {
    /*
     * The three arms of the scan in one run. A hold and a restriction withhold
     * the person however old their rows are; a granted erasure reaches them
     * however recent, because bringing the purge forward is what the board
     * granted. Asserted together because the query tells the three apart by
     * shape, and one of them silently answering for another is exactly what
     * would not show up in a test that exercised only two.
     */
    const { service } = build({
      posts: [
        expiredPostBy("held"),
        expiredPostBy("restricted"),
        // Written an hour before the run, and erasable all the same.
        {
          id: "post-requested",
          authorPersonId: "requested",
          byBoard: false,
          createdAt: new Date("2027-06-01T02:47:00.000Z"),
          erasedAt: null,
        },
      ],
      heldPersonIds: ["held"],
      restrictedPersonIds: ["restricted"],
      erasureRequestedPersonIds: ["requested"],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "requested",
    ]);
  });

  it("leaves out posts and comments whose window has not run out", async () => {
    const { service } = build({
      posts: [
        expiredPostBy("aa"),
        { ...expiredPostBy("bb"), createdAt: YESTERDAY },
      ],
      comments: [
        { ...expiredCommentBy("cc", "post-aa"), createdAt: YESTERDAY },
      ],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "aa",
    ]);
  });

  it("reaches somebody whose only expired row is a comment", async () => {
    // The news thread's purge, which this one took over: a resident who never
    // posted and answered a notice a year ago is on the same clock.
    const { service } = build({
      posts: [BOARD_POST],
      comments: [expiredCommentBy("cc", BOARD_POST.id)],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "cc",
    ]);
  });

  it("never selects somebody for a post written as Styrelsen", async () => {
    /*
     * A board post is a news item and goes when the item goes (ADR 0026). Its
     * writer is a person reference on the row, so a scan that forgot the
     * difference would select them a year after the notice and erase the
     * notice out of the feed.
     */
    const { service, postGroupBy } = build({ posts: [BOARD_POST] });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([]);
    expect(postGroupBy.mock.calls[0]?.[0].where).toMatchObject({
      byBoard: false,
    });
  });

  it("reaches people behind a run's worth of held people", async () => {
    /*
     * The starvation case, and the reason the holds are excluded by the query
     * rather than dropped from its answer.
     *
     * The bound is applied by the database, so a person removed afterwards has
     * still spent one of the five hundred places. Fill every place with held
     * people sorting first - `held-...` before `zz` - and a run that filters
     * afterwards selects five hundred people it may not touch, erases nothing,
     * and does exactly the same thing every night the holds stand. The summary
     * reports five hundred considered and none purged, which reads like a quiet
     * night, while `zz`'s posts sit years past the date this product told them
     * they would be erased on.
     */
    const heldPersonIds = Array.from(
      { length: MAX_PERSONS_PER_RUN },
      (_unused, index) => `held-${String(index).padStart(4, "0")}`,
    );
    const { service } = build({
      posts: [...heldPersonIds.map(expiredPostBy), expiredPostBy("zz")],
      comments: heldPersonIds.map((personId) =>
        expiredCommentBy(personId, "post-zz"),
      ),
      heldPersonIds,
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "zz",
    ]);
  });

  it("takes the first people by identifier, whichever table their expiry is in", async () => {
    /*
     * Each table is bounded on its own and the union is cut to the bound again.
     * Somebody whose only expired row is a comment, sorting ahead of a run's
     * worth of people with expired posts, is in this run and not pushed behind
     * them - and the run is still no longer than the bound.
     */
    const postPersonIds = Array.from(
      { length: MAX_PERSONS_PER_RUN },
      (_unused, index) => `bb-${String(index).padStart(4, "0")}`,
    );
    const { service } = build({
      posts: postPersonIds.map(expiredPostBy),
      comments: [expiredCommentBy("aa", "post-bb-0000")],
    });

    const eligible = await service.eligible(NOW, RETENTION_DAYS);

    expect(eligible[0]).toBe("aa");
    expect(eligible).toHaveLength(MAX_PERSONS_PER_RUN);
    expect(eligible).not.toContain(postPersonIds[postPersonIds.length - 1]);
  });

  it("reaches a person a granted request names from behind a run's worth of expiries", async () => {
    /*
     * The bound is applied by the database, and a granted erasure request is
     * not a date: the service-data purge closes it the same night, so a person
     * cut off the end of this run is one no later run selects, and their posts
     * sit past the date the board granted while the request says it was carried
     * out. That is why the requested people are a query of their own, taken
     * first and not counted against the bound.
     */
    const expiredPersonIds = Array.from(
      { length: MAX_PERSONS_PER_RUN },
      (_unused, index) => `aa-${String(index).padStart(4, "0")}`,
    );
    const { service } = build({
      posts: [
        ...expiredPersonIds.map(expiredPostBy),
        // Written this morning, so nothing but the request selects them, and
        // sorting last so the bound is what would drop them.
        {
          id: "post-zz",
          authorPersonId: "zz",
          byBoard: false,
          createdAt: new Date(NOW.getTime() - 1000),
          erasedAt: null,
        },
      ],
      erasureRequestedPersonIds: ["zz"],
    });

    const eligible = await service.eligible(NOW, RETENTION_DAYS);

    // Taken first, and a run's worth of people still: what the bound now cuts
    // is the tail of the window rather than somebody the request named.
    expect(eligible[0]).toBe("zz");
    expect(eligible).toHaveLength(MAX_PERSONS_PER_RUN);
    expect(eligible).not.toContain(
      expiredPersonIds[expiredPersonIds.length - 1],
    );
  });

  it("asks for no exclusion when nobody is held", async () => {
    // An empty `notIn` is a condition whose meaning depends on how the client
    // renders a list of none, and this query decides what is erased.
    const { service, postGroupBy, commentGroupBy } = build({
      posts: [expiredPostBy("aa")],
    });

    await service.eligible(NOW, RETENTION_DAYS);

    expect(postGroupBy.mock.calls[0]?.[0].where).not.toHaveProperty(
      "authorPersonId",
    );
    expect(commentGroupBy.mock.calls[0]?.[0].where).not.toHaveProperty(
      "authorPersonId",
    );
  });
});

describe("erasing one person's posts and comments", () => {
  it("takes the hold lock before it reads whether they are held", async () => {
    /*
     * Order, not presence. A lock taken after the read leaves the window it
     * exists to close wide open: a hold committing in between is invisible to
     * the read and the delete goes ahead, and the board member who placed it has
     * been told the person is held.
     */
    const { service, calls } = build({ posts: [expiredPostBy("aa")] });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(calls).toEqual([
      ...PURGE_LOCKS,
      "readHold",
      "readRestriction",
      "readRequest",
      "deleteComments",
      "findPosts",
      "erasePosts",
      "deleteRevisions",
      "deleteLikesOnPosts",
      "deleteReadsOnPosts",
      "deleteReportsOnPosts",
      "deletePosts",
      "countCommentsUnderPosts",
    ]);
  });

  it("erases nothing when a hold stands", async () => {
    const { service, calls, audit, posts } = build({
      posts: [expiredPostBy("aa")],
      heldPersonIds: ["aa"],
    });

    await expect(
      service.purgePerson("aa", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 0, comments: 0 });
    expect(calls).toEqual([...PURGE_LOCKS, "readHold", "readRestriction"]);
    expect(posts).toHaveLength(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("erases nothing when processing is restricted", async () => {
    // Art. 18(2): the association may store the data, which makes erasing it
    // the one act the person asked it not to perform.
    const { service, audit, posts } = build({
      posts: [expiredPostBy("aa")],
      restrictedPersonIds: ["aa"],
    });

    await expect(
      service.purgePerson("aa", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 0, comments: 0 });
    expect(posts).toHaveLength(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("records nothing when the rows went while the run was in flight", async () => {
    /*
     * The scan selected this person, and by the time the transaction ran there
     * was nothing left to erase - the news item a comment was under was
     * deleted, or a purge on another clock reached the rows first.
     *
     * Nothing may be written for that. A SERVICE_DATA_PURGED entry claims an
     * erasure happened, the log is append-only and exempt from every purge, so
     * an entry for an erasure that erased nothing is a false record nobody can
     * correct - and a later access report would repeat it to the person it is
     * about.
     */
    const { service, calls, audit } = build({
      posts: [expiredPostBy("aa")],
      goneBeforeErasure: true,
    });

    await expect(
      service.purgePerson("aa", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 0, comments: 0 });
    expect(calls).toEqual([
      ...PURGE_LOCKS,
      "readHold",
      "readRestriction",
      "readRequest",
      "deleteComments",
      "findPosts",
    ]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("erases a post somebody answered and keeps the answer, which is its writer's", async () => {
    /*
     * The answers under the post are other people's data on their own clocks:
     * one written yesterday with a year to go, and one past its year whose
     * writer is not this run's to decide about - a hold or a restriction of
     * theirs is read in their own transaction, under their own lock, and in
     * no other. So the post's author's part goes, the row stays as the place
     * the answers stand, and no comment is deleted that this person did not
     * write.
     */
    const { service, posts, comments, deleteComments } = build({
      posts: [
        expiredPostBy("aa"),
        { ...expiredPostBy("aa"), id: "post-aa-quiet" },
        expiredPostBy("bb"),
      ],
      comments: [
        {
          id: "comment-cc-recent",
          postId: "post-aa",
          authorPersonId: "cc",
          createdAt: YESTERDAY,
        },
        expiredCommentBy("dd", "post-aa"),
        // Under somebody else's post, and not this purge's to take.
        {
          id: "comment-cc-elsewhere",
          postId: "post-bb",
          authorPersonId: "cc",
          createdAt: YESTERDAY,
        },
      ],
    });

    await expect(
      service.purgePerson("aa", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 2, comments: 0 });

    // Nobody answered this one, and it goes whole.
    expect(posts.map((post) => post.id)).toEqual(["post-aa", "post-bb"]);
    expect(posts[0]).toMatchObject({
      authorPersonId: null,
      body: null,
      erasedAt: NOW,
    });
    expect(comments.map((comment) => comment.id)).toEqual([
      "comment-cc-recent",
      "comment-dd",
      "comment-cc-elsewhere",
    ]);
    for (const [call] of deleteComments.mock.calls) {
      expect(call.where).toMatchObject({ authorPersonId: "aa" });
    }
  });

  it("deletes whole a post whose only answers were its author's own", async () => {
    // Their own comments go first, so nothing of anybody else's is left to
    // keep the row for.
    const { service, posts, comments } = build({
      posts: [expiredPostBy("aa")],
      comments: [expiredCommentBy("aa", "post-aa")],
    });

    await expect(
      service.purgePerson("aa", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 1, comments: 1 });
    expect(posts).toEqual([]);
    expect(comments).toEqual([]);
  });

  it("keeps the answers under a post a granted request erases, however recent the post", async () => {
    /*
     * The request brings this person's purge forward, and only theirs: the
     * answers are other people's, on their own clocks and under their own
     * holds.
     */
    const { service, posts, comments } = build({
      posts: [{ ...expiredPostBy("zz"), createdAt: YESTERDAY }],
      comments: [
        { ...expiredCommentBy("cc", "post-zz"), createdAt: YESTERDAY },
        expiredCommentBy("dd", "post-zz"),
      ],
      erasureRequestedPersonIds: ["zz"],
    });

    await expect(
      service.purgePerson("zz", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 1, comments: 0 });
    expect(posts).toMatchObject([
      { id: "post-zz", authorPersonId: null, erasedAt: NOW },
    ]);
    expect(comments).toHaveLength(2);
  });

  it("erases this person's own expired comments under anybody's post", async () => {
    const { service, posts, comments } = build({
      posts: [BOARD_POST, { ...expiredPostBy("bb"), createdAt: YESTERDAY }],
      comments: [
        expiredCommentBy("aa", BOARD_POST.id),
        // Written yesterday, and a year short of the window.
        {
          id: "comment-aa-recent",
          postId: "post-bb",
          authorPersonId: "aa",
          createdAt: YESTERDAY,
        },
      ],
    });

    await expect(
      service.purgePerson("aa", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 0, comments: 1 });
    expect(comments.map((comment) => comment.id)).toEqual([
      "comment-aa-recent",
    ]);
    // The posts it sat under are other people's, and stay.
    expect(posts).toHaveLength(2);
  });

  it("never erases a post written as Styrelsen, even on a granted request", async () => {
    /*
     * The board post is a news item, and an erasure request is answered for the
     * news item on the news item's rules: the board's own notice is the
     * association's record rather than the writer's personal data. The person's
     * own resident post goes; the notice they wrote as Styrelsen stays.
     */
    const { service, posts } = build({
      posts: [BOARD_POST, expiredPostBy("astrid")],
      erasureRequestedPersonIds: ["astrid"],
    });

    await expect(
      service.purgePerson("astrid", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 1, comments: 0 });
    expect(posts.map((post) => post.id)).toEqual([BOARD_POST.id]);
  });

  it("names the person and the counts, and nothing that was said", async () => {
    /*
     * This entry names the person, and the audit log is append-only and exempt
     * from every purge - so it outlives the rows it describes by design. A
     * sentence copied in here would be a permanent record of what somebody said
     * about a neighbour, inside the entry that says it was erased.
     */
    const { service, audit } = build({
      posts: [expiredPostBy("aa"), { ...expiredPostBy("bb"), id: "post-bb-2" }],
      comments: [
        expiredCommentBy("aa", "post-bb-2"),
        expiredCommentBy("bb", "post-aa"),
      ],
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      action: "SERVICE_DATA_PURGED",
      targetPersonId: "aa",
      // Nobody clicked this: the job ran because a date arrived.
      actorPersonId: null,
      targetKind: "post",
    });
    /*
     * Exactly these keys on the window: a person's own, and the other people's
     * comments under their posts counted apart and kept, because those are the
     * other people's data rather than this person's.
     */
    expect(entry?.context).toEqual({
      posts: 1,
      comments: 1,
      commentsKeptUnderErasedPosts: 1,
      images: 0,
      retentionDaysAfterWriting: RETENTION_DAYS,
    });
    // Not which audience either: an identifier in a permanent table is a handle
    // on a conversation whose rows are gone.
    expect(JSON.stringify(entry)).not.toContain("audience");
    expect(JSON.stringify(entry)).not.toContain("post-");
  });

  it("takes everything the feed holds of a person on a granted request", async () => {
    /*
     * The cutoff moves to now - a post written this morning goes - and with
     * the posts and comments go the places in groups, the read markers, the
     * posts they opened, what they liked and the reports they made. Each is
     * counted in the entry, so the log says what the request took.
     */
    const { service, audit, calls, posts } = build({
      posts: [
        {
          id: "post-zz",
          authorPersonId: "zz",
          byBoard: false,
          createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
          erasedAt: null,
        },
      ],
      erasureRequestedPersonIds: ["zz"],
      traces: {
        zz: {
          memberships: 2,
          readMarkers: 3,
          postReads: 4,
          postLikes: 5,
          commentLikes: 6,
          reports: 1,
        },
      },
    });

    await expect(
      service.purgePerson("zz", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 1, comments: 0 });

    expect(posts).toEqual([]);
    expect(calls).toEqual(
      expect.arrayContaining([
        "deleteMember",
        "deleteReadMarkers",
        "deletePostReads",
        "deletePostLikes",
        "deleteCommentLikes",
        "deleteReports",
      ]),
    );
    expect(audit.record.mock.calls[0]?.[0].context).toEqual({
      posts: 1,
      comments: 0,
      commentsKeptUnderErasedPosts: 0,
      images: 0,
      retentionDaysAfterWriting: RETENTION_DAYS,
      groupMemberships: 2,
      readMarkers: 3,
      postReads: 4,
      likes: 11,
      reports: 1,
    });
  });

  it("records a granted request that found only traces", async () => {
    // Somebody who never wrote a word and sat in a group: the place is theirs,
    // and the request took it.
    const { service, audit } = build({
      erasureRequestedPersonIds: ["zz"],
      traces: { zz: { memberships: 1 } },
    });

    await expect(
      service.purgePerson("zz", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 0, comments: 0 });
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record.mock.calls[0]?.[0].context).toMatchObject({
      groupMemberships: 1,
    });
  });

  it("leaves the traces alone on the window", async () => {
    // On the window a place, a marker, a like and a report go with the group
    // or the post, never with the person.
    const { service, calls } = build({
      posts: [expiredPostBy("aa")],
      traces: { aa: { memberships: 1, postLikes: 1 } },
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(calls).not.toContain("deleteMember");
    expect(calls).not.toContain("deletePostLikes");
  });
});

describe("a whole run", () => {
  it("summarises a run over several people", async () => {
    /*
     * The aggregation, asserted here rather than in the integration suite. That
     * one shares a database with every other suite and the run is unscoped, so a
     * count over the whole table there reports another suite's fixture as this
     * purge's work. Here the fake is the whole world and the numbers mean what
     * they say.
     *
     * A post, with somebody else's recent comment that keeps it standing
     * erased; a comment under a notice; and the notice, written as Styrelsen by
     * somebody who is never selected for it.
     */
    const { service, posts } = build({
      posts: [expiredPostBy("aa"), BOARD_POST],
      comments: [
        { ...expiredCommentBy("cc", "post-aa"), createdAt: YESTERDAY },
        expiredCommentBy("bb", BOARD_POST.id),
      ],
    });

    await expect(service.run(NOW, RETENTION_DAYS)).resolves.toEqual({
      considered: 2,
      purged: 2,
      postsDeleted: 1,
      commentsDeleted: 1,
      erasedPostsDeleted: 0,
      failed: 0,
      groupsDeleted: 0,
      formerResidentsRemoved: 0,
      unattachedImagesRemoved: 0,
    });
    expect(posts).toEqual([
      expect.objectContaining({ id: "post-aa", erasedAt: NOW }),
      BOARD_POST,
    ]);
  });

  it("deletes an erased post once the last comment under it has gone", async () => {
    /*
     * The post was erased on an earlier night and kept for the answer. The
     * answer's year runs out tonight; its writer's purge takes it, and the
     * sweep after the people takes the row nothing stands under any more.
     */
    const { service, posts, comments } = build({
      posts: [
        {
          ...expiredPostBy("aa"),
          authorPersonId: null,
          erasedAt: new Date("2026-01-01T03:47:00.000Z"),
        },
        // Erased as well, with an answer that has most of a year to go.
        {
          ...expiredPostBy("bb"),
          authorPersonId: null,
          erasedAt: new Date("2026-01-01T03:47:00.000Z"),
        },
      ],
      comments: [
        expiredCommentBy("cc", "post-aa"),
        { ...expiredCommentBy("dd", "post-bb"), createdAt: YESTERDAY },
      ],
    });

    await expect(service.run(NOW, RETENTION_DAYS)).resolves.toMatchObject({
      considered: 1,
      postsDeleted: 0,
      commentsDeleted: 1,
      erasedPostsDeleted: 1,
    });
    expect(posts.map((post) => post.id)).toEqual(["post-bb"]);
    expect(comments.map((comment) => comment.id)).toEqual(["comment-dd"]);
  });

  it("carries on past a person whose erasure fails, and names the failure only by its class", async () => {
    /*
     * Two properties of the same catch, and both are silent failures otherwise.
     *
     * One row the database refuses must not stop every person after it: the loop
     * runs person by person, so an unhandled throw would end the run at the
     * first one and everybody sorting later would keep their expired posts
     * until somebody read a log. The summary is what says the run went on.
     *
     * And what reaches the log is the class of the failure, not its message. A
     * constraint violation quotes the row it refused, and this row holds what
     * one neighbour wrote to the others - so an exception message written out
     * here would put a post into a container log, which is outside the masking
     * and outside the audit log that governs every other read of it.
     */
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const { service, erasePosts } = build({
      posts: [expiredPostBy("aa"), expiredPostBy("bb")],
    });
    erasePosts.mockRejectedValueOnce(
      new Error(`duplicate key value violates ... (${REVEALING_BODY})`),
    );

    await expect(service.run(NOW, RETENTION_DAYS)).resolves.toEqual({
      considered: 2,
      purged: 1,
      postsDeleted: 1,
      commentsDeleted: 0,
      erasedPostsDeleted: 0,
      failed: 1,
      groupsDeleted: 0,
      formerResidentsRemoved: 0,
      unattachedImagesRemoved: 0,
    });

    expect(logged).toHaveBeenCalledOnce();
    const written = JSON.stringify(logged.mock.calls[0]);
    expect(written).not.toContain(REVEALING_BODY);
    // The class and the person, so the row can still be found and the run
    // repeated: the person id is the only handle on an erasure that did not
    // happen, and a failed transaction wrote no audit entry to carry it.
    expect(written).toContain("Error");
    expect(written).toContain("aa");
  });
});

describe("the images on a post", () => {
  it("go with a post deleted whole and with one erased, after the erasure commits", async () => {
    const { service, posts, images, files, media, calls, audit } = build({
      posts: [expiredPostBy("aa"), { ...expiredPostBy("aa"), id: "post-aa-2" }],
      // Somebody else's answer keeps the first standing erased.
      comments: [
        { ...expiredCommentBy("cc", "post-aa"), createdAt: YESTERDAY },
      ],
      images: [
        { postId: "post-aa", fileId: "file-1" },
        { postId: "post-aa-2", fileId: "file-2" },
        { postId: "post-elsewhere", fileId: "file-3" },
      ],
      files: [
        { id: "file-1", createdAt: EXPIRED },
        { id: "file-2", createdAt: EXPIRED },
        { id: "file-3", createdAt: EXPIRED },
      ],
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    // The erased post keeps its row for the answer, and none of its pictures.
    expect(posts.map((post) => post.id)).toEqual(["post-aa"]);
    expect(images).toEqual([{ postId: "post-elsewhere", fileId: "file-3" }]);
    expect(files.map((file) => file.id)).toEqual(["file-3"]);
    expect(
      media.remove.mock.calls.map(([fileId, actor, channel]) => [
        fileId,
        actor,
        channel,
      ]),
    ).toEqual([
      ["file-1", null, "SYSTEM"],
      ["file-2", null, "SYSTEM"],
    ]);
    // An erasure that wrote the file's name into the log would leave a copy of
    // it where no purge reaches.
    expect(
      media.remove.mock.calls.every(
        ([, , , options]) => options?.recordFileName === false,
      ),
    ).toBe(true);
    // Out of storage only once the transaction that erased the posts is done:
    // its last statement is the audit entry, and every removal comes after it.
    const lastInTransaction = calls.lastIndexOf("countCommentsUnderPosts");
    expect(calls.indexOf("removeFile:file-1")).toBeGreaterThan(
      lastInTransaction,
    );
    expect(audit.record.mock.calls[0]?.[0].context).toMatchObject({
      images: 2,
    });
  });

  it("leaves a file it could not remove to the sweep, and carries on", async () => {
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const { service, posts, files, media } = build({
      posts: [expiredPostBy("aa")],
      images: [
        { postId: "post-aa", fileId: "file-1" },
        { postId: "post-aa", fileId: "file-2" },
      ],
      files: [
        { id: "file-1", createdAt: EXPIRED },
        { id: "file-2", createdAt: EXPIRED },
      ],
      refusedFileIds: ["file-1"],
    });

    await expect(
      service.purgePerson("aa", NOW, RETENTION_DAYS),
    ).resolves.toEqual({ posts: 1, comments: 0 });

    expect(posts).toEqual([]);
    expect(media.remove).toHaveBeenCalledTimes(2);
    // On no post now, so the next run's sweep finds it.
    expect(files.map((file) => file.id)).toEqual(["file-1"]);
    expect(logged).toHaveBeenCalledWith(
      "Feed purge left the image file file-1: Error",
    );
  });

  it("sweeps an upload that went on no post once no write would take it, and nothing younger", async () => {
    const hours = (count: number) =>
      new Date(NOW.getTime() - count * 60 * 60 * 1000);
    const { service, files } = build({
      images: [{ postId: "post-standing", fileId: "file-on-a-post" }],
      files: [
        { id: "file-abandoned", createdAt: hours(49) },
        // Still inside the window in which a write may attach it.
        { id: "file-yesterday", createdAt: hours(30) },
        { id: "file-on-a-post", createdAt: hours(1000) },
      ],
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.unattachedImagesRemoved).toBe(1);
    expect(files.map((file) => file.id)).toEqual([
      "file-yesterday",
      "file-on-a-post",
    ]);
  });

  it("keeps an upload on no post whose uploader is under a hold or a restriction, and never selects it", async () => {
    /*
     * A picture chosen and then not posted is still its uploader's data, and
     * a hold or a restriction forbids erasing it however it came to be on no
     * post. Left out by the scan, so a held person's uploads cannot fill the
     * run's bound; the neighbour's upload and one whose uploader is no longer
     * named go as before.
     */
    const OLD = new Date(NOW.getTime() - 72 * 60 * 60 * 1000);
    const { service, files, prisma, media } = build({
      heldPersonIds: ["held"],
      restrictedPersonIds: ["restricted"],
      files: [
        { id: "file-held", createdAt: OLD, uploadedByPersonId: "held" },
        {
          id: "file-restricted",
          createdAt: OLD,
          uploadedByPersonId: "restricted",
        },
        { id: "file-neighbour", createdAt: OLD, uploadedByPersonId: "bb" },
        { id: "file-nobody", createdAt: OLD, uploadedByPersonId: null },
      ],
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.unattachedImagesRemoved).toBe(2);
    expect(files.map((file) => file.id)).toEqual([
      "file-held",
      "file-restricted",
    ]);
    // Not merely kept at the last moment: never asked to go at all.
    expect(media.remove.mock.calls.map(([fileId]) => fileId)).toEqual([
      "file-neighbour",
      "file-nobody",
    ]);
    expect(prisma.mediaFile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { uploadedByPersonId: null },
            {
              uploadedByPersonId: {
                notIn: expect.arrayContaining(["held", "restricted"]),
              },
            },
          ],
        }),
      }),
    );
  });

  it("keeps an upload whose uploader a hold is placed over while the sweep runs", async () => {
    /*
     * The scan saw no hold. The placement holds the uploader's legal hold key
     * when the removal reaches for it, so the removal waits and then reads a
     * hold that has committed: the file stays, and the board member who placed
     * it was told the truth. Read before the key, the hold would have come too
     * late and the bytes would be gone.
     */
    const OLD = new Date(NOW.getTime() - 72 * 60 * 60 * 1000);
    const { service, files, calls } = build({
      heldOnLock: "aa",
      files: [{ id: "file-aa", createdAt: OLD, uploadedByPersonId: "aa" }],
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.unattachedImagesRemoved).toBe(0);
    expect(files.map((file) => file.id)).toEqual(["file-aa"]);
    expect(calls).not.toContain("removeFile:file-aa");
    const lock = calls.indexOf("lock:legal-hold");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("readWithheld")).toBeGreaterThan(lock);
    expect(calls.indexOf("keepFile:file-aa")).toBeGreaterThan(
      calls.indexOf("readWithheld"),
    );
  });

  it("keeps an upload that went on a post between the scan and its removal", async () => {
    // What the scan assumed, read again where the row is deleted.
    const OLD = new Date(NOW.getTime() - 72 * 60 * 60 * 1000);
    const { service, files, images, media } = build({
      files: [
        { id: "file-attached", createdAt: OLD, uploadedByPersonId: "aa" },
      ],
    });
    const remove = media.remove.getMockImplementation();
    if (remove === undefined) {
      throw new Error("the fake media layer has no removal");
    }
    media.remove.mockImplementationOnce(async (fileId, ...rest) => {
      images.push({ postId: "post-new", fileId });
      return remove(fileId, ...rest);
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.unattachedImagesRemoved).toBe(0);
    expect(files.map((file) => file.id)).toEqual(["file-attached"]);
    expect(images).toEqual([{ postId: "post-new", fileId: "file-attached" }]);
  });
});

describe("a group that holds nothing", () => {
  const A_YEAR_AGO = new Date("2025-01-01T00:00:00.000Z");
  const LAST_WEEK = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);

  it("erases a group the clock has emptied, and leaves every other audience", async () => {
    /*
     * The one thing in the feed with no clock of its own. A post carries its
     * own window, and its comments, likes, read records and reports go with
     * the post - but a membership list says which neighbours were in a group
     * together, and a group whose last post the purge has already erased would
     * go on saying that forever.
     *
     * Four audiences it must not take, one for each condition the sweep asks:
     * Alla and Styrelsen, whose members are derived, a group somebody is still
     * writing in, and a group made this week.
     */
    const { service, audiences, calls } = build({
      audiences: [
        { id: "audience-old", kind: "GROUP", createdAt: A_YEAR_AGO },
        { id: "audience-all", kind: "ALL", createdAt: A_YEAR_AGO },
        { id: "audience-board", kind: "BOARD", createdAt: A_YEAR_AGO },
        {
          id: "audience-busy",
          kind: "GROUP",
          createdAt: A_YEAR_AGO,
          posts: 1,
        },
        { id: "audience-new", kind: "GROUP", createdAt: LAST_WEEK },
      ],
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.groupsDeleted).toBe(1);
    expect(audiences.map((audience) => audience.id)).toEqual([
      "audience-all",
      "audience-board",
      "audience-busy",
      "audience-new",
    ]);
    /*
     * Not by hand any more: the marker cascades with the group. Asserting the
     * absence is what keeps the constraint load-bearing - a sweep that deleted
     * them here as well would go on passing with the foreign key dropped. That
     * the cascade does clear them is asserted against a real database in
     * group.int-spec.ts, which is the only place it can be.
     */
    expect(calls).not.toContain("deleteReadMarkers");
  });

  it("carries on past a group the database refuses, and names it by its class", async () => {
    /*
     * The loop is a list of erasures that are all owed. A group that fails
     * would otherwise end the sweep where it stood and take the run's summary
     * with it - so every group sorting after it would keep its membership list
     * for as long as that one group kept failing, and nothing would say so.
     *
     * What reaches the log is the class of the failure and the group. An
     * exception message here can be quoting a row, and this row is a group
     * somebody named.
     */
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const { service, audiences } = build({
      audiences: [
        { id: "audience-aa-refused", kind: "GROUP", createdAt: A_YEAR_AGO },
        { id: "audience-bb", kind: "GROUP", createdAt: A_YEAR_AGO },
      ],
      refusedAudienceId: "audience-aa-refused",
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    // The second group is erased although the first one threw, and the run
    // answers with a summary rather than rejecting.
    expect(summary.groupsDeleted).toBe(1);
    expect(audiences.map((audience) => audience.id)).toEqual([
      "audience-aa-refused",
    ]);

    expect(logged).toHaveBeenCalledOnce();
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain("audience-aa-refused");
    expect(line).toContain("Error");
    // Never what the failure was holding: this one is quoting the group.
    expect(line).not.toContain("the database refused");
  });

  it("takes the group's own lock before it decides the group is empty", async () => {
    /*
     * The key `FeedService.write` takes. A post committed between the scan and
     * the delete is erased by the cascade and its author told it was stored,
     * so the emptiness is decided again under this lock - which is only worth
     * anything if both sides spell the key the same way.
     */
    const { service, calls, locks } = build({
      audiences: [{ id: "audience-old", kind: "GROUP", createdAt: A_YEAR_AGO }],
    });

    await service.run(NOW, RETENTION_DAYS);

    expect(locks).toEqual(["audience:audience-old"]);
    expect(calls.indexOf("lockAudience")).toBeLessThan(
      calls.indexOf("deleteGroups"),
    );
  });

  it("counts what it actually erased, not what it selected", async () => {
    // The delete repeats every condition, so a group that stopped being empty
    // between the scan and the delete is left alone - and the run says so.
    const { service, audiences } = build({
      audiences: [{ id: "audience-old", kind: "GROUP", createdAt: A_YEAR_AGO }],
      writtenInOnLock: "audience-old",
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.groupsDeleted).toBe(0);
    expect(audiences).toHaveLength(1);
  });
});

describe("a place held by somebody who has moved out", () => {
  it("takes them out of the group, with the marker of what they had read", async () => {
    const { service, calls, audit } = build({
      formerMembers: [{ audienceId: "audience-1", personId: "aa" }],
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.formerResidentsRemoved).toBe(1);
    expect(calls).toEqual([
      "lock:legal-hold",
      "lock:residency",
      "lockAudience",
      "readWithheld",
      "readResidency",
      "deleteMember",
      "deleteReadMarkers",
    ]);
    expect(audit.record).toHaveBeenCalledOnce();
    /*
     * The act ADR 0012 makes it, in the vocabulary the log has always used for
     * it (ADR 0026), and with no actor: nobody took them out, their residency
     * ended.
     */
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      action: "CHAT_GROUP_MEMBER_REMOVED",
      actorPersonId: null,
      targetPersonId: "aa",
      targetKind: "chat",
      targetId: "audience-1",
      context: { chatKind: "GROUP", residencyEnded: true },
    });
  });

  it("leaves the place of somebody whose move-in it waited for", async () => {
    /*
     * The move-in takes the person's residency key, and so does the sweep,
     * before it reads whether they live here. Without the key the move-in can
     * commit between that read and the delete, and a resident loses their
     * place in a group they live beside.
     */
    const { service, calls, audit } = build({
      formerMembers: [{ audienceId: "audience-1", personId: "aa" }],
      movesBackInOnLock: "aa",
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.formerResidentsRemoved).toBe(0);
    expect(calls).not.toContain("deleteMember");
    expect(calls).not.toContain("deleteReadMarkers");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("reaches the places after a full page the database refuses", async () => {
    /*
     * A refused place is still stale, so every night's scan finds it again.
     * Read as one page, a full page of them sorting first would keep every
     * place after them in its group for as long as they kept failing.
     */
    const refused = Array.from(
      { length: MAX_PERSONS_PER_RUN },
      (_, index) => `refused-${String(index).padStart(4, "0")}`,
    );
    const { service, audit } = build({
      formerMembers: [
        ...refused.map((personId) => ({ audienceId: "audience-1", personId })),
        { audienceId: "audience-2", personId: "aa" },
      ],
      refusedMemberPersonIds: refused,
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.formerResidentsRemoved).toBe(1);
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record.mock.calls[0]?.[0].targetPersonId).toBe("aa");
  });
});

describe("the schedule", () => {
  it("retires the two purges it replaced before it schedules its own", async () => {
    /*
     * A schedule is stored in the job schema and outlives the code that
     * registered it. Left in place, the chat's and the news comments' purges
     * would wake every night into queues nobody works any more.
     */
    const { service, jobs } = build({});

    await service.startPurgeWorker();

    expect(FEED_PURGE_QUEUE).toBe("feed-purge");
    expect(jobs.instance.unschedule.mock.calls.map(([name]) => name)).toEqual([
      "chat-purge",
      "news-comment-purge",
    ]);
    expect(jobs.work).toHaveBeenCalledWith("feed-purge", expect.any(Function));
    expect(jobs.schedule).toHaveBeenCalledWith("feed-purge", "47 3 * * *", {});
    expect(
      jobs.instance.unschedule.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(jobs.schedule.mock.invocationCallOrder[0] ?? 0);
  });

  it("registers nothing under test, where the suite drives the clock", async () => {
    const { service, jobs } = build({});

    await service.onModuleInit();

    expect(jobs.schedule).not.toHaveBeenCalled();
    expect(jobs.instance.unschedule).not.toHaveBeenCalled();
  });
});
