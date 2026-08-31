import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { EventSignupPurgeService } from "./event-signup-purge.service";

/**
 * The two things about the sign-up purge that are decided before any row is
 * touched, and that a database cannot be asked about.
 *
 * Which people a run selects, which is what decides whether every expired
 * sign-up is eventually reached or some are reached never. The bound on a run
 * exists so the first run on an instance that has kept a calendar for years
 * cannot erase a decade in one loop, and it is applied by the database - so
 * anybody excluded after the query has already spent it. Held people excluded
 * afterwards would fill run after run with work that cannot be done, and the
 * sign-ups behind them would outlive their retention window with nothing
 * reporting a fault. That is the failure a count in a summary looks fine
 * through, which is why it is asserted here.
 *
 * And that the hold is read under the lock rather than beside it. Both are
 * ordinary awaits on the transaction client, so nothing about the source says
 * which came first; the order is the whole of the guarantee, and the only way to
 * state it is to record the calls and read them back.
 *
 * The window arithmetic is `event-signup-retention.spec.ts`, and what actually
 * happens to the rows is `event-signups.int-spec.ts`.
 */

const RETENTION_DAYS = 365;
const NOW = new Date("2028-06-01T03:11:00.000Z");

/** How many people one run may take, mirrored from the service. */
const MAX_PERSONS_PER_RUN = 500;

interface Signup {
  personId: string;
  /** When the date signed up to ended, which is what the clock runs from. */
  occurrenceEndsAt: Date;
}

/**
 * A database holding these sign-ups and these open holds.
 *
 * `groupBy` is implemented rather than stubbed with an answer, because the
 * property under test is what the service asks of it: a fake that returned a
 * fixed list would pass whatever the query said. So this one honours the window
 * on the occurrence, the `notIn` exclusion, the sort and the bound, which is
 * exactly the contract the real one is being relied on for.
 *
 * It reads the window through `where.occurrence.endsAt`, which is the shape that
 * matters here: the clock runs from the end of the date signed up to, and a
 * service that had reached for a column on the sign-up itself - or for the
 * series' own `firstOn`, which is a date column read back as midnight UTC - would
 * fail this rather than quietly erase on a different day.
 */
function build(options: { signups: Signup[]; heldPersonIds?: string[] }) {
  const held = options.heldPersonIds ?? [];

  const groupBy = vi.fn(
    async (args: {
      where: {
        occurrence: { endsAt: { lte: Date } };
        personId?: { notIn: string[] };
      };
      take: number;
    }) => {
      const excluded = new Set(args.where.personId?.notIn ?? []);
      const ids = [
        ...new Set(
          options.signups
            .filter(
              (signup) =>
                signup.occurrenceEndsAt.getTime() <=
                  args.where.occurrence.endsAt.lte.getTime() &&
                !excluded.has(signup.personId),
            )
            .map((signup) => signup.personId),
        ),
      ]
        .sort()
        .slice(0, args.take);
      return ids.map((personId) => ({ personId }));
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
    eventSignup: {
      // Takes its argument, because one of the assertions below is about what
      // the delete asks for: the window is on the occurrence and there is no
      // filter on the withdrawal date.
      deleteMany: vi.fn(async (_args: { where: Record<string, unknown> }) => {
        calls.push("delete");
        return { count: 3 };
      }),
    },
  };

  const prisma = {
    eventSignup: { groupBy },
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
        targetKind?: string | null;
        context?: Record<string, unknown>;
      }) => undefined,
    ),
  };

  return {
    service: new EventSignupPurgeService(
      { NODE_ENV: "test" } as Env,
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      {} as JobQueueService,
    ),
    prisma,
    audit,
    calls,
    groupBy,
    tx,
  };
}

/** A person with one sign-up to a date that ran out long ago. */
function expiredSignupFor(personId: string): Signup {
  return {
    personId,
    occurrenceEndsAt: new Date("2026-04-18T12:00:00.000Z"),
  };
}

describe("choosing who a run erases for", () => {
  it("leaves out the people a legal hold stands against", async () => {
    const { service } = build({
      signups: [expiredSignupFor("aa"), expiredSignupFor("bb")],
      heldPersonIds: ["aa"],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "bb",
    ]);
  });

  it("leaves out sign-ups whose window has not run out", async () => {
    const { service } = build({
      signups: [
        expiredSignupFor("aa"),
        // A cleaning day last month: the sign-up is kept for a year after it.
        {
          personId: "bb",
          occurrenceEndsAt: new Date("2028-05-01T12:00:00.000Z"),
        },
      ],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "aa",
    ]);
  });

  it("reaches people behind a run's worth of held people", async () => {
    /*
     * The starvation the ordering exists to prevent. The bound is applied by the
     * database, so held people dropped from the answer afterwards would still
     * have spent it: a run would come back with nothing to do, night after
     * night, while the sign-ups behind them outlived their window with nothing
     * reporting a fault.
     *
     * The held ids sort ahead of the one that must be reached, which is what
     * makes the assertion bite: with the exclusion applied after the query,
     * "zz" is never in the answer.
     */
    const heldPersonIds = Array.from(
      { length: MAX_PERSONS_PER_RUN },
      (_, index) => `aa-${String(index).padStart(4, "0")}`,
    );
    const { service } = build({
      signups: [
        ...heldPersonIds.map((personId) => expiredSignupFor(personId)),
        expiredSignupFor("zz"),
      ],
      heldPersonIds,
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "zz",
    ]);
  });

  it("asks for no exclusion when nobody is held", async () => {
    // An empty `notIn` is a filter whose meaning depends on how the client
    // renders a list of none, and this query decides who is erased.
    const { service, groupBy } = build({
      signups: [expiredSignupFor("aa")],
    });

    await service.eligible(NOW, RETENTION_DAYS);

    expect(groupBy.mock.calls[0]?.[0].where.personId).toBeUndefined();
  });
});

describe("erasing one person's sign-ups", () => {
  it("takes the hold lock before it reads whether they are held", async () => {
    /*
     * Order, not presence. A lock taken after the read leaves the window it
     * exists to close wide open: a hold committing in between is invisible to
     * the read and the delete goes ahead, and the board member who placed it has
     * been told the person is held.
     */
    const { service, calls } = build({
      signups: [expiredSignupFor("aa")],
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(calls).toEqual(["lock", "readHold", "delete"]);
  });

  it("erases nothing when a hold stands", async () => {
    const { service, calls, audit } = build({
      signups: [expiredSignupFor("aa")],
      heldPersonIds: ["aa"],
    });

    await expect(service.purgePerson("aa", NOW, RETENTION_DAYS)).resolves.toBe(
      0,
    );
    expect(calls).toEqual(["lock", "readHold"]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("deletes by the end of the date signed up to, standing and withdrawn alike", async () => {
    /*
     * The window is asked of the occurrence and nothing else. No filter on
     * `withdrawnAt`: a withdrawal is a record that somebody had put their name
     * down, and its purpose ran out on the same day the date did - a purge that
     * kept the withdrawn ones would leave the association holding exactly the
     * rows it had promised to erase.
     */
    const { service, tx } = build({ signups: [expiredSignupFor("aa")] });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    const asked = tx.eventSignup.deleteMany.mock.calls[0]?.[0];
    expect(asked?.where).toEqual({
      personId: "aa",
      occurrence: {
        endsAt: { lte: new Date("2027-06-02T03:11:00.000Z") },
      },
    });
  });

  it("records the count and the window, and nothing about the dates", async () => {
    /*
     * This entry names the person, and the audit log is append-only and exempt
     * from every purge - so it outlives the rows it describes by design. A series
     * title or a date copied in here would be a precise record of which of the
     * association's events somebody went to, kept for good, inside the entry that
     * says it was erased.
     */
    const { service, audit } = build({
      signups: [expiredSignupFor("aa")],
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0]?.[0];
    expect(entry?.targetPersonId).toBe("aa");
    expect(entry?.targetKind).toBe("eventSignup");
    expect(entry?.context).toEqual({
      signups: 3,
      retentionDaysAfterOccurrence: RETENTION_DAYS,
    });
  });
});
