import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { MotionPurgeService } from "./motion-purge.service";

/**
 * The three things about the motion purge that are decided before any row is
 * touched, and that a database cannot be asked about.
 *
 * Which people a run selects, which is what decides whether every expired motion
 * is eventually reached or some are reached never. The bound on a run is applied
 * by the database, so anybody excluded after the query has already spent one of
 * its places: held people filtered afterwards would fill run after run with work
 * that cannot be done, and the motions behind them would outlive their retention
 * window with nothing reporting a fault. That is the failure a count in a summary
 * looks fine through.
 *
 * That an open motion is never in scope. Nothing else in the module says so: the
 * scan is the only place a motion still with the board is kept out of an erasure,
 * and a `closedAt: { lte: cutoff }` without the `not: null` would be an easy way
 * to erase a queue nobody had worked.
 *
 * And that the hold is read under the lock rather than beside it. Both are
 * ordinary awaits on the transaction client, so nothing about the source says
 * which came first; the order is the whole of the guarantee, and the only way to
 * state it is to record the calls and read them back.
 *
 * The window arithmetic is `motion-retention.spec.ts`, and what actually happens
 * to the rows is `motions.int-spec.ts`.
 */

const RETENTION_DAYS = 730;
const NOW = new Date("2029-06-01T03:29:00.000Z");

/** How many people one run may take, mirrored from the service. */
const MAX_PERSONS_PER_RUN = 500;

interface Motion {
  submittedByPersonId: string;
  closedAt: Date | null;
}

/**
 * A database holding these motions and these open holds.
 *
 * `groupBy` is implemented rather than stubbed with an answer, because the
 * property under test is what the service asks of it: a fake that returned a
 * fixed list would pass whatever the query said. So this one honours the
 * `closedAt` filter in both its halves, the `notIn` exclusion, the sort and the
 * bound, which is exactly the contract the real one is relied on for.
 */
function build(options: { motions: Motion[]; heldPersonIds?: string[] }) {
  const held = options.heldPersonIds ?? [];

  const groupBy = vi.fn(
    async (args: {
      where: {
        closedAt: { not: null; lte: Date };
        submittedByPersonId?: { notIn: string[] };
      };
      take: number;
    }) => {
      const excluded = new Set(args.where.submittedByPersonId?.notIn ?? []);
      // Both halves of the filter honoured, including the null one: a fake that
      // silently let an open motion through would hide exactly the defect the
      // "leaves an open motion alone" test exists to catch.
      const requiresClosed = args.where.closedAt.not === null;
      const ids = [
        ...new Set(
          options.motions
            .filter((motion) => {
              if (requiresClosed && motion.closedAt === null) {
                return false;
              }
              return (
                motion.closedAt !== null &&
                motion.closedAt.getTime() <=
                  args.where.closedAt.lte.getTime() &&
                !excluded.has(motion.submittedByPersonId)
              );
            })
            .map((motion) => motion.submittedByPersonId),
        ),
      ]
        .sort()
        .slice(0, args.take);
      return ids.map((submittedByPersonId) => ({ submittedByPersonId }));
    },
  );

  /** Every call the transaction made, in the order it made them. */
  const calls: string[] = [];

  const deleteMany = vi.fn(
    async (_args: {
      where: {
        submittedByPersonId: string;
        closedAt: { not: null; lte: Date };
      };
    }) => {
      calls.push("delete");
      return { count: 2 };
    },
  );

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
    motion: { deleteMany },
  };

  const prisma = {
    motion: { groupBy },
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
        action?: string;
        targetPersonId?: string | null;
        targetKind?: string | null;
        context?: Record<string, unknown>;
      }) => undefined,
    ),
  };

  return {
    service: new MotionPurgeService(
      { NODE_ENV: "test" } as Env,
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      {} as JobQueueService,
    ),
    audit,
    calls,
    groupBy,
    deleteMany,
  };
}

/** A person with one motion closed long ago. */
function expiredMotionFor(submittedByPersonId: string): Motion {
  return {
    submittedByPersonId,
    closedAt: new Date("2026-01-01T10:00:00.000Z"),
  };
}

describe("choosing who a run erases for", () => {
  it("leaves out the people a legal hold stands against", async () => {
    const { service } = build({
      motions: [expiredMotionFor("aa"), expiredMotionFor("bb")],
      heldPersonIds: ["aa"],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "bb",
    ]);
  });

  it("leaves out motions whose window has not run out", async () => {
    const { service } = build({
      motions: [
        expiredMotionFor("aa"),
        // Closed the day before this run: two years short of erasable.
        {
          submittedByPersonId: "bb",
          closedAt: new Date("2029-05-31T10:00:00.000Z"),
        },
      ],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "aa",
    ]);
  });

  it("leaves an open motion alone however old it is", async () => {
    /*
     * A motion submitted years ago and never dealt with. The association is
     * still processing it, so the purpose it is held for has not ended, and a
     * queue nobody has worked is something for the board to see rather than for
     * a job to erase. This is also the only place the rule is stated: nothing
     * downstream would notice an open motion being deleted.
     */
    const { service, groupBy } = build({
      motions: [{ submittedByPersonId: "aa", closedAt: null }],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([]);
    // And the query itself says so, rather than the filter happening to miss it.
    expect(groupBy.mock.calls[0]?.[0].where.closedAt).toHaveProperty(
      "not",
      null,
    );
  });

  it("reaches people behind a run's worth of held people", async () => {
    /*
     * The starvation case, and the reason the holds are excluded by the query
     * rather than dropped from its answer.
     *
     * The bound is applied by the database, so a person removed afterwards has
     * still spent one of the five hundred places. Fill every place with held
     * people sorting first - `held-...` before `zz` - and a run that filtered
     * afterwards would select five hundred people it may not touch, erase
     * nothing, and do the same thing every night the holds stand. The summary
     * reports five hundred considered and none purged, which reads like a quiet
     * night, while `zz`'s motions sit years past the date this product told them
     * they would be erased on.
     */
    const heldPersonIds = Array.from(
      { length: MAX_PERSONS_PER_RUN },
      (_unused, index) => `held-${String(index).padStart(4, "0")}`,
    );
    const { service } = build({
      motions: [...heldPersonIds.map(expiredMotionFor), expiredMotionFor("zz")],
      heldPersonIds,
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "zz",
    ]);
  });

  it("asks for no exclusion when nobody is held", async () => {
    // An empty `notIn` is a condition whose meaning depends on how the client
    // renders a list of none, and this query decides what is erased.
    const { service, groupBy } = build({ motions: [expiredMotionFor("aa")] });

    await service.eligible(NOW, RETENTION_DAYS);

    expect(groupBy.mock.calls[0]?.[0].where).not.toHaveProperty(
      "submittedByPersonId",
    );
  });
});

describe("erasing one person's motions", () => {
  it("takes the hold lock before it reads whether they are held", async () => {
    /*
     * Order, not presence. A lock taken after the read leaves the window it
     * exists to close wide open: a hold committing in between is invisible to the
     * read and the delete goes ahead, and the board member who placed it has been
     * told the person is held.
     */
    const { service, calls } = build({ motions: [expiredMotionFor("aa")] });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(calls).toEqual(["lock", "readHold", "delete"]);
  });

  it("erases nothing when a hold stands", async () => {
    const { service, calls, audit } = build({
      motions: [expiredMotionFor("aa")],
      heldPersonIds: ["aa"],
    });

    await expect(service.purgePerson("aa", NOW, RETENTION_DAYS)).resolves.toBe(
      0,
    );
    expect(calls).toEqual(["lock", "readHold"]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("deletes only closed motions past the cutoff", async () => {
    // The delete carries the whole rule rather than trusting the scan: the scan
    // chose the person, and this statement chooses the rows. Without the closing
    // condition here, selecting a person for one expired motion would erase every
    // motion they had ever submitted, including the one still with the board.
    const { service, deleteMany } = build({
      motions: [expiredMotionFor("aa")],
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    const where = deleteMany.mock.calls[0]?.[0].where;
    expect(where?.submittedByPersonId).toBe("aa");
    expect(where?.closedAt).toHaveProperty("not", null);
    expect(where?.closedAt.lte.getTime()).toBe(
      NOW.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it("records the count and the window, and nothing about the motions", async () => {
    /*
     * This entry names the person, and the audit log is append-only and exempt
     * from every purge - so it outlives the rows it describes by design. A title
     * copied in here would be a permanent record of what somebody proposed, kept
     * inside the entry that says it was erased.
     */
    const { service, audit } = build({ motions: [expiredMotionFor("aa")] });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0]?.[0];
    expect(entry?.action).toBe("SERVICE_DATA_PURGED");
    expect(entry?.targetKind).toBe("motion");
    expect(entry?.targetPersonId).toBe("aa");
    expect(entry?.context).toEqual({
      motions: 2,
      retentionDaysAfterClosing: RETENTION_DAYS,
    });
    // No actor: nobody clicked this, the date arrived.
    expect(
      (entry as { actorPersonId?: string | null } | undefined)?.actorPersonId,
    ).toBeNull();
  });

  it("summarises a run over several people", async () => {
    const { service } = build({
      motions: [expiredMotionFor("aa"), expiredMotionFor("bb")],
    });

    await expect(service.run(NOW, RETENTION_DAYS)).resolves.toEqual({
      considered: 2,
      purged: 2,
      motionsDeleted: 4,
      failed: 0,
    });
  });
});
