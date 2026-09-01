import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { NewsCommentPurgeService } from "./news-comment-purge.service";

/**
 * The two things about the news comment purge that are decided before any row is
 * touched, and that a database cannot be asked about.
 *
 * Which people a run selects, which is what decides whether every expired
 * comment is eventually reached or some are reached never. The bound on a run
 * exists so the first run on a long-lived instance cannot erase a decade in one
 * loop, and it is applied by the database - so anybody excluded after the query
 * has already spent it. Held people excluded afterwards would fill run after run
 * with work that cannot be done, and the comments behind them would outlive
 * their retention window with nothing reporting a fault. That is the failure a
 * count in a summary looks fine through, which is why it is asserted here.
 *
 * And that the hold is read under the lock rather than beside it. Both are
 * ordinary awaits on the transaction client, so nothing about the source says
 * which came first; the order is the whole of the guarantee, and the only way to
 * state it is to record the calls and read them back.
 *
 * The window arithmetic is `news-comment-retention.spec.ts`, and what actually
 * happens to the rows is `news-comments.int-spec.ts`.
 */

const RETENTION_DAYS = 365;
const NOW = new Date("2027-06-01T03:11:00.000Z");

/**
 * A comment body, as a database failure would quote it back.
 *
 * Stood in for a real one so the assertion that it does not reach the log has
 * something to look for.
 */
const REVEALING_BODY = "Grannen i 1202 lamnar sopor i trapphuset";

/** How many people one run may take, mirrored from the service. */
const MAX_PERSONS_PER_RUN = 500;

interface Comment {
  authorPersonId: string;
  createdAt: Date;
}

/**
 * A database holding these comments and these open holds.
 *
 * `groupBy` is implemented rather than stubbed with an answer, because the
 * property under test is what the service asks of it: a fake that returned a
 * fixed list would pass whatever the query said. So this one honours the
 * `createdAt` filter, the `notIn` exclusion, the sort and the bound, which is
 * exactly the contract the real one is being relied on for.
 *
 * `deletedCount` is how many rows the delete reports. Configurable because zero
 * is a branch of its own and the one a database cannot be asked to produce on
 * demand: it is what the service sees when the last of somebody's comments went
 * between the scan and the transaction.
 */
function build(options: {
  comments: Comment[];
  heldPersonIds?: string[];
  deletedCount?: number;
}) {
  const held = options.heldPersonIds ?? [];
  const deletedCount = options.deletedCount ?? 2;

  const groupBy = vi.fn(
    async (args: {
      where: { createdAt: { lte: Date }; authorPersonId?: { notIn: string[] } };
      take: number;
    }) => {
      const excluded = new Set(args.where.authorPersonId?.notIn ?? []);
      const ids = [
        ...new Set(
          options.comments
            .filter(
              (comment) =>
                comment.createdAt.getTime() <=
                  args.where.createdAt.lte.getTime() &&
                !excluded.has(comment.authorPersonId),
            )
            .map((comment) => comment.authorPersonId),
        ),
      ]
        .sort()
        .slice(0, args.take);
      return ids.map((authorPersonId) => ({ authorPersonId }));
    },
  );

  /** Every call the transaction made, in the order it made them. */
  const calls: string[] = [];

  const tx = {
    $executeRaw: vi.fn(async () => {
      calls.push("lock");
      return 1;
    }),
    legalHold: {
      findFirst: vi.fn(async () => {
        calls.push("readHold");
        return held.length > 0 ? { id: "hold-1" } : null;
      }),
    },
    newsComment: {
      deleteMany: vi.fn(async () => {
        calls.push("delete");
        return { count: deletedCount };
      }),
    },
  };

  const prisma = {
    newsComment: { groupBy },
    legalHold: {
      findMany: vi.fn(async () => held.map((personId) => ({ personId }))),
    },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<number>) =>
      run(tx),
    ),
  };

  const audit = {
    record: vi.fn(
      async (_entry: {
        targetPersonId?: string | null;
        context?: Record<string, unknown>;
      }) => undefined,
    ),
  };

  return {
    service: new NewsCommentPurgeService(
      { NODE_ENV: "test" } as Env,
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      {} as JobQueueService,
    ),
    prisma,
    audit,
    calls,
    groupBy,
    deleteMany: tx.newsComment.deleteMany,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A person with one comment written long enough ago to be erasable. */
function expiredCommentFor(authorPersonId: string): Comment {
  return {
    authorPersonId,
    createdAt: new Date("2025-01-01T10:00:00.000Z"),
  };
}

describe("choosing who a run erases for", () => {
  it("leaves out the people a legal hold stands against", async () => {
    const { service } = build({
      comments: [expiredCommentFor("aa"), expiredCommentFor("bb")],
      heldPersonIds: ["aa"],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "bb",
    ]);
  });

  it("leaves out comments whose window has not run out", async () => {
    const { service } = build({
      comments: [
        expiredCommentFor("aa"),
        // Written the day before this run: a year short of erasable.
        {
          authorPersonId: "bb",
          createdAt: new Date("2027-05-31T10:00:00.000Z"),
        },
      ],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "aa",
    ]);
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
     * and does exactly the same thing tomorrow and every night the holds stand.
     * The summary reports five hundred considered and none purged, which reads
     * like a quiet night, while `zz`'s comments sit years past the date this
     * product told them they would be erased on.
     */
    const heldPersonIds = Array.from(
      { length: MAX_PERSONS_PER_RUN },
      (_unused, index) => `held-${String(index).padStart(4, "0")}`,
    );
    const { service } = build({
      comments: [
        ...heldPersonIds.map(expiredCommentFor),
        expiredCommentFor("zz"),
      ],
      heldPersonIds,
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "zz",
    ]);
  });

  it("asks for no exclusion when nobody is held", async () => {
    // An empty `notIn` is a condition whose meaning depends on how the client
    // renders a list of none, and this query decides what is erased.
    const { service, groupBy } = build({
      comments: [expiredCommentFor("aa")],
    });

    await service.eligible(NOW, RETENTION_DAYS);

    expect(groupBy.mock.calls[0]?.[0].where).not.toHaveProperty(
      "authorPersonId",
    );
  });
});

describe("erasing one person's comments", () => {
  it("takes the hold lock before it reads whether they are held", async () => {
    /*
     * Order, not presence. A lock taken after the read leaves the window it
     * exists to close wide open: a hold committing in between is invisible to
     * the read and the delete goes ahead, and the board member who placed it has
     * been told the person is held.
     */
    const { service, calls } = build({
      comments: [expiredCommentFor("aa")],
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(calls).toEqual(["lock", "readHold", "delete"]);
  });

  it("erases nothing when a hold stands", async () => {
    const { service, calls, audit } = build({
      comments: [expiredCommentFor("aa")],
      heldPersonIds: ["aa"],
    });

    await expect(service.purgePerson("aa", NOW, RETENTION_DAYS)).resolves.toBe(
      0,
    );
    expect(calls).toEqual(["lock", "readHold"]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("records nothing when the rows went while the run was in flight", async () => {
    /*
     * The scan selected this person, and by the time the transaction ran there
     * was nothing left to erase - the author deleted the item, or a purge on
     * another clock reached the rows first.
     *
     * Nothing may be written for that. A SERVICE_DATA_PURGED entry claims an
     * erasure happened, the log is append-only and exempt from every purge, so
     * an entry for an erasure that erased nothing is a false record nobody can
     * correct - and a later access report would repeat it to the person it is
     * about.
     */
    const { service, calls, audit } = build({
      comments: [expiredCommentFor("aa")],
      deletedCount: 0,
    });

    await expect(service.purgePerson("aa", NOW, RETENTION_DAYS)).resolves.toBe(
      0,
    );
    expect(calls).toEqual(["lock", "readHold", "delete"]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("records the count and the window, and nothing about the comments", async () => {
    /*
     * This entry names the person, and the audit log is append-only and exempt
     * from every purge - so it outlives the rows it describes by design. A
     * sentence or a news item copied in here would be a permanent record of what
     * somebody said about a neighbour, inside the entry that says it was erased.
     */
    const { service, audit } = build({
      comments: [expiredCommentFor("aa")],
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0]?.[0];
    expect(entry?.targetPersonId).toBe("aa");
    expect(entry?.context).toEqual({
      newsComments: 2,
      retentionDaysAfterComment: RETENTION_DAYS,
    });
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
     */
    const { service } = build({
      comments: [expiredCommentFor("aa"), expiredCommentFor("bb")],
    });

    await expect(service.run(NOW, RETENTION_DAYS)).resolves.toEqual({
      considered: 2,
      purged: 2,
      commentsDeleted: 4,
      failed: 0,
    });
  });

  it("carries on past a person whose erasure fails, and names the failure only by its class", async () => {
    /*
     * Two properties of the same catch, and both are silent failures otherwise.
     *
     * One row the database refuses must not stop every person after it: the loop
     * runs person by person, so an unhandled throw would end the run at the
     * first one and everybody sorting later would keep their expired comments
     * until somebody read a log. The summary is what says the run went on.
     *
     * And what reaches the log is the class of the failure, not its message. A
     * constraint violation quotes the row it refused, and this row holds what
     * one resident wrote about another - so an exception message written out
     * here would put a comment into a container log, which is outside the
     * masking and outside the audit log that governs every other read of it.
     */
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const { service, deleteMany } = build({
      comments: [expiredCommentFor("aa"), expiredCommentFor("bb")],
    });
    deleteMany.mockRejectedValueOnce(
      new Error(`duplicate key value violates ... (${REVEALING_BODY})`),
    );

    await expect(service.run(NOW, RETENTION_DAYS)).resolves.toEqual({
      considered: 2,
      purged: 1,
      commentsDeleted: 2,
      failed: 1,
    });

    expect(logged).toHaveBeenCalledOnce();
    const written = JSON.stringify(logged.mock.calls[0]);
    expect(written).not.toContain(REVEALING_BODY);
    // The class and the person, so the row can still be found and the run
    // repeated. The identifier is chosen where the code was written rather than
    // composed from the row - the distinction `logging/failure.ts` draws.
    expect(written).toContain("Error");
    expect(written).toContain("aa");
  });
});
