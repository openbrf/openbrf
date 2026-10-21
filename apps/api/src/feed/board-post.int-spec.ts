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
  PostImageView,
  PostView,
} from "@openbrf/shared";
import {
  afterAll,
  afterEach,
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
import { registerMultipart } from "../http/multipart";
import { pngBytes } from "../media/testing/image-fixtures";
import { multipartImage } from "./testing/multipart-image";
import { newsAddressOf } from "../news/news-audience";
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
 *   holds every capability and no seat - and a board member writing into a
 *   group are refused by the server, whatever a screen offered them; and the
 *   board itself writes a bounded number in a window, because each one may be
 *   a mailing to every member.
 *
 *   Written to Styrelsen or Administratörer, the item is that audience's
 *   alone: read in the feed by the audience and nobody else, on no website, no
 *   news screen and in no news thread, and mailed to the audience's members.
 *
 *   A scheduled item is published once, at the moment it is first published -
 *   by the job or by a board member ahead of it - and the job never overrides
 *   a publication or a take-down that came first.
 *
 *   A board seat holder answers under a post as Styrelsen, in every audience a
 *   post as Styrelsen may go to, and nobody else does.
 *
 *   The seat is asked every time: when it has ended, the route refuses every
 *   board act, and a post the board member scheduled before it ended is left a
 *   draft by the job rather than published and mailed as Styrelsen - hidden
 *   from residents and from the feed after its instant, still among the
 *   scheduled posts for the board that remains, and withdrawn by that board,
 *   from the feed when it is to Styrelsen or Administratörer. A draft to Alla
 *   is also on the news screen, where an administrator sees it.
 *
 *   A scheduled post is reached by no route before its instant - not to read,
 *   comment on, like, mark read or pin, and not by its images - for the board
 *   that wrote it no more than for the house.
 */

const baseEnv = loadEnvForIntegrationTests();

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

/**
 * Held a seat once, and holds it only while a test in "a board seat that has
 * ended" gives it back: everywhere else they are a neighbour, so the suite's
 * other board member is never the one whose seat is taken away and no mailing
 * to Styrelsen counts them.
 */
const leaver = {
  personId: `board-post-leaver-${suffix}`,
  email: `board-post-leaver-${suffix}@exempel.se`,
};

const personIds = [
  seated.personId,
  administrator.personId,
  karin.personId,
  leaver.personId,
];

let addressId: string;
let apartmentId: string;
let seatedCookie: string;
let administratorCookie: string;
let karinCookie: string;
let leaverCookie: string;
let allAudienceId: string;
let boardAudienceId: string;
let adminAudienceId: string;
let groupId: string;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.64.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.64.${String(subnet)}.${String(host + 1)}`;
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

/**
 * Waits until some session is blocked on taking a news item's row: the job,
 * queued behind the board member's transaction. Bounded, so a job that never
 * waits fails the test on its assertions rather than hanging it.
 */
async function waitForRowLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query LIKE 'SELECT 1 FROM news WHERE id = $1 FOR UPDATE%'
    `;
    if (Number(row?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  // The images on a post are uploaded as multipart, like every upload.
  await registerMultipart(app, baseEnv);
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
  const seatedEmail = await encryption.encrypt("person.email", seated.email);
  const administratorEmail = await encryption.encrypt(
    "person.email",
    administrator.email,
  );
  const leaverEmail = await encryption.encrypt("person.email", leaver.email);

  await prisma.person.createMany({
    data: [
      {
        id: seated.personId,
        firstName: "Astrid",
        lastName: `Tavla${suffix}`,
        emailCipher: seatedEmail.cipher,
        emailIndex: seatedEmail.index,
      },
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Tavla${suffix}`,
        emailCipher: administratorEmail.cipher,
        emailIndex: administratorEmail.index,
      },
      {
        id: karin.personId,
        firstName: "Karin",
        lastName: `Tavla${suffix}`,
        emailCipher: karinEmail.cipher,
        emailIndex: karinEmail.index,
      },
      {
        id: leaver.personId,
        firstName: "Lennart",
        lastName: `Tavla${suffix}`,
        emailCipher: leaverEmail.cipher,
        emailIndex: leaverEmail.index,
      },
    ],
  });
  await prisma.boardPosition.createMany({
    data: [seated, leaver].map((who) => ({
      personId: who.personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2026-01-01"),
      endedOn: who === leaver ? new Date("2026-06-30") : null,
    })),
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
  /*
   * The board member lives here too, without holding the apartment - so they
   * can be in a group, and are still not among the members a mailing to the
   * house reaches.
   */
  await prisma.residency.create({
    data: {
      personId: seated.personId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2026-01-01"),
    },
  });
  // Lives here as a resident, so what is left of them after the seat ends is a
  // neighbour who reads Alla and may comment as themselves.
  await prisma.residency.create({
    data: {
      personId: leaver.personId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2026-01-01"),
    },
  });
  const group = await prisma.audience.create({
    data: {
      kind: "GROUP",
      name: `Trädgården ${suffix}`,
      createdByPersonId: karin.personId,
      members: {
        create: [
          { personId: karin.personId, addedByPersonId: karin.personId },
          { personId: seated.personId, addedByPersonId: karin.personId },
        ],
      },
    },
  });
  groupId = group.id;

  const auth = app.get(AuthService);
  for (const who of [seated, administrator, karin, leaver]) {
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
  leaverCookie = await signIn(leaver.email);

  const response = await inject({
    method: "GET",
    url: "/api/feed/audiences",
    headers: { cookie: seatedCookie },
  });
  const list = response.json<AudienceListView>();
  allAudienceId = list.audiences.find((each) => each.kind === "ALL")?.id ?? "";
  boardAudienceId =
    list.audiences.find((each) => each.kind === "BOARD")?.id ?? "";
  adminAudienceId =
    list.audiences.find((each) => each.kind === "ADMIN")?.id ?? "";
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
    await prisma.audience.deleteMany({ where: { id: groupId } });
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

  it("refuses a post as Styrelsen into a group, even one the writer is in", async () => {
    const response = await writeAsBoard(seatedCookie, { audienceId: groupId });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "board-post-audience",
    );
  });

  it("refuses the website for a post anywhere but Alla", async () => {
    for (const audienceId of [boardAudienceId, adminAudienceId]) {
      const response = await writeAsBoard(seatedCookie, {
        audienceId,
        onWebsite: true,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json<{ reason: string }>().reason).toBe(
        "board-post-audience",
      );
    }
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

  it("takes no comment through the news screen either, and keeps what was written readable", async () => {
    const post = await writtenAsBoard({ commentsAllowed: false });
    const newsId = post.news?.id ?? "";
    // Written before the thread was closed, or by a path that no longer exists:
    // a closed thread is read, it only takes nothing more.
    const standing = await prisma.postComment.create({
      data: {
        postId: post.id,
        authorPersonId: karin.personId,
        body: "Skrivet innan tråden stängdes.",
      },
      select: { id: true },
    });

    const viaFeed = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: karinCookie },
      payload: { body: "Gäller det hela huset?" },
    });
    expect(viaFeed.statusCode).toBe(422);
    expect(viaFeed.json<{ reason: string }>().reason).toBe("comments-closed");

    const viaNews = await inject({
      method: "POST",
      url: `/api/news-comments/${newsId}`,
      headers: { cookie: karinCookie },
      payload: { body: "Gäller det hela huset?" },
    });
    expect(viaNews.statusCode).toBe(422);
    expect(viaNews.json<{ reason: string }>().reason).toBe("comments-closed");

    expect(
      await prisma.postComment.findMany({
        where: { postId: post.id },
        select: { id: true },
      }),
    ).toEqual([standing]);

    const feedThread = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: karinCookie },
    });
    expect(feedThread.statusCode, feedThread.body).toBe(200);
    expect(feedThread.body).toContain(standing.id);
    const newsThread = await inject({
      method: "GET",
      url: `/api/news-comments/${newsId}`,
      headers: { cookie: karinCookie },
    });
    expect(newsThread.statusCode, newsThread.body).toBe(200);
    expect(newsThread.body).toContain(standing.id);

    // And the news screen is told, so it offers no form that could only fail.
    const reader = await inject({
      method: "GET",
      url: "/api/news-reader",
      headers: { cookie: karinCookie },
    });
    expect(reader.statusCode, reader.body).toBe(200);
    expect(
      reader
        .json<{ id: string; commentsAllowed: boolean }[]>()
        .find((each) => each.id === newsId)?.commentsAllowed,
    ).toBe(false);
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

  it("appears when a board member publishes it by hand, ahead of its instant", async () => {
    const at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const post = await writtenAsBoard({
      scheduledAt: at.toISOString(),
      important: true,
    });
    const newsId = post.news?.id ?? "";

    const before = Date.now();
    const published = await inject({
      method: "POST",
      url: `/api/news/${newsId}/publish`,
      headers: { cookie: seatedCookie },
      payload: { published: true, sendEmail: false },
    });
    expect(published.statusCode, published.body).toBe(201);

    // In the house's feed now, stamped when it went up, and waiting no more.
    const row = await prisma.post.findUniqueOrThrow({
      where: { id: post.id },
      select: { createdAt: true },
    });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await pageOf(karinCookie)).posts.map((each) => each.id)).toContain(
      post.id,
    );
    expect((await pageOf(seatedCookie)).scheduled).toEqual([]);

    // The job, when it comes, leaves the board member's choice alone.
    await schedule.run({ newsId, personId: seated.personId, sendEmail: true });
    const item = await prisma.news.findUniqueOrThrow({
      where: { id: newsId },
      select: { emailQueuedAt: true },
    });
    expect(item.emailQueuedAt).toBeNull();
    expect(await mailedTo(newsId)).toEqual([]);
  });

  /*
   * The job and a board member at the same moment. The board member's
   * transaction holds the item's row while the job starts, and commits a
   * publication without the mailing - or a publication and a take-down - only
   * once the job is waiting for that row. A job that asked "never published?"
   * before taking the row would have its answer already, and act on it.
   */
  for (const [what, manual] of [
    ["a publication without the mailing", { published: true }],
    ["a publication taken down again", { published: false }],
  ] as const) {
    it(`does nothing when ${what} commits while it waits for the item`, async () => {
      const post = await writtenAsBoard({
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        important: true,
      });
      const newsId = post.news?.id ?? "";

      let locked!: () => void;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let commit!: () => void;
      const committing = new Promise<void>((resolve) => {
        commit = resolve;
      });
      const boardMember = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM news WHERE id = ${newsId} FOR UPDATE`;
          locked();
          await committing;
          await tx.news.update({
            where: { id: newsId },
            data: { published: manual.published, publishedAt: new Date() },
          });
        },
        { timeout: 30_000 },
      );
      await holding;

      const job = schedule.run({
        newsId,
        personId: seated.personId,
        sendEmail: true,
      });
      await waitForRowLockWaiter();
      commit();
      await boardMember;
      await job;

      const item = await prisma.news.findUniqueOrThrow({
        where: { id: newsId },
        select: { published: true, emailQueuedAt: true },
      });
      expect(item).toEqual({
        published: manual.published,
        emailQueuedAt: null,
      });
      expect(await mailedTo(newsId)).toEqual([]);
      expect(
        await prisma.auditLogEntry.count({
          where: { targetId: newsId, action: "NEWS_PUBLISHED" },
        }),
      ).toBe(0);
    });
  }
});

/** Whether a news item is in the board's list on the news screen. */
async function onNewsScreen(newsId: string): Promise<boolean> {
  const response = await inject({
    method: "GET",
    url: "/api/news",
    headers: { cookie: administratorCookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ id: string }[]>().some((item) => item.id === newsId);
}

/** Who the mailing of an item was snapshotted for. */
async function mailedTo(newsId: string): Promise<string[]> {
  const rows = await prisma.newsDelivery.findMany({
    where: { newsId, channel: "EMAIL" },
    select: { personId: true },
  });
  return rows.map((row) => row.personId).sort();
}

describe("a post written as Styrelsen to Styrelsen or Administratörer", () => {
  it("is read by Styrelsen alone, and mailed to it alone", async () => {
    const post = await writtenAsBoard({
      audienceId: boardAudienceId,
      title: `Budgetutkast ${suffix}`,
      important: true,
    });
    const newsId = post.news?.id ?? "";
    const slug = post.news?.slug ?? "";
    expect(post.audience.kind).toBe("BOARD");

    // A news item, published, as every post written as Styrelsen is.
    const item = await prisma.news.findUniqueOrThrow({
      where: { id: newsId },
      select: { published: true, emailQueuedAt: true },
    });
    expect(item.published).toBe(true);
    expect(item.emailQueuedAt).not.toBeNull();

    // The board reads it in the feed; nobody outside Styrelsen does.
    expect((await pageOf(seatedCookie)).posts.map((each) => each.id)).toContain(
      post.id,
    );
    for (const cookie of [karinCookie, administratorCookie]) {
      expect((await pageOf(cookie)).posts.map((each) => each.id)).not.toContain(
        post.id,
      );
      const byAddress = await inject({
        method: "GET",
        url: `/api/feed/posts/${post.id}`,
        headers: { cookie },
      });
      expect(byAddress.statusCode).toBe(404);
    }

    // On no website, no news screen and in no news thread.
    const article = await inject({
      method: "GET",
      url: `/nyheter/${slug}`,
      headers: { cookie: karinCookie },
    });
    expect(article.statusCode).toBe(404);
    expect(await onNewsScreen(newsId)).toBe(false);
    const byId = await inject({
      method: "GET",
      url: `/api/news/${newsId}`,
      headers: { cookie: administratorCookie },
    });
    expect(byId.statusCode).toBe(404);
    const publish = await inject({
      method: "POST",
      url: `/api/news/${newsId}/publish`,
      headers: { cookie: administratorCookie },
      payload: { published: false },
    });
    expect(publish.statusCode).toBe(404);
    const reader = await inject({
      method: "GET",
      url: "/api/news-reader",
      headers: { cookie: karinCookie },
    });
    expect(reader.statusCode, reader.body).toBe(200);
    expect(
      reader.json<{ id: string }[]>().map((each) => each.id),
    ).not.toContain(newsId);
    const thread = await inject({
      method: "GET",
      url: `/api/news-comments/${newsId}`,
      headers: { cookie: administratorCookie },
    });
    expect(thread.statusCode).toBe(404);
    /*
     * At an address made of nothing it says, so the news screen's refusal of
     * an address another item holds tells nobody outside Styrelsen its title.
     */
    expect(slug).toMatch(/^intern-/u);
    const sameTitle = await inject({
      method: "POST",
      url: "/api/news",
      headers: { cookie: administratorCookie },
      payload: {
        slug: `budgetutkast-${suffix}`.toLowerCase(),
        title: `Budgetutkast ${suffix}`,
        content: { blocks: [] },
      },
    });
    expect(sameTitle.statusCode, sameTitle.body).toBe(201);

    // Mailed to the board, and not to the member who is not on it.
    expect(await mailedTo(newsId)).toEqual([seated.personId]);
    expect(
      await newsAddressOf(
        prisma,
        { id: newsId, slug },
        "https://brf.exempel.se",
      ),
    ).toBe(`https://brf.exempel.se/app/feed/${post.id}`);
  });

  it("to Administratörer is read by the administrators and the board", async () => {
    const audiences = await inject({
      method: "GET",
      url: "/api/feed/audiences",
      headers: { cookie: administratorCookie },
    });
    // The one audience the administrator is in, and still not the board.
    expect(
      audiences.json<AudienceListView>().audiences.map((each) => each.kind),
    ).toEqual(["ADMIN"]);
    expect(audiences.json<AudienceListView>().mayPostAsBoard).toBe(false);

    const post = await writtenAsBoard({
      audienceId: adminAudienceId,
      title: `Ny medlem att lägga in ${suffix}`,
      important: true,
      namesAuthor: true,
    });
    const newsId = post.news?.id ?? "";

    expect(
      (await pageOf(administratorCookie)).posts.map((each) => each.id),
    ).toContain(post.id);
    expect(
      (await pageOf(karinCookie)).posts.map((each) => each.id),
    ).not.toContain(post.id);
    expect(await onNewsScreen(newsId)).toBe(false);
    expect(await mailedTo(newsId)).toEqual(
      [administrator.personId, seated.personId].sort(),
    );

    // The administrator answers in their own name.
    const answered = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: administratorCookie },
      payload: { body: "Inlagd." },
    });
    expect(answered.statusCode, answered.body).toBe(201);
    expect(answered.json<PostCommentView>().byBoard).toBe(false);
  });

  it("waits as a draft when scheduled, and the job mails the audience alone", async () => {
    const post = await writtenAsBoard({
      audienceId: boardAudienceId,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      important: true,
    });
    const newsId = post.news?.id ?? "";
    // Waiting, for the board, in the audience it is going to.
    const waiting = await inject({
      method: "GET",
      url: `/api/feed/posts?audience=${boardAudienceId}`,
      headers: { cookie: seatedCookie },
    });
    expect(waiting.json<FeedPage>().scheduled.map((each) => each.id)).toContain(
      post.id,
    );

    await schedule.run({ newsId, personId: seated.personId, sendEmail: true });

    expect(await mailedTo(newsId)).toEqual([seated.personId]);
    expect(
      (await pageOf(karinCookie)).posts.map((each) => each.id),
    ).not.toContain(post.id);
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

  it("reads as the board's on the news screen too, naming its writer", async () => {
    const post = await writtenAsBoard();
    const newsId = post.news?.id ?? "";
    const answered = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: seatedCookie },
      payload: { body: "Styrelsen svarar: ja.", asBoard: true },
    });
    expect(answered.statusCode, answered.body).toBe(201);
    const written = answered.json<PostCommentView>();
    const mine = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: seatedCookie },
      payload: { body: "Och jag själv håller med." },
    });
    expect(mine.statusCode, mine.body).toBe(201);
    const personal = mine.json<PostCommentView>();

    // One thread, read by a resident through both screens.
    const feedThread = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: karinCookie },
    });
    expect(feedThread.statusCode, feedThread.body).toBe(200);
    const inFeed = feedThread.json<{ comments: PostCommentView[] }>().comments;
    expect(inFeed.find((each) => each.id === written.id)?.byBoard).toBe(true);
    expect(inFeed.find((each) => each.id === personal.id)?.byBoard).toBe(false);

    const newsThread = await inject({
      method: "GET",
      url: `/api/news-comments/${newsId}`,
      headers: { cookie: karinCookie },
    });
    expect(newsThread.statusCode, newsThread.body).toBe(200);
    const onNews = newsThread.json<{
      comments: { id: string; byBoard: boolean; author: unknown }[];
    }>().comments;
    expect(onNews.find((each) => each.id === written.id)).toMatchObject({
      byBoard: true,
      author: { kind: "resident", personId: seated.personId },
    });
    expect(onNews.find((each) => each.id === personal.id)).toMatchObject({
      byBoard: false,
      author: { kind: "resident", personId: seated.personId },
    });
  });

  it("is the board's to write under a post to Styrelsen or Administratörer", async () => {
    for (const audienceId of [boardAudienceId, adminAudienceId]) {
      const written = await inject({
        method: "POST",
        url: "/api/feed/posts",
        headers: { cookie: seatedCookie },
        payload: { audienceId, body: "Mötet flyttas." },
      });
      expect(written.statusCode, written.body).toBe(201);
      const response = await inject({
        method: "POST",
        url: `/api/feed/posts/${written.json<PostView>().id}/comments`,
        headers: { cookie: seatedCookie },
        payload: { body: "Noterat.", asBoard: true },
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<PostCommentView>()).toMatchObject({
        byBoard: true,
        author: { personId: seated.personId },
      });
    }
  });

  it("is refused under a post in a group, and to a reader outside the audience", async () => {
    const inGroup = await inject({
      method: "POST",
      url: "/api/feed/posts",
      headers: { cookie: karinCookie },
      payload: { audienceId: groupId, body: "Vem har sekatören?" },
    });
    expect(inGroup.statusCode, inGroup.body).toBe(201);
    const refused = await inject({
      method: "POST",
      url: `/api/feed/posts/${inGroup.json<PostView>().id}/comments`,
      headers: { cookie: seatedCookie },
      payload: { body: "Styrelsen har en.", asBoard: true },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ reason: string }>().reason).toBe(
      "board-post-audience",
    );

    // Membership first: a post in Styrelsen is not there for the administrator.
    const toBoard = await writtenAsBoard({ audienceId: boardAudienceId });
    const outside = await inject({
      method: "POST",
      url: `/api/feed/posts/${toBoard.id}/comments`,
      headers: { cookie: administratorCookie },
      payload: { body: "Hej." },
    });
    expect(outside.statusCode).toBe(404);
  });
});

/** Ends the seat on the board a person holds, as the register records it. */
async function endSeat(personId: string): Promise<void> {
  await prisma.boardPosition.updateMany({
    where: { personId },
    data: { endedOn: new Date("2026-06-30") },
  });
}

/** Gives the seat back, so a test that ends it starts from a seated member. */
async function restoreSeat(personId: string): Promise<void> {
  await prisma.boardPosition.updateMany({
    where: { personId },
    data: { endedOn: null },
  });
}

/** Moves a scheduled post's instant a minute into the past, as when its job runs. */
async function pastItsInstant(postId: string): Promise<void> {
  const passed = new Date(Date.now() - 60_000);
  await prisma.post.update({
    where: { id: postId },
    data: { scheduledAt: passed, createdAt: passed },
  });
}

/** A cursor from before the post's instant, so a poll from it can return the post. */
function cursorBeforeItsInstant() {
  return feedCursor({ createdAt: new Date(Date.now() - 120_000), id: "zzzz" });
}

/** That a poll from a cursor taken before the post's instant does not return it. */
async function expectNotPolled(
  cookie: string,
  cursor: string,
  postId: string,
): Promise<void> {
  const polled = await inject({
    method: "GET",
    url: `/api/feed/posts/since?after=${encodeURIComponent(cursor)}`,
    headers: { cookie },
  });
  expect(polled.statusCode, polled.body).toBe(200);
  expect(polled.json<FeedUpdate>().posts.map((each) => each.id)).not.toContain(
    postId,
  );
}

/** That the job left an item a draft: not published, mailed or recorded. */
async function expectLeftADraft(newsId: string): Promise<void> {
  const item = await prisma.news.findUniqueOrThrow({
    where: { id: newsId },
    select: { published: true, publishedAt: true, emailQueuedAt: true },
  });
  expect(item).toEqual({
    published: false,
    publishedAt: null,
    emailQueuedAt: null,
  });
  expect(await mailedTo(newsId)).toEqual([]);
  expect(
    await prisma.auditLogEntry.count({
      where: { targetId: newsId, action: "NEWS_PUBLISHED" },
    }),
  ).toBe(0);
}

/** That a reader is shown a post nowhere: not in the feed, not by address. */
async function expectHiddenFrom(cookie: string, postId: string): Promise<void> {
  const page = await pageOf(cookie);
  expect(page.posts.map((each) => each.id)).not.toContain(postId);
  expect(page.scheduled.map((each) => each.id)).not.toContain(postId);
  const byAddress = await inject({
    method: "GET",
    url: `/api/feed/posts/${postId}`,
    headers: { cookie },
  });
  expect(byAddress.statusCode).toBe(404);
}

describe("a board seat that has ended", () => {
  afterEach(async () => {
    await endSeat(leaver.personId);
  });

  it("refuses every board act at the route, whatever the person held before", async () => {
    await restoreSeat(leaver.personId);
    const post = await writtenAsBoard({ pinned: true });
    await endSeat(leaver.personId);

    const may = await inject({
      method: "GET",
      url: "/api/feed/audiences",
      headers: { cookie: leaverCookie },
    });
    expect(may.json<AudienceListView>().mayPostAsBoard).toBe(false);

    const written = await writeAsBoard(leaverCookie);
    expect(written.statusCode).toBe(422);
    expect(written.json<{ reason: string }>().reason).toBe("not-board");

    for (const method of ["PUT", "DELETE"] as const) {
      const pinned = await inject({
        method,
        url: `/api/feed/posts/${post.id}/pin`,
        headers: { cookie: leaverCookie },
      });
      expect(pinned.statusCode).toBe(422);
      expect(pinned.json<{ reason: string }>().reason).toBe("not-board");
    }

    const asBoard = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: leaverCookie },
      payload: { body: "Från styrelsen.", asBoard: true },
    });
    expect(asBoard.statusCode).toBe(422);
    expect(asBoard.json<{ reason: string }>().reason).toBe("not-board");

    // As a neighbour they still comment, and it is not the board's.
    const asThemselves = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: leaverCookie },
      payload: { body: "En granne." },
    });
    expect(asThemselves.statusCode, asThemselves.body).toBe(201);
    expect(asThemselves.json<PostCommentView>().byBoard).toBe(false);

    expect(
      await prisma.news.count({ where: { authorPersonId: leaver.personId } }),
    ).toBe(0);
    expect(
      (
        await prisma.post.findUniqueOrThrow({
          where: { id: post.id },
          select: { pinnedAt: true },
        })
      ).pinnedAt,
    ).not.toBeNull();
  });

  it("leaves a post they scheduled a draft when its job runs, for the board that remains", async () => {
    await restoreSeat(leaver.personId);
    const written = await writeAsBoard(leaverCookie, {
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      important: true,
    });
    expect(written.statusCode, written.body).toBe(201);
    const post = written.json<PostView>();
    const newsId = post.news?.id ?? "";
    const slug = post.news?.slug ?? "";
    await endSeat(leaver.personId);
    // The instant comes; the cursor is older than the post, so a poll from
    // it would return the post if it were shown.
    const cursor = cursorBeforeItsInstant();
    await pastItsInstant(post.id);

    await schedule.run({
      newsId,
      personId: leaver.personId,
      sendEmail: true,
    });

    await expectLeftADraft(newsId);

    // The board that remains sees it waiting, and residents do not: not in
    // their feed, not at the post's address, not by a poll from a cursor
    // older than the post, and not on the website.
    expect(
      (await pageOf(seatedCookie)).scheduled.map((each) => each.id),
    ).toContain(post.id);
    await expectHiddenFrom(karinCookie, post.id);
    await expectNotPolled(karinCookie, cursor, post.id);
    const article = await inject({
      method: "GET",
      url: `/nyheter/${slug}`,
      headers: { cookie: karinCookie },
    });
    expect(article.statusCode).toBe(404);

    // The board can take it away on the news screen, where every draft for
    // the house is.
    expect(await onNewsScreen(newsId)).toBe(true);
    const removed = await inject({
      method: "DELETE",
      url: `/api/news/${newsId}`,
      headers: { cookie: seatedCookie },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await prisma.news.count({ where: { id: newsId } })).toBe(0);
  });

  /*
   * One to Styrelsen or Administratörer is on no news screen, so the feed's
   * withdrawal is the only way the board that remains can remove it. Without
   * it the draft would keep the departed member's words and name in the
   * board's list for good.
   */
  for (const [label, audienceOf] of [
    ["Styrelsen", () => boardAudienceId],
    ["Administratörer", () => adminAudienceId],
  ] as const) {
    it(`leaves one they scheduled to ${label} a draft, which the board withdraws in the feed`, async () => {
      await restoreSeat(leaver.personId);
      const written = await writeAsBoard(leaverCookie, {
        audienceId: audienceOf(),
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        important: true,
      });
      expect(written.statusCode, written.body).toBe(201);
      const post = written.json<PostView>();
      const newsId = post.news?.id ?? "";
      await endSeat(leaver.personId);
      const cursor = cursorBeforeItsInstant();
      await pastItsInstant(post.id);

      await schedule.run({
        newsId,
        personId: leaver.personId,
        sendEmail: true,
      });

      await expectLeftADraft(newsId);

      // Waiting for the board alone: not in the audience's feed, and not in
      // the hands of the member who wrote it, whose seat has ended.
      expect(
        (await pageOf(seatedCookie)).scheduled.map((each) => each.id),
      ).toContain(post.id);
      for (const cookie of [karinCookie, administratorCookie, leaverCookie]) {
        await expectHiddenFrom(cookie, post.id);
        await expectNotPolled(cookie, cursor, post.id);
      }

      // On no news screen, so the news screen cannot remove it.
      expect(await onNewsScreen(newsId)).toBe(false);
      const onNews = await inject({
        method: "DELETE",
        url: `/api/news/${newsId}`,
        headers: { cookie: seatedCookie },
      });
      expect(onNews.statusCode).toBe(404);

      // Nobody but the board withdraws it: not its writer, now off the
      // board, and not the administrator, who holds no seat.
      for (const cookie of [leaverCookie, administratorCookie]) {
        const refused = await inject({
          method: "DELETE",
          url: `/api/feed/board-posts/${post.id}`,
          headers: { cookie },
        });
        expect(refused.statusCode).toBe(422);
        expect(refused.json<{ reason: string }>().reason).toBe("not-board");
      }

      const withdrawn = await inject({
        method: "DELETE",
        url: `/api/feed/board-posts/${post.id}`,
        headers: { cookie: seatedCookie },
      });
      expect(withdrawn.statusCode, withdrawn.body).toBe(204);
      expect(await prisma.news.count({ where: { id: newsId } })).toBe(0);
      expect(await prisma.post.count({ where: { id: post.id } })).toBe(0);
      expect(
        (await pageOf(seatedCookie)).scheduled.map((each) => each.id),
      ).not.toContain(post.id);
    });
  }

  it("publishes a post scheduled by a member whose seat is still held", async () => {
    await restoreSeat(leaver.personId);
    const written = await writeAsBoard(leaverCookie, {
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const newsId = written.json<PostView>().news?.id ?? "";

    await schedule.run({
      newsId,
      personId: leaver.personId,
      sendEmail: false,
    });

    expect(
      (
        await prisma.news.findUniqueOrThrow({
          where: { id: newsId },
          select: { published: true },
        })
      ).published,
    ).toBe(true);
  });
});

describe("pinning a post written as Styrelsen", () => {
  it("is refused to a resident, in both directions, and the pin is untouched", async () => {
    const post = await writtenAsBoard({ pinned: true });

    for (const method of ["PUT", "DELETE"] as const) {
      const refused = await inject({
        method,
        url: `/api/feed/posts/${post.id}/pin`,
        headers: { cookie: karinCookie },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json<{ reason: string }>().reason).toBe("not-board");
    }
    expect((await pageOf(karinCookie)).pinned.map((each) => each.id)).toContain(
      post.id,
    );

    const unpinned = await writtenAsBoard();
    const refusedPin = await inject({
      method: "PUT",
      url: `/api/feed/posts/${unpinned.id}/pin`,
      headers: { cookie: karinCookie },
    });
    expect(refusedPin.statusCode).toBe(422);
    expect(
      (await pageOf(karinCookie)).pinned.map((each) => each.id),
    ).not.toContain(unpinned.id);
  });
});

describe("a scheduled post before its instant", () => {
  async function uploadedBy(cookie: string): Promise<PostImageView> {
    const body = multipartImage(
      pngBytes(32, 24),
      "anslag.png",
      baseEnv.APP_URL,
    );
    const response = await inject({
      method: "POST",
      url: "/api/feed/images",
      headers: { cookie, ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<PostImageView>();
  }

  it("is reached by no route, for its writer as for the house, until the job publishes it", async () => {
    const image = await uploadedBy(seatedCookie);
    const post = await writtenAsBoard({
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      imageIds: [image.id],
    });
    const newsId = post.news?.id ?? "";
    const cursor = feedCursor({ createdAt: new Date(), id: "zzzz" });
    const url = `/api/feed/posts/${post.id}`;

    for (const cookie of [seatedCookie, karinCookie]) {
      const attempts = [
        { method: "GET", url },
        { method: "POST", url: `${url}/read` },
        { method: "PUT", url: `${url}/like` },
        { method: "DELETE", url: `${url}/like` },
        { method: "GET", url: `${url}/comments` },
        {
          method: "GET",
          url: `${url}/comments/since?after=${encodeURIComponent(cursor)}`,
        },
        { method: "POST", url: `${url}/comments`, payload: { body: "Hej." } },
        { method: "GET", url: image.url },
      ] as const;
      for (const attempt of attempts) {
        const response = await inject({ ...attempt, headers: { cookie } });
        expect(
          response.statusCode,
          `${attempt.method} ${attempt.url} by ${cookie === seatedCookie ? "the board" : "a resident"}: ${response.body}`,
        ).toBe(404);
      }
    }
    const asBoard = await inject({
      method: "POST",
      url: `${url}/comments`,
      headers: { cookie: seatedCookie },
      payload: { body: "Från styrelsen.", asBoard: true },
    });
    expect(asBoard.statusCode).toBe(404);

    // The pin is the board's to take or leave, and a post nobody reads yet has
    // none to take: the board is told there is no such post, a resident that
    // it is not theirs to pin.
    for (const method of ["PUT", "DELETE"] as const) {
      const byBoard = await inject({
        method,
        url: `${url}/pin`,
        headers: { cookie: seatedCookie },
      });
      expect(byBoard.statusCode, byBoard.body).toBe(404);
      const byResident = await inject({
        method,
        url: `${url}/pin`,
        headers: { cookie: karinCookie },
      });
      expect(byResident.statusCode, byResident.body).toBe(422);
    }

    expect(await prisma.postComment.count({ where: { postId: post.id } })).toBe(
      0,
    );
    expect(await prisma.postLike.count({ where: { postId: post.id } })).toBe(0);
    expect(
      (
        await prisma.post.findUniqueOrThrow({
          where: { id: post.id },
          select: { pinnedAt: true },
        })
      ).pinnedAt,
    ).toBeNull();

    // Published, the same routes answer: the post is the house's.
    await schedule.run({ newsId, personId: seated.personId, sendEmail: false });

    expect(
      (await inject({ method: "GET", url, headers: { cookie: karinCookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await inject({
          method: "GET",
          url: image.url,
          headers: { cookie: karinCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inject({
          method: "PUT",
          url: `${url}/like`,
          headers: { cookie: karinCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inject({
          method: "POST",
          url: `${url}/comments`,
          headers: { cookie: karinCookie },
          payload: { body: "Tack för beskedet." },
        })
      ).statusCode,
    ).toBe(201);
  });
});
