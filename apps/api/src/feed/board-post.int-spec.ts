import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type {
  AudienceListView,
  FeedPage,
  FeedUpdate,
  PostCommentView,
  PostView,
} from "@openbrf/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  NEWS_SCHEDULED_PUBLISH_QUEUE,
  NewsScheduleService,
} from "../news/news-schedule.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { BOARD_POSTS_PER_WRITE_WINDOW } from "./board-post.service";
import { feedCursor } from "./feed-cursor";

/**
 * The board's tools in the feed against a real database: a post written as
 * Styrelsen is a news item, published, mailed and scheduled on the news
 * module's own path.
 *
 * Five properties that only a real run can show.
 *
 *   A board seat holder writes as Styrelsen, named or not, and the house reads
 *   the post with its news item's title and text. The item is published to the
 *   members, or to the street when the board asks, through the transaction
 *   that wrote the post - so the item, the post and the audit entries commit
 *   together.
 *
 *   "Viktigt meddelande" claims the news mailing: the column, the ledger and the
 *   job, exactly as the news screen's publish writes them.
 *
 *   Pinned, comments off and scheduled are kept on the post and honoured on
 *   every read. A scheduled post is in nobody's feed and at no address until
 *   its job runs, the board sees it waiting, and when the job runs late the
 *   post is delivered by the next poll rather than skipped behind a cursor that
 *   passed its instant meanwhile.
 *
 *   Nobody but the board uses any of it. A resident, the administrator - who
 *   holds every capability and no seat - and a board member writing anywhere
 *   but Alla are refused by the server, whatever a screen offered them; and the
 *   board itself writes a bounded number in a window, because each one may be
 *   a mailing to every member.
 *
 *   A board seat holder answers under a post as Styrelsen, and nobody else
 *   does.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let schedule: NewsScheduleService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/** On the board: the person who writes as Styrelsen. */
const seated = {
  personId: `board-post-seated-${suffix}`,
  email: `board-post-seated-${suffix}@exempel.se`,
};
/** Holds every capability through the ADMIN grant, and holds no seat. */
const administrator = {
  personId: `board-post-admin-${suffix}`,
  email: `board-post-admin-${suffix}@exempel.se`,
};
/** A member who lives here: reads Alla and is mailed. */
const karin = {
  personId: `board-post-karin-${suffix}`,
  email: `board-post-karin-${suffix}@exempel.se`,
};

const personIds = [seated.personId, administrator.personId, karin.personId];

let addressId: string;
let apartmentId: string;
let seatedCookie: string;
let administratorCookie: string;
let karinCookie: string;
let allAudienceId: string;
let boardAudienceId: string;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.52.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.52.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
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

async function pageOf(cookie: string): Promise<FeedPage> {
  const response = await inject({
    method: "GET",
    url: "/api/feed/posts",
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<FeedPage>();
}

/** Writes as Styrelsen over HTTP, with the composer's defaults unless told. */
function writeAsBoard(cookie: string, overrides: Record<string, unknown> = {}) {
  return inject({
    method: "POST",
    url: "/api/feed/board-posts",
    headers: { cookie },
    payload: {
      audienceId: allAudienceId,
      title: `Vattnet stängs av ${suffix}`,
      body: "Tisdag 9-12.\n\nFyll en kanna kvällen före.",
      namesAuthor: false,
      ...overrides,
    },
  });
}

async function writtenAsBoard(
  overrides: Record<string, unknown> = {},
): Promise<PostView> {
  const response = await writeAsBoard(seatedCookie, overrides);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<PostView>();
}

/** How many scheduled publishes are queued for one item. */
async function queuedPublishes(newsId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    "SELECT count(*) AS count FROM pgboss.job WHERE name = $1 AND data->>'newsId' = $2",
    NEWS_SCHEDULED_PUBLISH_QUEUE,
    newsId,
  );
  return Number(rows[0]?.count ?? 0);
}

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
  schedule = app.get(NewsScheduleService);

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

  const encryption = app.get(FieldEncryptionService);
  const karinEmail = await encryption.encrypt("person.email", karin.email);

  await prisma.person.createMany({
    data: [
      { id: seated.personId, firstName: "Astrid", lastName: `Tavla${suffix}` },
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Tavla${suffix}`,
      },
      {
        id: karin.personId,
        firstName: "Karin",
        lastName: `Tavla${suffix}`,
        emailCipher: karinEmail.cipher,
        emailIndex: karinEmail.index,
      },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: seated.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });

  const address = await prisma.address.create({
    data: {
      street: `Tavlagatan ${suffix}`,
      number: "1",
      postalCode: "12345",
      city: "Stockholm",
    },
  });
  addressId = address.id;
  const apartment = await prisma.apartment.create({
    data: { addressId, number: `30${suffix.slice(-2)}` },
  });
  apartmentId = apartment.id;
  // A member, so the mailing has somebody to reach.
  await prisma.residency.create({
    data: {
      personId: karin.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2026-01-01"),
    },
  });

  const auth = app.get(AuthService);
  for (const who of [seated, administrator, karin]) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
  seatedCookie = await signIn(seated.email);
  administratorCookie = await signIn(administrator.email);
  karinCookie = await signIn(karin.email);

  const response = await inject({
    method: "GET",
    url: "/api/feed/audiences",
    headers: { cookie: seatedCookie },
  });
  const list = response.json<AudienceListView>();
  allAudienceId = list.audiences.find((each) => each.kind === "ALL")?.id ?? "";
  boardAudienceId =
    list.audiences.find((each) => each.kind === "BOARD")?.id ?? "";
});

afterAll(async () => {
  if (prisma !== undefined) {
    // Comments first: a comment's key to its post refuses a cascade. The news
    // items take their posts with them, and the ledger with them.
    await prisma.postComment.deleteMany({
      where: { authorPersonId: { in: personIds } },
    });
    await prisma.news.deleteMany({
      where: { authorPersonId: { in: personIds } },
    });
    await prisma.post.deleteMany({
      where: { authorPersonId: { in: personIds } },
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

/*
 * Every test starts with the board member's allowance whole: what the earlier
 * tests wrote is moved out of the window it is counted over, so a test asserts
 * what it is about rather than how many came before it.
 */
beforeEach(async () => {
  if (prisma !== undefined) {
    await prisma.news.updateMany({
      where: { authorPersonId: seated.personId },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
  }
});

describe("who may write as Styrelsen", () => {
  it("tells the board, and only the board, that it may", async () => {
    for (const [cookie, may] of [
      [seatedCookie, true],
      [karinCookie, false],
      [administratorCookie, false],
    ] as const) {
      const response = await inject({
        method: "GET",
        url: "/api/feed/audiences",
        headers: { cookie },
      });
      expect(response.json<AudienceListView>().mayPostAsBoard).toBe(may);
    }
  });

  it("refuses a resident and the administrator, whatever they send", async () => {
    for (const cookie of [karinCookie, administratorCookie]) {
      const response = await writeAsBoard(cookie);
      // The administrator is in no audience; the refusal that answers them is
      // still the board's, asked before anything about the audience.
      expect(response.statusCode).toBe(422);
      expect(response.json<{ reason: string }>().reason).toBe("not-board");
    }
    expect(
      await prisma.news.count({
        where: {
          authorPersonId: { in: [karin.personId, administrator.personId] },
        },
      }),
    ).toBe(0);
  });

  it("refuses the board's options on an ordinary post", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/feed/posts",
      headers: { cookie: karinCookie },
      payload: {
        audienceId: allAudienceId,
        body: "Viktigt!",
        important: true,
        pinned: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      await prisma.post.count({ where: { authorPersonId: karin.personId } }),
    ).toBe(0);
  });

  it("refuses a post as Styrelsen to Styrelsen itself", async () => {
    const response = await writeAsBoard(seatedCookie, {
      audienceId: boardAudienceId,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "board-post-audience",
    );
  });

  it("bounds how many posts one board member writes in a window", async () => {
    for (let n = 0; n < BOARD_POSTS_PER_WRITE_WINDOW; n += 1) {
      await writtenAsBoard({ title: `Lapp ${String(n)} ${suffix}` });
    }
    const response = await writeAsBoard(seatedCookie);
    expect(response.statusCode).toBe(429);
    expect(response.json<{ reason: string }>().reason).toBe("too-many-posts");
  });

  it("refuses an instant that has passed", async () => {
    const response = await writeAsBoard(seatedCookie, {
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "schedule-out-of-range",
    );
  });
});

describe("a post written as Styrelsen", () => {
  it("is a news item published to the members, read by the house", async () => {
    const post = await writtenAsBoard({ title: `Städdag ${suffix}` });

    expect(post.byBoard).toBe(true);
    expect(post.author).toBeNull();
    expect(post.body).toBeNull();
    expect(post.news?.title).toBe(`Städdag ${suffix}`);
    expect(post.news?.text).toBe("Tisdag 9-12.\n\nFyll en kanna kvällen före.");

    const item = await prisma.news.findUniqueOrThrow({
      where: { id: post.news?.id ?? "" },
      select: {
        published: true,
        visibility: true,
        authorPersonId: true,
        emailQueuedAt: true,
        content: true,
      },
    });
    expect(item).toMatchObject({
      published: true,
      visibility: "MEMBER",
      authorPersonId: seated.personId,
      emailQueuedAt: null,
    });
    expect((item.content as { blocks: unknown[] }).blocks).toHaveLength(2);

    const page = await pageOf(karinCookie);
    expect(page.posts.map((each) => each.id)).toContain(post.id);
    // Nothing waits for an instant, and a neighbour is never shown what does.
    expect(page.scheduled).toEqual([]);

    const actions = await prisma.auditLogEntry.findMany({
      where: { targetKind: "news", targetId: post.news?.id ?? "" },
      select: { action: true },
    });
    expect(actions.map((entry) => entry.action).sort()).toEqual([
      "NEWS_CONTENT_CHANGED",
      "NEWS_PUBLISHED",
    ]);
  });

  it("takes its address from its title, numbered when the title is taken", async () => {
    const title = `Sophämtning ${suffix}`;
    const first = await writtenAsBoard({ title });
    const second = await writtenAsBoard({ title });

    expect(first.news?.slug).toBe(`sophamtning-${suffix}`.toLowerCase());
    expect(second.news?.slug).toBe(`sophamtning-${suffix}-2`.toLowerCase());
  });

  it("keeps every paragraph, past what a body holds, in its last one", async () => {
    const paragraphs = Array.from(
      { length: 205 },
      (_, index) => `Rad ${String(index + 1)}.`,
    );
    const post = await writtenAsBoard({ body: paragraphs.join("\n\n") });

    const item = await prisma.news.findUniqueOrThrow({
      where: { id: post.news?.id ?? "" },
      select: { content: true },
    });
    const blocks = (item.content as { blocks: { runs: { text: string }[] }[] })
      .blocks;
    expect(blocks).toHaveLength(200);
    expect(blocks.at(-1)?.runs[0]?.text).toBe(
      paragraphs.slice(199).join("\n\n"),
    );
    expect(post.news?.text.endsWith("Rad 205.")).toBe(true);
  });

  it("names its writer when they chose to be named", async () => {
    const post = await writtenAsBoard({ namesAuthor: true });
    expect(post.author).toEqual({
      kind: "person",
      personId: seated.personId,
      name: `Astrid Tavla${suffix}`,
    });
  });

  it("is published to the street when the board asks", async () => {
    const post = await writtenAsBoard({ onWebsite: true });
    const item = await prisma.news.findUniqueOrThrow({
      where: { id: post.news?.id ?? "" },
      select: { visibility: true },
    });
    expect(item.visibility).toBe("PUBLIC");
  });

  it("sends the news mailing when it is important", async () => {
    const post = await writtenAsBoard({ important: true });
    expect(post.important).toBe(true);

    const newsId = post.news?.id ?? "";
    const item = await prisma.news.findUniqueOrThrow({
      where: { id: newsId },
      select: { emailQueuedAt: true },
    });
    expect(item.emailQueuedAt).not.toBeNull();
    const ledger = await prisma.newsDelivery.findMany({
      where: { newsId, personId: karin.personId },
      select: { channel: true },
    });
    expect(ledger).toEqual([{ channel: "EMAIL" }]);
    expect(
      await prisma.auditLogEntry.count({
        where: { targetId: newsId, action: "NEWS_EMAILED" },
      }),
    ).toBe(1);
  });

  it("is pinned on top, and the board can take the pin off", async () => {
    const post = await writtenAsBoard({ pinned: true });
    expect(post.pinned).toBe(true);
    expect((await pageOf(karinCookie)).pinned.map((each) => each.id)).toContain(
      post.id,
    );

    const refused = await inject({
      method: "DELETE",
      url: `/api/feed/posts/${post.id}/pin`,
      headers: { cookie: karinCookie },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ reason: string }>().reason).toBe("not-board");

    const unpinned = await inject({
      method: "DELETE",
      url: `/api/feed/posts/${post.id}/pin`,
      headers: { cookie: seatedCookie },
    });
    expect(unpinned.statusCode, unpinned.body).toBe(200);
    expect(unpinned.json<PostView>().pinned).toBe(false);
    const page = await pageOf(karinCookie);
    expect(page.pinned.map((each) => each.id)).not.toContain(post.id);
    expect(page.posts.map((each) => each.id)).toContain(post.id);
  });

  it("refuses a pin on a neighbour's post", async () => {
    const written = await inject({
      method: "POST",
      url: "/api/feed/posts",
      headers: { cookie: karinCookie },
      payload: { audienceId: allAudienceId, body: "Plommon vid grinden." },
    });
    expect(written.statusCode).toBe(201);
    const response = await inject({
      method: "PUT",
      url: `/api/feed/posts/${written.json<PostView>().id}/pin`,
      headers: { cookie: seatedCookie },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("not-pinnable");
  });

  it("takes no comment when the board turned comments off", async () => {
    const post = await writtenAsBoard({ commentsAllowed: false });
    expect(post.commentsAllowed).toBe(false);
    const response = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: karinCookie },
      payload: { body: "Gäller det hela huset?" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("comments-closed");
  });
});

describe("a scheduled post", () => {
  it("waits for the board alone, and the job publishes it into the next poll", async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000);
    const post = await writtenAsBoard({
      scheduledAt: at.toISOString(),
      important: true,
    });
    const newsId = post.news?.id ?? "";
    expect(post.scheduledAt).toBe(at.toISOString());

    // A draft, with its publish queued for the instant.
    const item = await prisma.news.findUniqueOrThrow({
      where: { id: newsId },
      select: { published: true, emailQueuedAt: true },
    });
    expect(item).toEqual({ published: false, emailQueuedAt: null });
    expect(await queuedPublishes(newsId)).toBe(1);

    // In nobody's feed and at no address but the board's list of what waits.
    const resident = await pageOf(karinCookie);
    expect(resident.posts.map((each) => each.id)).not.toContain(post.id);
    expect(resident.scheduled).toEqual([]);
    const byAddress = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}`,
      headers: { cookie: karinCookie },
    });
    expect(byAddress.statusCode).toBe(404);
    const board = await pageOf(seatedCookie);
    expect(board.scheduled.map((each) => each.id)).toEqual([post.id]);
    expect(board.posts.map((each) => each.id)).not.toContain(post.id);

    /*
     * The instant passes and the job is late: a neighbour polls in between and
     * carries a cursor past the instant the post was asked for.
     */
    await prisma.post.update({
      where: { id: post.id },
      data: {
        scheduledAt: new Date(Date.now() - 60_000),
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const cursor = feedCursor({ createdAt: new Date(), id: "zzzz" });

    await schedule.run({
      newsId,
      personId: seated.personId,
      sendEmail: true,
    });

    const published = await prisma.news.findUniqueOrThrow({
      where: { id: newsId },
      select: { published: true, emailQueuedAt: true },
    });
    expect(published.published).toBe(true);
    expect(published.emailQueuedAt).not.toBeNull();

    const polled = await inject({
      method: "GET",
      url: `/api/feed/posts/since?after=${encodeURIComponent(cursor)}`,
      headers: { cookie: karinCookie },
    });
    expect(polled.statusCode, polled.body).toBe(200);
    expect(polled.json<FeedUpdate>().posts.map((each) => each.id)).toContain(
      post.id,
    );
    expect((await pageOf(seatedCookie)).scheduled).toEqual([]);

    // A second run of the same job finds the item published and does nothing.
    await schedule.run({
      newsId,
      personId: seated.personId,
      sendEmail: true,
    });
    expect(
      await prisma.auditLogEntry.count({
        where: { targetId: newsId, action: "NEWS_PUBLISHED" },
      }),
    ).toBe(1);
  });
});

describe("a comment as Styrelsen", () => {
  it("is the board's to write, under a post to Alla", async () => {
    const post = await writtenAsBoard();

    const answered = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: seatedCookie },
      payload: { body: "Ja, hela huset.", asBoard: true },
    });
    expect(answered.statusCode, answered.body).toBe(201);
    const comment = answered.json<PostCommentView>();
    expect(comment.byBoard).toBe(true);
    // A comment always names its writer, as Styrelsen or not.
    expect(comment.author).toMatchObject({ personId: seated.personId });

    const refused = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: karinCookie },
      payload: { body: "Jag med.", asBoard: true },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ reason: string }>().reason).toBe("not-board");
  });

  it("is refused under a post to Styrelsen", async () => {
    const written = await inject({
      method: "POST",
      url: "/api/feed/posts",
      headers: { cookie: seatedCookie },
      payload: { audienceId: boardAudienceId, body: "Mötet flyttas." },
    });
    expect(written.statusCode).toBe(201);
    const response = await inject({
      method: "POST",
      url: `/api/feed/posts/${written.json<PostView>().id}/comments`,
      headers: { cookie: seatedCookie },
      payload: { body: "Noterat.", asBoard: true },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "board-post-audience",
    );
  });
});
