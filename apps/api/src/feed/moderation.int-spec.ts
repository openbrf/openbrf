import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type {
  AudienceListView,
  CreatedGroupView,
  PostCommentPage,
  PostCommentView,
  PostReportQueueView,
  PostReportView,
  PostView,
} from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { FeedPurgeService } from "./feed-purge.service";
import { REPORTS_PER_PAGE } from "./post-report.service";

/**
 * The board's moderation of the feed against a real database (ADR 0026).
 *
 *   In Alla the board strikes a resident's post or a comment through without
 *   a report, and a neighbour can report either to it. Each reader is told
 *   which of the two is theirs, and the server refuses the other.
 *
 *   In a group the board acts only on a report, even a board member who is in
 *   the group, and a report of a comment carries the comment and nothing of
 *   the post it answers.
 *
 *   The queue is paged forwards on `(createdAt, id)`, so the reports past the
 *   first page are reachable and each is on exactly one page.
 *
 *   A report of a comment goes with the comment and not with its post: the
 *   purge erasing the post leaves it asking, and the purge deleting the
 *   comment takes it.
 *
 * The rules decided before any row is written are
 * `post-report.service.spec.ts`; reports from a group are `group.int-spec.ts`.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: FeedPurgeService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/** Lives here, and writes. */
const nils = {
  personId: `moderation-nils-${suffix}`,
  email: `moderation-nils-${suffix}@exempel.se`,
};
/** Lives here, and answers and reports. */
const astrid = {
  personId: `moderation-astrid-${suffix}`,
  email: `moderation-astrid-${suffix}@exempel.se`,
};
/** Holds a board seat and lives nowhere. */
const boardMember = {
  personId: `moderation-board-${suffix}`,
  email: `moderation-board-${suffix}@exempel.se`,
};
/** Holds a board seat and lives here, so a group can have her in it. */
const berit = {
  personId: `moderation-berit-${suffix}`,
  email: `moderation-berit-${suffix}@exempel.se`,
};
/** Holds every capability through the ADMIN grant, and holds no seat. */
const administrator = {
  personId: `moderation-admin-${suffix}`,
  email: `moderation-admin-${suffix}@exempel.se`,
};
/** Wrote a year ago and has no account: the purge's. */
const olle = `moderation-olle-${suffix}`;

const personIds = [
  nils.personId,
  astrid.personId,
  boardMember.personId,
  berit.personId,
  administrator.personId,
  olle,
];

let addressId: string;
let apartmentId: string;
let allaId: string;
/** Olle's post, which the purge erases and so no longer names him. */
let ollesPostId: string | null = null;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.92.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.92.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        "accept-language": "sv-SE,sv;q=0.9",
        ...options.headers,
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

async function write(
  cookie: string,
  audienceId: string,
  body: string,
): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/feed/posts",
    payload: { audienceId, body },
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function comment(
  cookie: string,
  postId: string,
  body: string,
): Promise<string> {
  const response = await inject({
    method: "POST",
    url: `/api/feed/posts/${postId}/comments`,
    payload: { body },
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function makeGroup(cookie: string, members: string[]): Promise<string> {
  const made = await inject({
    method: "POST",
    url: "/api/feed/groups",
    payload: { name: `Tvättstugan ${suffix}` },
    headers: { cookie },
  });
  expect(made.statusCode, made.body).toBe(201);
  const { audienceId } = made.json<CreatedGroupView>();
  for (const personId of members) {
    const added = await inject({
      method: "POST",
      url: `/api/feed/groups/${audienceId}/members`,
      payload: { personId },
      headers: { cookie },
    });
    expect(added.statusCode, added.body).toBe(200);
  }
  return audienceId;
}

async function post(cookie: string, postId: string): Promise<PostView> {
  const response = await inject({
    method: "GET",
    url: `/api/feed/posts/${postId}`,
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PostView>();
}

async function commentsOf(
  cookie: string,
  postId: string,
): Promise<PostCommentView[]> {
  const response = await inject({
    method: "GET",
    url: `/api/feed/posts/${postId}/comments`,
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PostCommentPage>().comments;
}

async function report(
  cookie: string,
  subject: { postId: string } | { commentId: string },
) {
  return inject({
    method: "POST",
    url: "/api/feed/reports",
    payload: subject,
    headers: { cookie },
  });
}

/** Every open report the board's queue holds, read page by page to the end. */
async function wholeQueue(cookie: string): Promise<PostReportView[]> {
  const all: PostReportView[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const response = await inject({
      method: "GET",
      url: `/api/feed/reports${after === null ? "" : `?after=${encodeURIComponent(after)}`}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const answer = response.json<PostReportQueueView>();
    expect(answer.reports.length).toBeLessThanOrEqual(REPORTS_PER_PAGE);
    all.push(...answer.reports);
    if (answer.next === null) {
      return all;
    }
    after = answer.next;
  }
  throw new Error("The queue did not end within a hundred pages.");
}

let nilsCookie: string;
let astridCookie: string;
let boardCookie: string;
let beritCookie: string;
let administratorCookie: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  purge = app.get(FeedPurgeService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  const address = await prisma.address.create({
    data: {
      street: `Moderationsgatan ${suffix}`,
      number: "1",
      postalCode: "12345",
      city: "Stockholm",
    },
  });
  addressId = address.id;
  const apartment = await prisma.apartment.create({
    data: { addressId, number: `20${suffix.slice(-2)}` },
  });
  apartmentId = apartment.id;

  await prisma.person.createMany({
    data: [
      { id: nils.personId, firstName: "Nils", lastName: `Mod${suffix}` },
      { id: astrid.personId, firstName: "Astrid", lastName: `Mod${suffix}` },
      { id: boardMember.personId, firstName: "Bo", lastName: `Mod${suffix}` },
      { id: berit.personId, firstName: "Berit", lastName: `Mod${suffix}` },
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Mod${suffix}`,
      },
      { id: olle, firstName: "Olle", lastName: `Mod${suffix}` },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });
  await prisma.residency.createMany({
    data: [nils.personId, astrid.personId, berit.personId].map((personId) => ({
      personId,
      apartmentId,
      role: "RESIDENT" as const,
      movedInOn: new Date("2026-01-01"),
    })),
  });
  await prisma.boardPosition.createMany({
    data: [boardMember.personId, berit.personId].map((personId) => ({
      personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2026-01-01"),
    })),
  });

  const auth = app.get(AuthService);
  for (const who of [nils, astrid, boardMember, berit, administrator]) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  nilsCookie = await signIn(nils.email);
  astridCookie = await signIn(astrid.email);
  boardCookie = await signIn(boardMember.email);
  beritCookie = await signIn(berit.email);
  administratorCookie = await signIn(administrator.email);

  const audiences = await inject({
    method: "GET",
    url: "/api/feed/audiences",
    headers: { cookie: nilsCookie },
  });
  const alla = audiences
    .json<AudienceListView>()
    .audiences.find((audience) => audience.kind === "ALL");
  if (alla === undefined) {
    throw new Error("Somebody who lives here is not in Alla.");
  }
  allaId = alla.id;
});

afterAll(async () => {
  if (prisma !== undefined) {
    const groups = await prisma.audience.findMany({
      where: { createdByPersonId: { in: personIds } },
      select: { id: true },
    });
    const audienceIds = groups.map((group) => group.id);
    // The comments first: a comment's key to its post refuses the cascade.
    await prisma.postComment.deleteMany({
      where: {
        OR: [
          { authorPersonId: { in: personIds } },
          { post: { audienceId: { in: audienceIds } } },
        ],
      },
    });
    await prisma.audience.deleteMany({ where: { id: { in: audienceIds } } });
    await prisma.post.deleteMany({
      where: {
        OR: [
          { authorPersonId: { in: personIds } },
          ...(ollesPostId === null ? [] : [{ id: ollesPostId }]),
        ],
      },
    });
    await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.systemRole.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.boardPosition.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.residency.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.apartment.deleteMany({ where: { id: apartmentId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
  }
  await app?.close();
});

describe("a resident's post in Alla", () => {
  it("offers the neighbours the report and the board the strike, and its writer neither", async () => {
    const postId = await write(nilsCookie, allaId, `Hissen igen ${suffix}`);

    const toNeighbour = await post(astridCookie, postId);
    expect(toNeighbour).toMatchObject({ mayReport: true, mayStrike: false });

    const toBoard = await post(boardCookie, postId);
    // The board strikes rather than reporting to itself.
    expect(toBoard).toMatchObject({ mayReport: false, mayStrike: true });

    const toWriter = await post(nilsCookie, postId);
    expect(toWriter).toMatchObject({ mayReport: false, mayStrike: false });
  });

  it("can be reported, and reaches the queue named by its audience", async () => {
    const postId = await write(nilsCookie, allaId, `Grannens bil ${suffix}`);

    const made = await report(astridCookie, { postId });
    expect(made.statusCode, made.body).toBe(201);

    const queued = (await wholeQueue(boardCookie)).find(
      (each) => each.postId === postId,
    );
    expect(queued).toMatchObject({
      audienceKind: "ALL",
      groupName: null,
      groupCreatedBy: null,
      commentId: null,
      body: `Grannens bil ${suffix}`,
    });
  });

  it("is struck by the board without a report, withheld from the house and kept for its writer", async () => {
    const postId = await write(nilsCookie, allaId, `Rad i Alla ${suffix}`);
    const made = await report(astridCookie, { postId });
    const { reportId } = made.json<{ reportId: string }>();

    const struck = await inject({
      method: "POST",
      url: `/api/feed/posts/${postId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(struck.statusCode, struck.body).toBe(200);
    expect(struck.json<PostView>()).toMatchObject({
      struckAt: expect.any(String),
      // The board still reads what it struck.
      body: `Rad i Alla ${suffix}`,
      mayStrike: false,
      mayReport: false,
    });

    expect((await post(astridCookie, postId)).body).toBeNull();
    expect((await post(nilsCookie, postId)).body).toBe(`Rad i Alla ${suffix}`);

    // The neighbour's report has been answered by the strike.
    const row = await prisma.postReport.findUnique({
      where: { id: reportId },
      select: { resolvedAt: true, upheld: true },
    });
    expect(row).toMatchObject({ resolvedAt: expect.any(Date), upheld: true });
    expect(
      (await wholeQueue(boardCookie)).map((each) => each.reportId),
    ).not.toContain(reportId);

    // One act, one entry, and a second press records nothing.
    const again = await inject({
      method: "POST",
      url: `/api/feed/posts/${postId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(again.statusCode).toBe(200);
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "CHAT_MESSAGE_STRUCK", targetId: postId },
      }),
    ).toBe(1);
  });

  it("is refused to a resident, and to the administrator as a post that is not there", async () => {
    const postId = await write(nilsCookie, allaId, `Ingen stryker ${suffix}`);

    const byResident = await inject({
      method: "POST",
      url: `/api/feed/posts/${postId}/strike`,
      headers: { cookie: astridCookie },
    });
    // A resident does not hold the board's capability at all.
    expect(byResident.statusCode).toBe(403);

    const byAdministrator = await inject({
      method: "POST",
      url: `/api/feed/posts/${postId}/strike`,
      headers: { cookie: administratorCookie },
    });
    expect(byAdministrator.statusCode).toBe(404);

    expect(
      (await prisma.post.findUnique({ where: { id: postId } }))?.struckAt,
    ).toBeNull();
  });
});

describe("where the board does not strike without a report", () => {
  it("refuses a post in Styrelsen, which has no strike-through", async () => {
    const audiences = await inject({
      method: "GET",
      url: "/api/feed/audiences",
      headers: { cookie: boardCookie },
    });
    const styrelsen = audiences
      .json<AudienceListView>()
      .audiences.find((audience) => audience.kind === "BOARD");
    const postId = await write(
      beritCookie,
      styrelsen?.id ?? "",
      `Styrelsens rad ${suffix}`,
    );

    expect(await post(boardCookie, postId)).toMatchObject({
      mayStrike: false,
      mayReport: false,
    });
    const refused = await inject({
      method: "POST",
      url: `/api/feed/posts/${postId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ reason: string }>().reason).toBe("not-strikeable");
  });

  it("refuses a group's post and comment even to a board member in the group", async () => {
    /*
     * In the group Berit is a member like any other. The board's way into a
     * group is somebody else carrying one post or comment out of it.
     */
    const audienceId = await makeGroup(nilsCookie, [berit.personId]);
    const postId = await write(nilsCookie, audienceId, `I gruppen ${suffix}`);
    const commentId = await comment(beritCookie, postId, "Svar i gruppen.");

    expect(await post(beritCookie, postId)).toMatchObject({
      mayStrike: false,
      mayReport: true,
    });

    for (const url of [
      `/api/feed/posts/${postId}/strike`,
      `/api/feed/comments/${commentId}/strike`,
    ]) {
      const refused = await inject({
        method: "POST",
        url,
        headers: { cookie: beritCookie },
      });
      expect(refused.statusCode, url).toBe(422);
      expect(refused.json<{ reason: string }>().reason, url).toBe(
        "not-strikeable",
      );

      // And a board member outside the group is answered as for nothing.
      const outside = await inject({
        method: "POST",
        url,
        headers: { cookie: boardCookie },
      });
      expect(outside.statusCode, url).toBe(404);
    }
  });
});

describe("a comment", () => {
  it("in Alla is struck by the board without a report", async () => {
    const postId = await write(nilsCookie, allaId, `Fråga ${suffix}`);
    const commentId = await comment(astridCookie, postId, "Ett elakt svar.");

    const [offered] = await commentsOf(boardCookie, postId);
    expect(offered).toMatchObject({ mayStrike: true, mayReport: false });
    const [toWriter] = await commentsOf(nilsCookie, postId);
    expect(toWriter).toMatchObject({ mayStrike: false, mayReport: true });

    const struck = await inject({
      method: "POST",
      url: `/api/feed/comments/${commentId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(struck.statusCode, struck.body).toBe(200);
    expect(struck.json<PostCommentView>()).toMatchObject({
      id: commentId,
      struckAt: expect.any(String),
      body: "Ett elakt svar.",
      mayStrike: false,
    });

    expect((await commentsOf(nilsCookie, postId))[0]?.body).toBeNull();
    expect((await commentsOf(astridCookie, postId))[0]?.body).toBe(
      "Ett elakt svar.",
    );
    expect(
      await prisma.auditLogEntry.count({
        where: {
          action: "CHAT_MESSAGE_STRUCK",
          targetKind: "postComment",
          targetId: commentId,
          targetPersonId: astrid.personId,
        },
      }),
    ).toBe(1);
  });

  it("reported out of a group carries itself and nothing of its post", async () => {
    const audienceId = await makeGroup(nilsCookie, [astrid.personId]);
    const postId = await write(
      nilsCookie,
      audienceId,
      `Gruppens rad ${suffix}`,
    );
    const commentId = await comment(astridCookie, postId, "Svar som anmäls.");

    const made = await report(nilsCookie, { commentId });
    expect(made.statusCode, made.body).toBe(201);
    const { reportId } = made.json<{ reportId: string }>();

    const queued = (await wholeQueue(boardCookie)).find(
      (each) => each.reportId === reportId,
    );
    expect(queued).toMatchObject({
      audienceKind: "GROUP",
      groupName: `Tvättstugan ${suffix}`,
      commentId,
      // Not the post it answers, and not where to find it.
      postId: null,
      body: "Svar som anmäls.",
      images: [],
    });
    expect(JSON.stringify(queued)).not.toContain(`Gruppens rad ${suffix}`);

    const struck = await inject({
      method: "POST",
      url: `/api/feed/reports/${reportId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(struck.statusCode, struck.body).toBe(200);
    expect(struck.json<PostReportView>().struckAt).not.toBeNull();

    // Withheld from the group, kept for its writer, and the post untouched.
    expect((await commentsOf(nilsCookie, postId))[0]?.body).toBeNull();
    expect((await commentsOf(astridCookie, postId))[0]?.body).toBe(
      "Svar som anmäls.",
    );
    expect((await post(nilsCookie, postId)).struckAt).toBeNull();

    // Answered, so a second report is told so.
    const second = await report(nilsCookie, { commentId });
    expect(second.statusCode).toBe(422);
    expect(second.json<{ reason: string }>().reason).toBe("report-resolved");
  });

  it("is reported once by one person, beside a report of its post", async () => {
    const postId = await write(nilsCookie, allaId, `Två anmälningar ${suffix}`);
    const commentId = await comment(nilsCookie, postId, "Och ett svar.");

    expect((await report(astridCookie, { postId })).statusCode).toBe(201);
    expect((await report(astridCookie, { commentId })).statusCode).toBe(201);

    const twice = await report(astridCookie, { commentId });
    expect(twice.statusCode).toBe(422);
    expect(twice.json<{ reason: string }>().reason).toBe("already-reported");
  });

  it("refuses a body naming both a post and a comment", async () => {
    const postId = await write(nilsCookie, allaId, `Båda ${suffix}`);
    const commentId = await comment(nilsCookie, postId, "Svar.");

    const refused = await report(astridCookie, {
      postId,
      commentId,
    } as unknown as { postId: string });
    expect(refused.statusCode).toBe(400);
  });
});

describe("the queue", () => {
  it("reaches every open report past the first page, each on one page only", async () => {
    /*
     * More than a page of this run's own reports, written straight into the
     * table with instants that tie at the page boundary. Other suites' reports
     * may share the queue, so the assertion is about this run's alone.
     */
    const count = REPORTS_PER_PAGE + 7;
    const base = Date.UTC(2020, 0, 1, 12);
    const posts = Array.from({ length: count }, (_, index) => ({
      id: `moderation-page-${suffix}-${String(index).padStart(3, "0")}`,
      audienceId: allaId,
      authorPersonId: nils.personId,
      body: `Sida ${String(index)}`,
      createdAt: new Date(base),
    }));
    await prisma.post.createMany({ data: posts });
    await prisma.postReport.createMany({
      data: posts.map((each, index) => ({
        id: `moderation-report-${suffix}-${String(index).padStart(3, "0")}`,
        postId: each.id,
        reporterPersonId: astrid.personId,
        // Pairs sharing an instant, so the identifier has to break the tie.
        createdAt: new Date(base + Math.floor(index / 2) * 1000),
      })),
    });

    const mine = (await wholeQueue(boardCookie))
      .map((each) => each.reportId)
      .filter((id) => id.startsWith(`moderation-report-${suffix}-`));

    expect(mine).toHaveLength(count);
    expect(new Set(mine).size).toBe(count);
    // Oldest first, and by identifier within an instant.
    expect(mine).toEqual([...mine].sort());
  });

  it("refuses a cursor it did not issue", async () => {
    const refused = await inject({
      method: "GET",
      url: "/api/feed/reports?after=not-a-cursor",
      headers: { cookie: boardCookie },
    });
    expect(refused.statusCode).toBe(400);
  });
});

describe("a report of a comment, and the purge", () => {
  it("stands when the post above it is erased, and goes with the comment", async () => {
    const yearAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const old = await prisma.post.create({
      data: {
        audienceId: allaId,
        authorPersonId: olle,
        body: `Gammal rad ${suffix}`,
        createdAt: yearAgo,
      },
      select: { id: true },
    });
    ollesPostId = old.id;
    const commentId = await comment(astridCookie, old.id, "Ett nytt svar.");
    const made = await report(nilsCookie, { commentId });
    expect(made.statusCode, made.body).toBe(201);
    const { reportId } = made.json<{ reportId: string }>();

    // Olle's year is up: his post is erased, and the comment under it stands.
    await purge.purgePerson(olle, new Date(), 365);
    expect(
      (await prisma.post.findUnique({ where: { id: old.id } }))?.erasedAt,
    ).not.toBeNull();
    expect(
      await prisma.postReport.findUnique({ where: { id: reportId } }),
    ).not.toBeNull();

    // The comment goes, on Astrid's own clock, and its report with it.
    await prisma.postComment.delete({ where: { id: commentId } });
    expect(
      await prisma.postReport.findUnique({ where: { id: reportId } }),
    ).toBeNull();
  });

  it("is about one thing, which the table holds", async () => {
    const postId = await write(nilsCookie, allaId, `Begränsning ${suffix}`);
    const commentId = await comment(nilsCookie, postId, "Svar.");

    await expect(
      prisma.postReport.create({
        data: { postId, commentId, reporterPersonId: berit.personId },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.postReport.create({
        data: { reporterPersonId: berit.personId },
      }),
    ).rejects.toThrow();
  });
});
