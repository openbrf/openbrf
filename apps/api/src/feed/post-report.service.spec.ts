import { describe, expect, it, vi } from "vite-plus/test";

import { Prisma } from "../generated/prisma/client";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import { parseFeedCursor } from "./feed-cursor";
import { PostReportService, REPORTS_PER_WINDOW } from "./post-report.service";
import type { FeedError } from "./feed.error";

/**
 * The board's moderation: its one way into a group it cannot see, and its own
 * reading of Alla.
 *
 * **A report carries one post and nothing else.** Not the group, not its
 * members, not the line before it. What the queue answers is asserted field by
 * field for that reason: a view that grew a second post would be a view that
 * had opened the group.
 *
 * **A post in Alla or a group can be reported.** Styrelsen has no
 * strike-through at all - the board is the whole audience. That refusal is
 * said plainly rather than answered as an absence, because it is a rule the
 * product states out loud.
 *
 * **In Alla the board strikes without a report**, and only there: a group is
 * reached through a report alone (ADR 0012), and a post written as Styrelsen
 * is a news item.
 *
 * **A post in an audience this person is not in answers as one that does not
 * exist.** Otherwise a post identifier would be a way to find out what is
 * being said in groups somebody is not in.
 *
 * **One person reports one post once**, so a group cannot be turned into a
 * flood by one member pressing.
 *
 * **Striking is one act however many reports asked for it.** It closes every
 * open report on that post and writes one audit entry; a second strike on a
 * post already struck writes nothing and records nothing.
 *
 * **Dismissing writes no audit entry at all**, because nothing changed about who
 * can read what - what the board decided is on the report row, which is what the
 * person who reported it is shown. It closes every open report about that
 * post, as striking does: leaving one open would let the post be struck
 * afterwards through a sibling, which is the decision the board has just
 * declined to make.
 *
 * **A capability is not a seat.** The administrator holds `chat:moderate`
 * through the ADMIN grant and holds no board seat, and a report carries a
 * private group's post in full - so every path here asks the register for the
 * seat, and the queue says which of the two empty answers it is giving.
 *
 * What the database does with these rows is `group.int-spec.ts`.
 */

const GROUP_ID = "audience-garden";
const BOARD_ID = "audience-board";
const ALL_ID = "audience-all";
const POST_ID = "post-1";

const NILS = "person-nils";
const ASTRID = "person-astrid";
const BOARD_MEMBER = "person-bo";

interface PostFixture {
  id: string;
  audienceId: string;
  authorPersonId: string;
  /** Written as Styrelsen; absent on a resident's own. */
  byBoard?: boolean;
  body: string;
  struckAt: Date | null;
  struckByPersonId: string | null;
  createdAt: Date;
  /** Set on a post the purge has erased; absent on every other. */
  erasedAt?: Date | null;
}

interface ReportFixture {
  id: string;
  postId: string | null;
  commentId?: string | null;
  reporterPersonId: string;
  note: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByPersonId: string | null;
  upheld: boolean | null;
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

const THE_POST: PostFixture = {
  id: POST_ID,
  audienceId: GROUP_ID,
  authorPersonId: ASTRID,
  body: "Det har borde ingen skriva.",
  struckAt: null,
  struckByPersonId: null,
  createdAt: new Date("2026-03-02T09:00:00.000Z"),
};

/**
 * A database holding these groups, posts and reports.
 *
 * `members` is who is written into the group, and everybody in this fixture
 * lives here: what a residency decides is `group.service.spec.ts`, and what
 * this file is about is which post reaches the board.
 */
function build(options: {
  posts?: PostFixture[];
  reports?: ReportFixture[];
  members?: string[];
  /** Who holds a board seat. The board member alone, unless a test says so. */
  seatedPersonIds?: string[];
  /**
   * The other answer, landing while this one waits for the lock.
   *
   * The only moment it can: the claim below is conditional on the report still
   * being open, and the rows it reads are read after the lock.
   */
  whileWaiting?: (reports: ReportFixture[], posts: PostFixture[]) => void;
  /** The other report, landing between the read for it and the insert. */
  whileReading?: (reports: ReportFixture[]) => void;
  /** The images on each post, in the order they were attached. */
  images?: { postId: string; fileId: string; sortOrder: number }[];
}) {
  const images = options.images ?? [];
  const seated = options.seatedPersonIds ?? [NILS, BOARD_MEMBER];
  // Copied row by row rather than by the array, so a strike in one test cannot
  // reach the fixture the next one starts from.
  const posts = (options.posts ?? [THE_POST]).map((post) => ({
    ...post,
  }));
  const reports = (options.reports ?? []).map((report) => ({ ...report }));
  const members = options.members ?? [NILS, ASTRID];

  const audiences = [
    {
      id: GROUP_ID,
      kind: "GROUP" as const,
      name: "Trädgårdsgruppen",
      createdByPersonId: NILS,
    },
    {
      id: BOARD_ID,
      kind: "BOARD" as const,
      name: null,
      createdByPersonId: null,
    },
    {
      id: ALL_ID,
      kind: "ALL" as const,
      name: null,
      createdByPersonId: null,
    },
  ];

  const reportRow = (report: ReportFixture) => {
    const post = posts.find((each) => each.id === report.postId);
    return {
      ...report,
      commentId: report.commentId ?? null,
      comment: null,
      post: {
        ...post,
        audience: audiences.find(
          (audience) => audience.id === post?.audienceId,
        ),
        // Sorted here because the service asks for the attached order.
        images: images
          .filter((image) => image.postId === report.postId)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((image) => ({
            file: { id: image.fileId, width: 800, height: 600 },
          })),
      },
    };
  };

  /** Every advisory lock key an answer took, in order. */
  const locks: string[] = [];

  const client = {
    /*
     * The lock the board takes on the post before it answers a report about
     * it. Recorded rather than implemented - what one transaction waits for is
     * not something a fake in one process can show - and the hook below is how
     * a test says "the other answer landed while this one waited".
     */
    $executeRaw: vi.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        locks.push(String(values[0]));
        options.whileWaiting?.(reports, posts);
        return 1;
      },
    ),
    /*
     * The post's row read under a share lock, which is the one raw read the
     * service makes. Answered from the fixture as it stands after the lock, so
     * a strike or an erasure landing while the answer waited is what it reads.
     */
    $queryRaw: vi.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const post = posts.find((each) => each.id === values[0]);
        return post === undefined
          ? []
          : [
              {
                struckAt: post.struckAt,
                commentsAllowed: true,
                erasedAt: post.erasedAt ?? null,
              },
            ];
      },
    ),
    groupMember: {
      findUnique: vi.fn(
        async (args: {
          where: {
            audienceId_personId: { audienceId: string; personId: string };
          };
        }) =>
          members.includes(args.where.audienceId_personId.personId) &&
          args.where.audienceId_personId.audienceId === GROUP_ID
            ? { audienceId: GROUP_ID }
            : null,
      ),
    },
    residency: {
      // Everybody in this fixture lives here.
      findFirst: vi.fn(async () => ({ id: "residency-1" })),
    },
    person: {
      /*
       * A board seat, asked for two different questions: whether a post in
       * Styrelsen may be reached, and whether this account may answer a report.
       * Implemented on the fixture's own list rather than answered yes, because
       * the second question is the boundary between the board and the
       * instance's administrator.
       */
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        seated.includes(args.where.id) ? { id: args.where.id } : null,
      ),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        [NILS, ASTRID, BOARD_MEMBER]
          .filter((id) => args.where.id.in.includes(id))
          .map((id) => ({
            id,
            firstName: id === ASTRID ? "Astrid" : id === NILS ? "Nils" : "Bo",
            lastName: "Lindqvist",
            protectedPersonalData: false,
          })),
      ),
    },
    post: {
      /*
       * The feed's one read of a post by identifier, with its audience. Only a
       * post whose instant has come is in front of anybody: a scheduled one is
       * answered as one that is not there, which is the clause a fake ignoring
       * its `where` would let a service drop.
       */
      findFirst: vi.fn(
        async (args: { where: { id: string; createdAt: { lte: Date } } }) => {
          const post = posts.find(
            (each) =>
              each.id === args.where.id &&
              each.createdAt.getTime() <= args.where.createdAt.lte.getTime(),
          );
          return post === undefined
            ? null
            : {
                id: post.id,
                authorPersonId: post.authorPersonId,
                byBoard: post.byBoard ?? false,
                struckAt: post.struckAt,
                commentsAllowed: true,
                erasedAt: post.erasedAt ?? null,
                audience: audiences.find(
                  (audience) => audience.id === post.audienceId,
                ),
              };
        },
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          posts.find((post) => post.id === args.where.id) ?? null,
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id: string; struckAt: null; erasedAt?: null };
          data: { struckAt: Date; struckByPersonId: string };
        }) => {
          const post = posts.find(
            (each) =>
              each.id === args.where.id &&
              each.struckAt === null &&
              (args.where.erasedAt === undefined || !each.erasedAt),
          );
          if (post === undefined) {
            return { count: 0 };
          }
          post.struckAt = args.data.struckAt;
          post.struckByPersonId = args.data.struckByPersonId;
          return { count: 1 };
        },
      ),
    },
    postReport: {
      // How many reports one person has made since an instant: the budget.
      count: vi.fn(
        async (args: {
          where: { reporterPersonId: string; createdAt: { gte: Date } };
        }) =>
          reports.filter(
            (report) =>
              report.reporterPersonId === args.where.reporterPersonId &&
              report.createdAt.getTime() >= args.where.createdAt.gte.getTime(),
          ).length,
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const found = reports.find((report) => report.id === args.where.id);
        return found === undefined ? null : reportRow(found);
      }),
      /*
       * Whether this person has reported this post already. The other press
       * lands after this read has answered and before the insert: that is the
       * only gap there is, and what closes it is the constraint rather than
       * the read.
       */
      findFirst: vi.fn(
        async (args: {
          where: { postId: string; reporterPersonId: string };
        }) => {
          const found = reports.find(
            (report) =>
              report.postId === args.where.postId &&
              report.reporterPersonId === args.where.reporterPersonId,
          );
          options.whileReading?.(reports);
          return found === undefined ? null : { id: found.id };
        },
      ),
      /*
       * The open reports, oldest first and by identifier on a tie, from the
       * cursor's two halves when there is one: the ordering and the
       * comparison the queue is paged on.
       */
      findMany: vi.fn(
        async (args: {
          where: {
            resolvedAt: null;
            OR?: (
              | { createdAt: { gt: Date } }
              | { createdAt: Date; id: { gt: string } }
            )[];
          };
          take?: number;
        }) => {
          const after = (report: ReportFixture) =>
            args.where.OR === undefined ||
            args.where.OR.some((clause) =>
              clause.createdAt instanceof Date
                ? "id" in clause &&
                  report.createdAt.getTime() === clause.createdAt.getTime() &&
                  report.id > clause.id.gt
                : report.createdAt.getTime() > clause.createdAt.gt.getTime(),
            );
          const open = reports
            .filter(
              (report) =>
                report.resolvedAt === args.where.resolvedAt && after(report),
            )
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            )
            .map(reportRow);
          return args.take === undefined ? open : open.slice(0, args.take);
        },
      ),
      create: vi.fn(
        async (args: {
          data: {
            postId?: string;
            reporterPersonId: string;
            note: string | null;
          };
        }) => {
          /*
           * The constraint the table carries: one person reports one post
           * once. Raised here rather than assumed, because the read before the
           * insert is only the ordinary path - two presses arriving together
           * both pass it, and what answers the second is this.
           */
          if (
            reports.some(
              (report) =>
                report.postId === args.data.postId &&
                report.reporterPersonId === args.data.reporterPersonId,
            )
          ) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed",
              { code: "P2002", clientVersion: "test" },
            );
          }
          const row: ReportFixture = {
            id: `report-${String(reports.length + 1)}`,
            ...args.data,
            postId: args.data.postId ?? null,
            createdAt: new Date(),
            resolvedAt: null,
            resolvedByPersonId: null,
            upheld: null,
          };
          reports.push(row);
          return { id: row.id };
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id?: string; postId?: string; resolvedAt: null };
          data: {
            resolvedAt: Date;
            resolvedByPersonId: string;
            upheld: boolean;
          };
        }) => {
          const matching = reports.filter(
            (report) =>
              report.resolvedAt === null &&
              (args.where.id === undefined || report.id === args.where.id) &&
              (args.where.postId === undefined ||
                report.postId === args.where.postId),
          );
          for (const report of matching) {
            report.resolvedAt = args.data.resolvedAt;
            report.resolvedByPersonId = args.data.resolvedByPersonId;
            report.upheld = args.data.upheld;
          }
          return { count: matching.length };
        },
      ),
    },
  };

  const prisma = {
    ...client,
    $transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) =>
      work(client),
    ),
  };

  const audit = { record: vi.fn(async () => undefined) };

  return {
    service: new PostReportService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
    ),
    audit,
    posts,
    reports,
    locks,
  };
}

/** A report standing open against the post above. */
function openReport(
  reporterPersonId = NILS,
  note: string | null = "Det har handlar om min lagenhet.",
): ReportFixture {
  return {
    id: "report-1",
    postId: POST_ID,
    reporterPersonId,
    note,
    createdAt: new Date("2026-03-03T08:00:00.000Z"),
    resolvedAt: null,
    resolvedByPersonId: null,
    upheld: null,
  };
}

describe("reporting a post", () => {
  it("is open to somebody in the group", async () => {
    const { service, reports } = build({});

    const made = await service.report(
      principal(NILS, ["chat:participate"]),
      { postId: POST_ID },
      "Det har handlar om min lagenhet.",
    );

    expect(made.reportId).toBe("report-1");
    expect(reports).toHaveLength(1);
  });

  it("refuses somebody who is not in the group, as a post that is not there", async () => {
    const { service, reports } = build({ members: [ASTRID] });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "post-not-found" });
    expect(reports).toEqual([]);
  });

  it("refuses a post in Styrelsen, and says why", async () => {
    /*
     * The board is the whole audience, so there is nobody to report a
     * colleague's line to. Said plainly rather than answered as an absence: it
     * is a rule the product states, and nobody in that audience learns anything
     * from hearing it.
     */
    const { service, reports } = build({
      posts: [{ ...THE_POST, audienceId: BOARD_ID }],
    });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "not-reportable" });
    expect(reports).toEqual([]);
  });

  it("is open to a neighbour in Alla", async () => {
    /*
     * The board reads Alla already, and strikes there without being asked; a
     * report is a neighbour making sure it looks.
     */
    const { service, reports } = build({
      posts: [{ ...THE_POST, audienceId: ALL_ID }],
    });

    await service.report(
      principal(NILS, ["chat:participate"]),
      { postId: POST_ID },
      null,
    );

    expect(reports).toHaveLength(1);
  });

  it("refuses a report of one's own post, which the feed does not offer", async () => {
    // Carried out of a group, one's own words would reach the board as a
    // report the writer made of themselves.
    const { service, reports } = build({});

    await expect(
      service.report(
        principal(ASTRID, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "not-reportable" });
    expect(reports).toEqual([]);
  });

  it("refuses the board's report of a post in Alla, where it strikes instead", async () => {
    const { service, reports } = build({
      posts: [{ ...THE_POST, audienceId: ALL_ID }],
    });

    await expect(
      service.report(
        principal(BOARD_MEMBER, ["chat:participate", "chat:moderate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "not-reportable" });
    expect(reports).toEqual([]);
  });

  it("takes a board member's report out of a group they are in, where they are a member", async () => {
    const { service, reports } = build({ members: [NILS, BOARD_MEMBER] });

    await service.report(
      principal(BOARD_MEMBER, ["chat:participate", "chat:moderate"]),
      { postId: POST_ID },
      null,
    );

    expect(reports).toHaveLength(1);
  });

  it("refuses a reporter past the budget for the window, and counts only theirs", async () => {
    const recent = (id: string, reporterPersonId: string): ReportFixture => ({
      id,
      postId: `post-elsewhere-${id}`,
      reporterPersonId,
      note: null,
      createdAt: new Date(Date.now() - 60 * 1000),
      resolvedAt: null,
      resolvedByPersonId: null,
      upheld: null,
    });
    const full = Array.from({ length: REPORTS_PER_WINDOW }, (_, index) =>
      recent(`report-nils-${String(index)}`, NILS),
    );

    const refused = build({ reports: full });
    await expect(
      refused.service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "too-many-reports", status: 429 });
    expect(refused.reports).toHaveLength(REPORTS_PER_WINDOW);

    // Somebody else's reports are not this reporter's budget.
    const other = build({
      reports: full.map((report) => ({ ...report, reporterPersonId: ASTRID })),
      members: [NILS, ASTRID],
    });
    await other.service.report(
      principal(NILS, ["chat:participate"]),
      { postId: POST_ID },
      null,
    );
    expect(other.reports).toHaveLength(REPORTS_PER_WINDOW + 1);
  });

  it("refuses a report whose reporter made their last one while it waited for their lock", async () => {
    /*
     * Two presses on different posts, both past the first count with one
     * report of the allowance left. What stops the second is the count taken
     * again under the reporter's lock, after the first has committed; with only
     * the count before the lock, a reporter could make as many as they had
     * presses in flight.
     */
    const recent = (id: string): ReportFixture => ({
      id,
      postId: `post-elsewhere-${id}`,
      reporterPersonId: NILS,
      note: null,
      createdAt: new Date(Date.now() - 60 * 1000),
      resolvedAt: null,
      resolvedByPersonId: null,
      upheld: null,
    });
    let landed = false;
    const { service, reports } = build({
      reports: Array.from({ length: REPORTS_PER_WINDOW - 1 }, (_, index) =>
        recent(`report-nils-${String(index)}`),
      ),
      // The first lock an answer takes is the reporter's own.
      whileWaiting: (held) => {
        if (!landed) {
          landed = true;
          held.push(recent("report-raced"));
        }
      },
    });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "too-many-reports", status: 429 });
    expect(reports).toHaveLength(REPORTS_PER_WINDOW);
  });

  it("refuses a post written as Styrelsen, which is a news item", async () => {
    const { service, reports } = build({
      posts: [{ ...THE_POST, audienceId: ALL_ID, byBoard: true }],
    });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "not-reportable" });
    expect(reports).toEqual([]);
  });

  it("refuses a post not yet shown, as one that is not there", async () => {
    /*
     * A post scheduled for later is in nobody's feed until its instant, so an
     * identifier for it is one nobody was shown - answered exactly as an
     * identifier for nothing.
     */
    const { service, reports } = build({
      posts: [
        { ...THE_POST, createdAt: new Date(Date.now() + 60 * 60 * 1000) },
      ],
    });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "post-not-found" });
    expect(reports).toEqual([]);
  });

  it("refuses a second report of the same post by the same person", async () => {
    const { service, reports } = build({ reports: [openReport()] });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "already-reported" });
    expect(reports).toHaveLength(1);
  });

  it("refuses a note carrying a personal identity number, naming the field", async () => {
    /*
     * The note is resident-written text like every other piece here, and the
     * refusal names where the number is and never what it was.
     */
    const { service, reports } = build({});

    const refused = (await service
      .report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        "Han skrev 19811218-9876 i rummet.",
      )
      .catch((error: unknown) => error)) as FeedError;

    expect(refused.reason).toBe("personal-identity-number");
    expect(JSON.stringify(refused.details())).toContain('"note"');
    expect(JSON.stringify(refused.details())).not.toContain("19811218");
    expect(reports).toEqual([]);
  });

  it("answers a second press that arrives at the same moment with the refusal", async () => {
    /*
     * Two presses on one button, both past the read and into the insert. The
     * constraint is what settles it, and what the second one gets has to be the
     * sentence the first would have got rather than a fault: a reporter who
     * double-clicked has done nothing wrong, and the board has the post
     * either way.
     */
    const { service, reports } = build({
      whileReading: (held) => {
        held.push({ ...openReport(), id: "report-raced" });
      },
    });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "already-reported" });
    // One row, which is the whole of what the constraint is for.
    expect(reports).toHaveLength(1);
  });

  it("refuses a report that waited while the board struck the post", async () => {
    /*
     * The strike closes every open report on the post under the post's
     * lock. A report inserted after that would stay open on a struck post,
     * and dismissing it later would record the board leaving standing a
     * post that carries a strike.
     */
    const { service, reports, locks } = build({
      whileWaiting: (_reports, posts) => {
        const post = posts[0];
        if (post !== undefined) {
          post.struckAt = new Date();
        }
      },
    });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "report-resolved" });
    // The reporter's own lock for the budget first, as every write takes it.
    expect(locks).toEqual([`feed-person:${NILS}`, `post:${POST_ID}`]);
    expect(reports).toHaveLength(0);
  });

  it("refuses a post the purge has erased, which has nothing left to report", async () => {
    const { service, reports } = build({
      posts: [{ ...THE_POST, erasedAt: new Date("2026-03-04T03:47:00.000Z") }],
    });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "post-erased" });
    expect(reports).toHaveLength(0);
  });

  it("refuses a report that waited while the purge erased the post", async () => {
    /*
     * The purge takes the reports on a post with its text. A report inserted
     * after it would stand on an erased post, about words that are gone.
     */
    const { service, reports } = build({
      whileWaiting: (_reports, posts) => {
        const post = posts[0];
        if (post !== undefined) {
          post.erasedAt = new Date();
        }
      },
    });

    await expect(
      service.report(
        principal(NILS, ["chat:participate"]),
        { postId: POST_ID },
        null,
      ),
    ).rejects.toMatchObject({ reason: "post-erased" });
    expect(reports).toHaveLength(0);
  });

  it("writes no audit entry, because the report row is the record", async () => {
    const { service, audit } = build({});

    await service.report(
      principal(NILS, ["chat:participate"]),
      { postId: POST_ID },
      null,
    );

    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("the queue the board reads", () => {
  const board = principal(BOARD_MEMBER, ["chat:moderate"]);

  it("carries one post, who wrote it and who reported it, and no group", async () => {
    const { service } = build({ reports: [openReport()] });

    const { reports: queue } = await service.queue(board, null);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      reportId: "report-1",
      audienceKind: "GROUP",
      groupName: "Trädgårdsgruppen",
      postId: POST_ID,
      commentId: null,
      body: "Det har borde ingen skriva.",
      note: "Det har handlar om min lagenhet.",
      struckAt: null,
    });
    expect(queue[0]?.reporter).toMatchObject({ name: "Nils Lindqvist" });
    expect(queue[0]?.author).toMatchObject({ name: "Astrid Lindqvist" });
    // The group is named and never opened: nothing here is a way to ask for it.
    expect(Object.keys(queue[0] ?? {})).not.toContain("audienceId");
  });

  it("carries the post's images in the order they were attached, at the media route", async () => {
    const { service } = build({
      reports: [openReport()],
      images: [
        { postId: POST_ID, fileId: "file-b", sortOrder: 1 },
        { postId: POST_ID, fileId: "file-a", sortOrder: 0 },
        { postId: "post-elsewhere", fileId: "file-c", sortOrder: 0 },
      ],
    });

    const { reports: queue } = await service.queue(board, null);

    // A picture is part of what the board was asked to look at.
    expect(queue[0]?.images).toEqual([
      { id: "file-a", url: "/api/media/file-a", width: 800, height: 600 },
      { id: "file-b", url: "/api/media/file-b", width: 800, height: 600 },
    ]);
  });

  it("carries no images on a report read back after it was answered", async () => {
    // The media route no longer serves them through it, so a view that
    // listed them would be a promise of pictures that do not load.
    const { service } = build({
      reports: [openReport()],
      images: [{ postId: POST_ID, fileId: "file-a", sortOrder: 0 }],
    });

    const dismissed = await service.dismiss(board, "report-1");

    expect(dismissed.images).toEqual([]);
  });

  it("names Alla by its kind, with no group and nobody who made it", async () => {
    const { service } = build({
      posts: [{ ...THE_POST, audienceId: ALL_ID }],
      reports: [openReport()],
    });

    const { reports: queue } = await service.queue(board, null);

    expect(queue[0]).toMatchObject({
      audienceKind: "ALL",
      groupName: null,
      groupCreatedBy: null,
    });
  });

  it("reaches the reports past the first page, from the cursor it answered", async () => {
    /*
     * Fifty-one open reports, two of them written in the same instant at the
     * page boundary: the identifier breaks the tie, so the one left over is on
     * the next page and on neither page twice.
     */
    const instant = (minute: number) =>
      new Date(Date.UTC(2026, 2, 3, 8, minute));
    const many: ReportFixture[] = Array.from({ length: 51 }, (_, index) => ({
      ...openReport(`person-${String(index).padStart(2, "0")}`),
      id: `report-${String(index).padStart(2, "0")}`,
      createdAt: instant(index === 50 ? 49 : index),
    }));
    const { service } = build({ reports: many });

    const first = await service.queue(board, null);
    expect(first.reports).toHaveLength(50);
    expect(first.next).not.toBeNull();

    const cursor = parseFeedCursor(first.next ?? "");
    expect(cursor).not.toBeNull();
    const second = await service.queue(board, cursor);

    expect(second.reports.map((report) => report.reportId)).toEqual([
      "report-50",
    ]);
    expect(second.next).toBeNull();
    const seen = [...first.reports, ...second.reports].map(
      (report) => report.reportId,
    );
    expect(new Set(seen).size).toBe(51);
  });

  it("answers no next page when the queue fits on one", async () => {
    const { service } = build({ reports: [openReport()] });

    expect((await service.queue(board, null)).next).toBeNull();
  });

  it("leaves out what the board has already answered", async () => {
    const { service } = build({
      reports: [
        {
          ...openReport(),
          resolvedAt: new Date("2026-03-03T09:00:00.000Z"),
          resolvedByPersonId: BOARD_MEMBER,
          upheld: false,
        },
      ],
    });

    expect((await service.queue(board, null)).reports).toEqual([]);
  });
});

describe("an account with the capability and no seat", () => {
  /*
   * The instance's administrator. They hold every capability, they hold no seat,
   * and every group already refuses them, as Styrelsen does - so a queue that
   * handed them a private group's post in full would keep the promise on one path and
   * break it on the other.
   */
  const administrator = principal("person-admin", [
    "chat:participate",
    "chat:moderate",
  ]);

  it("is answered no queue, and told that the queue is not theirs", async () => {
    const { service } = build({ reports: [openReport()] });

    const answer = await service.queue(administrator, null);

    expect(answer.reports).toEqual([]);
    // Not "nothing has been reported": that is a statement about groups this
    // account may not be told exist.
    expect(answer.mayModerate).toBe(false);
  });

  it("cannot strike or dismiss, and the post stands", async () => {
    const { service, posts, reports } = build({ reports: [openReport()] });

    await expect(
      service.strike(administrator, "report-1"),
    ).rejects.toMatchObject({ reason: "report-not-found" });
    await expect(
      service.dismiss(administrator, "report-1"),
    ).rejects.toMatchObject({ reason: "report-not-found" });

    expect(posts[0]?.struckAt).toBeNull();
    expect(reports[0]?.resolvedAt).toBeNull();
  });

  it("is refused the same way a report that does not exist is", async () => {
    // One refusal for two cases, as everywhere else here: anything that told
    // them apart would say whether a private group has been reported.
    const { service } = build({ reports: [openReport()] });
    const board = principal(BOARD_MEMBER, ["chat:moderate"]);

    const withoutSeat = (await service
      .strike(administrator, "report-1")
      .catch((error: unknown) => error)) as FeedError;
    const notThere = (await service
      .strike(board, "report-9")
      .catch((error: unknown) => error)) as FeedError;

    expect(withoutSeat.reason).toBe(notThere.reason);
    expect(withoutSeat.status).toBe(notThere.status);
  });
});

describe("striking a post through", () => {
  const board = principal(BOARD_MEMBER, ["chat:moderate"]);

  it("marks the post, closes the report and records the act", async () => {
    const { service, audit, posts, reports } = build({
      reports: [openReport()],
    });

    const answered = await service.strike(board, "report-1");

    expect(posts[0]?.struckAt).not.toBeNull();
    expect(posts[0]?.struckByPersonId).toBe(BOARD_MEMBER);
    expect(reports[0]?.upheld).toBe(true);
    expect(reports[0]?.resolvedByPersonId).toBe(BOARD_MEMBER);
    expect(answered.struckAt).not.toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        // The audit vocabulary the chat wrote, kept so this entry reads as
        // every earlier strike does (ADR 0026).
        action: "CHAT_MESSAGE_STRUCK",
        actorPersonId: BOARD_MEMBER,
        // The subject is whoever wrote it: a moderation somebody else decided.
        targetPersonId: ASTRID,
        targetKind: "chatMessage",
        targetId: POST_ID,
      }),
      expect.anything(),
    );
  });

  it("strikes nothing on a post the purge erased while the answer waited", async () => {
    /*
     * The erasure took the report with the text. The answer is told the
     * report has gone, and nothing is struck or recorded: a strike on an
     * erased post would leave the board member's name the one thing on it.
     */
    const { service, audit, posts } = build({
      reports: [openReport()],
      whileWaiting: (_reports, rows) => {
        const post = rows[0];
        if (post !== undefined) {
          post.erasedAt = new Date();
        }
      },
    });

    await expect(service.strike(board, "report-1")).rejects.toMatchObject({
      reason: "report-not-found",
    });
    expect(posts[0]?.struckAt).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("keeps what was said out of the audit entry", async () => {
    const { service, audit } = build({ reports: [openReport()] });

    await service.strike(board, "report-1");

    const entry = audit.record.mock.calls.at(0)?.at(0) as unknown as {
      context: Record<string, unknown>;
    };
    // Which group, under the key every earlier entry carries it by, and
    // never what was said in it.
    expect(entry.context).toEqual({ chatId: GROUP_ID });
  });

  it("closes every other open report on the same post", async () => {
    // They were asking the same question and it has been answered; a queue that
    // kept asking would have the board decide one post twice.
    const { service, reports } = build({
      reports: [openReport(), { ...openReport(ASTRID, null), id: "report-2" }],
    });

    await service.strike(board, "report-1");

    expect(reports.every((report) => report.resolvedAt !== null)).toBe(true);
    expect(reports.every((report) => report.upheld === true)).toBe(true);
  });

  it("records nothing when the post was already struck", async () => {
    const { service, audit } = build({
      posts: [
        {
          ...THE_POST,
          struckAt: new Date("2026-03-03T09:00:00.000Z"),
          struckByPersonId: BOARD_MEMBER,
        },
      ],
      reports: [{ ...openReport(), id: "report-2" }],
    });

    await service.strike(board, "report-2");

    // Nothing written, nothing recorded - and the second report is closed all
    // the same, because it has been answered.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a report the board has already answered", async () => {
    const { service } = build({
      reports: [
        {
          ...openReport(),
          resolvedAt: new Date("2026-03-03T09:00:00.000Z"),
          resolvedByPersonId: BOARD_MEMBER,
          upheld: false,
        },
      ],
    });

    await expect(service.strike(board, "report-1")).rejects.toMatchObject({
      reason: "report-resolved",
    });
  });

  it("refuses a report that does not exist", async () => {
    const { service } = build({});

    await expect(service.strike(board, "report-9")).rejects.toMatchObject({
      reason: "report-not-found",
    });
  });
});

describe("two answers arriving together", () => {
  const board = principal(BOARD_MEMBER, ["chat:moderate"]);
  const second = principal("person-second-seat", ["chat:moderate"]);

  /** The other answer, landing while this one waits for the lock. */
  function answeredWhileWaiting(upheld: boolean, struck: boolean) {
    return (reports: ReportFixture[], posts: PostFixture[]): void => {
      for (const report of reports) {
        if (report.resolvedAt === null) {
          report.resolvedAt = new Date("2026-03-03T09:00:00.000Z");
          report.resolvedByPersonId = second.personId;
          report.upheld = upheld;
        }
      }
      const post = posts[0];
      if (struck && post !== undefined) {
        post.struckAt = new Date("2026-03-03T09:00:00.000Z");
        post.struckByPersonId = second.personId;
      }
    };
  }

  it("takes the post's own lock before it claims the report", async () => {
    /*
     * The decision is about the post rather than about one person's report
     * of it: answering one closes every report of that post. Two answers to
     * two reports of one line would otherwise both pass their own check, so the
     * key is the post - and it has to be the same key on both paths.
     */
    const { service, locks } = build({
      reports: [openReport()],
      seatedPersonIds: [NILS, BOARD_MEMBER, second.personId],
    });

    await service.strike(board, "report-1");

    expect(locks).toEqual([`post:${POST_ID}`]);
  });

  it("refuses the strike that arrives after a dismissal, and leaves the post standing", async () => {
    /*
     * The record is what this protects. A strike that went through after the
     * board had left the post standing would write CHAT_MESSAGE_STRUCK and
     * find no report of its own to update - so the row would say the board left
     * standing a post that carries a strike, which is worse than either
     * answer on its own.
     */
    const { service, posts, reports, audit } = build({
      reports: [openReport()],
      seatedPersonIds: [NILS, BOARD_MEMBER, second.personId],
      whileWaiting: answeredWhileWaiting(false, false),
    });

    await expect(service.strike(board, "report-1")).rejects.toMatchObject({
      reason: "report-resolved",
    });

    expect(posts[0]?.struckAt).toBeNull();
    expect(reports[0]?.upheld).toBe(false);
    expect(reports[0]?.resolvedByPersonId).toBe(second.personId);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses the dismissal that arrives after a strike, and the record says struck", async () => {
    const { service, posts, reports } = build({
      reports: [openReport()],
      seatedPersonIds: [NILS, BOARD_MEMBER, second.personId],
      whileWaiting: answeredWhileWaiting(true, true),
    });

    await expect(service.dismiss(board, "report-1")).rejects.toMatchObject({
      reason: "report-resolved",
    });

    expect(posts[0]?.struckAt).not.toBeNull();
    expect(reports[0]?.upheld).toBe(true);
  });
});

describe("leaving a post standing", () => {
  const board = principal(BOARD_MEMBER, ["chat:moderate"]);

  it("closes the report, touches the post and writes no entry", async () => {
    const { service, audit, posts, reports } = build({
      reports: [openReport()],
    });

    const answered = await service.dismiss(board, "report-1");

    expect(reports[0]?.upheld).toBe(false);
    expect(reports[0]?.resolvedByPersonId).toBe(BOARD_MEMBER);
    expect(posts[0]?.struckAt).toBeNull();
    expect(answered.struckAt).toBeNull();
    // Nothing changed about who can read what, so there is nothing to record.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("closes every other open report on the same post", async () => {
    /*
     * The board has decided about the post, not about one person's report of
     * it. A sibling left open would let the same post be struck through
     * afterwards - the decision this one declined to make, made by whoever
     * pressed next.
     */
    const { service, posts, reports } = build({
      reports: [openReport(), { ...openReport(ASTRID, null), id: "report-2" }],
    });

    await service.dismiss(board, "report-1");

    expect(reports.every((report) => report.resolvedAt !== null)).toBe(true);
    expect(reports.every((report) => report.upheld === false)).toBe(true);
    expect(posts[0]?.struckAt).toBeNull();
    // And the post cannot then be struck through the sibling.
    await expect(service.strike(board, "report-2")).rejects.toMatchObject({
      reason: "report-resolved",
    });
  });

  it("refuses one that is already answered, and one that is not there", async () => {
    const { service } = build({
      reports: [
        {
          ...openReport(),
          resolvedAt: new Date("2026-03-03T09:00:00.000Z"),
          resolvedByPersonId: BOARD_MEMBER,
          upheld: true,
        },
      ],
    });

    await expect(service.dismiss(board, "report-1")).rejects.toMatchObject({
      reason: "report-resolved",
    });
    await expect(service.dismiss(board, "report-9")).rejects.toMatchObject({
      reason: "report-not-found",
    });
  });
});

describe("striking a post in Alla without a report", () => {
  const board = principal(BOARD_MEMBER, ["chat:participate", "chat:moderate"]);
  const inAlla = { ...THE_POST, audienceId: ALL_ID };

  it("strikes a resident's post, closes its open reports and records the act", async () => {
    const { service, audit, posts, reports, locks } = build({
      posts: [inAlla],
      reports: [openReport()],
    });

    await service.strikePost(board, POST_ID);

    expect(posts[0]?.struckAt).not.toBeNull();
    expect(posts[0]?.struckByPersonId).toBe(BOARD_MEMBER);
    // A neighbour's report about it has been answered by the strike.
    expect(reports[0]?.upheld).toBe(true);
    expect(locks).toEqual([`post:${POST_ID}`]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHAT_MESSAGE_STRUCK",
        targetPersonId: ASTRID,
        targetKind: "chatMessage",
        targetId: POST_ID,
        context: { chatId: ALL_ID },
      }),
      expect.anything(),
    );
  });

  it("records nothing the second time", async () => {
    const { service, audit } = build({
      posts: [
        {
          ...inAlla,
          struckAt: new Date("2026-03-03T09:00:00.000Z"),
          struckByPersonId: BOARD_MEMBER,
        },
      ],
    });

    await service.strikePost(board, POST_ID);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a group's post, which the board reaches only through a report", async () => {
    /*
     * Even for a board member who is in the group and reads the post: there
     * they are a member, and the board's way in is somebody else carrying the
     * post out.
     */
    const { service, posts } = build({
      members: [NILS, ASTRID, BOARD_MEMBER],
    });

    await expect(service.strikePost(board, POST_ID)).rejects.toMatchObject({
      reason: "not-strikeable",
    });
    expect(posts[0]?.struckAt).toBeNull();
  });

  it("refuses a group's post to a board member outside it, as one that is not there", async () => {
    const { service } = build({});

    await expect(service.strikePost(board, POST_ID)).rejects.toMatchObject({
      reason: "post-not-found",
    });
  });

  it("refuses a post in Styrelsen, which has no strike-through", async () => {
    const { service } = build({
      posts: [{ ...THE_POST, audienceId: BOARD_ID }],
    });

    await expect(service.strikePost(board, POST_ID)).rejects.toMatchObject({
      reason: "not-strikeable",
    });
  });

  it("refuses a post written as Styrelsen, which is a news item", async () => {
    const { service } = build({ posts: [{ ...inAlla, byBoard: true }] });

    await expect(service.strikePost(board, POST_ID)).rejects.toMatchObject({
      reason: "not-strikeable",
    });
  });

  it("refuses an erased post", async () => {
    const { service } = build({
      posts: [{ ...inAlla, erasedAt: new Date("2026-03-04T03:47:00.000Z") }],
    });

    await expect(service.strikePost(board, POST_ID)).rejects.toMatchObject({
      reason: "post-erased",
    });
  });

  it("refuses a resident, who reads the post and is not the board", async () => {
    const { service, posts } = build({ posts: [inAlla] });

    await expect(
      service.strikePost(principal(NILS, ["chat:participate"]), POST_ID),
    ).rejects.toMatchObject({ reason: "not-board" });
    expect(posts[0]?.struckAt).toBeNull();
  });

  it("refuses a capability without a seat", async () => {
    // Somebody who lives here and holds `chat:moderate` without a seat is
    // not the board: the register decides, not the grant.
    const { service, posts } = build({
      posts: [inAlla],
      seatedPersonIds: [],
    });

    await expect(service.strikePost(board, POST_ID)).rejects.toMatchObject({
      reason: "not-board",
    });
    expect(posts[0]?.struckAt).toBeNull();
  });
});
