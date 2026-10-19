import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type {
  AudienceListView,
  FeedPage,
  FeedUpdate,
  LikeView,
  PostCommentPage,
  PostCommentUpdate,
  PostCommentView,
  PostImageView,
  PostReadView,
  PostReportQueueView,
  PostReportView,
  PostView,
} from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { registerMultipart } from "../http/multipart";
import { pngBytes } from "../media/testing/image-fixtures";
import { NewsWriteService } from "../news/news-write.service";
import { erasureRemainder } from "../retention/erasure-domains";
import { grantErasure } from "../testing/erasure-requests";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { paragraphsContent } from "../site/page-content";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { FeedPurgeService } from "./feed-purge.service";
import { COMMENTS_PER_PAGE } from "./post-comment.service";

/**
 * The feed against a real database.
 *
 * Nine properties that only a real run can show, and each is a statement the
 * rest of the change rests on.
 *
 *   The round trip over HTTP. The routes are guarded by the global guard and
 *   the capability sits on the class, so who reaches them at all is a property
 *   of a served request rather than of a service call.
 *
 *   There is exactly one Alla and one Styrelsen, however many readers arrive at
 *   once. What settles them is a pair of partial unique indexes a unit test
 *   cannot hold.
 *
 *   The administrator finds no audience. They hold every capability, no seat
 *   and no residency, so they pass the guard and the service answers nothing -
 *   the one case where capability and membership visibly come apart, and the
 *   one a screen has to put into words.
 *
 *   The refusal for an unknown audience and for an audience this person is not
 *   in is one refusal, down to the status and the body. Anything that told them
 *   apart would let the identifier space be walked.
 *
 *   A neighbour's post to Alla is read, liked, commented on and opened by the
 *   house, and the counts the screen shows are the rows those acts wrote. Its
 *   thread is delivered forwards from where a reader's copy ends, past more
 *   than a page and across a tie on the instant, which only the database's own
 *   ordering of two equal timestamps shows.
 *
 *   A scheduled post is in nobody's feed until its instant, and a board post is
 *   in the feed exactly while its news item is published - both are one
 *   condition on every read, and only a real read shows that every path asks
 *   it.
 *
 *   The access report carries the posts in full, through the same transaction
 *   the rest of the report is gathered in. The section tuple has no type link to
 *   the report shape, so a missing entry is not a compile error and is asserted
 *   here instead.
 *
 *   The purge erases a year-old post with what hangs on it, never touches a
 *   post written as Styrelsen, and refuses to touch one whose author is under a
 *   legal hold. The hold is a row and the advisory lock is a database
 *   primitive; neither means anything against a fake.
 *
 *   A granted erasure request takes the rest of what the feed holds of the
 *   person, and the closing purge counts the same rows.
 *
 *   An image on a post is served by the media route to whoever may read the
 *   post and answered to everybody else exactly as a file that does not exist,
 *   and the purge takes the file with the post. The route is public and the
 *   decision is a query against the feed, so only a served request shows it.
 *
 * The rules decided before any row is written are `feed.service.spec.ts`, and
 * the window arithmetic is `feed-retention.spec.ts`. Groups, and what is
 * invisible from outside one, are `group.int-spec.ts`.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: FeedPurgeService;
let reports: DataSubjectReportService;
let news: NewsWriteService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/** On the board, and the person every reading test acts as. */
const seated = {
  personId: `feed-seated-${suffix}`,
  email: `feed-seated-${suffix}@exempel.se`,
};
/** On the board as well, so a post can arrive from somebody else. */
const colleague = {
  personId: `feed-colleague-${suffix}`,
  email: `feed-colleague-${suffix}@exempel.se`,
};
/** Has an account, and neither a seat nor a home here. */
const outsider = {
  personId: `feed-outsider-${suffix}`,
  email: `feed-outsider-${suffix}@exempel.se`,
};
/** Holds every capability through the ADMIN grant, and holds no seat. */
const administrator = {
  personId: `feed-admin-${suffix}`,
  email: `feed-admin-${suffix}@exempel.se`,
};
/** On the board, with a legal hold standing against them. */
const held = {
  personId: `feed-held-${suffix}`,
  email: `feed-held-${suffix}@exempel.se`,
};
/** Lives here and holds no seat: a neighbour, who posts to Alla. */
const karin = {
  personId: `feed-karin-${suffix}`,
  email: `feed-karin-${suffix}@exempel.se`,
};
/** Lives here as well, and reads what Karin wrote. */
const erik = {
  personId: `feed-erik-${suffix}`,
  email: `feed-erik-${suffix}@exempel.se`,
};
/**
 * Two people who answered under somebody else's post: one a legal hold will
 * stand against, one whose processing will be restricted. No account, because
 * the purge tests write their comments directly.
 */
const noor = { personId: `feed-noor-${suffix}` };
const sven = { personId: `feed-sven-${suffix}` };

const personIds = [
  seated.personId,
  colleague.personId,
  outsider.personId,
  administrator.personId,
  held.personId,
  karin.personId,
  erik.personId,
  noor.personId,
  sven.personId,
];

/** Every news item this suite writes, so the cleanup can find them again. */
const slugs = {
  published: `flodet-publicerad-${suffix}`,
  purged: `flodet-gallrad-${suffix}`,
};

let addressId: string;
let apartmentId: string;

/**
 * The instant the read-marker tests mark, a few minutes ago.
 *
 * In the past on purpose: `markAudienceRead` caps what it writes at the
 * server's own clock, so a fixture reaching into the future would be marking
 * something that has not happened and would come back capped rather than as
 * written.
 */
const MARKED_AT = new Date(Date.now() - 5 * 60 * 1000);

/** The marker for the person who reads an audience and never posts in it. */
const READ_ONLY_AT = new Date(Date.now() - 30 * 60 * 1000);

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.49.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.49.${String(subnet)}.${String(host + 1)}`;
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

/**
 * The audiences this cookie is offered.
 *
 * The answer carries whether this account may make a group as well, because a
 * screen with nothing on it has to know which of the two empty cases it is
 * showing. That is whether they live here, so the caller states which it
 * expects: what a residency decides about groups is `group.int-spec.ts`.
 */
async function audiencesOf(
  cookie: string,
  livesHere = false,
): Promise<AudienceListView["audiences"]> {
  const response = await inject({
    method: "GET",
    url: "/api/feed/audiences",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  const answer = response.json<AudienceListView>();
  expect(answer.mayCreateGroup).toBe(livesHere);
  return answer.audiences;
}

/** One page of the feed as this cookie reads it, narrowed by `query`. */
async function pageOf(cookie: string, query = ""): Promise<FeedPage> {
  const response = await inject({
    method: "GET",
    url: `/api/feed/posts${query === "" ? "" : `?${query}`}`,
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<FeedPage>();
}

/** The identifiers on a page, pinned or not. */
function idsOn(page: FeedPage): string[] {
  return [...page.pinned, ...page.posts].map((post) => post.id);
}

/** Writes a post over HTTP and answers it as the author is shown it. */
async function write(
  cookie: string,
  audienceId: string,
  body: string,
): Promise<PostView> {
  const response = await inject({
    method: "POST",
    url: "/api/feed/posts",
    headers: { cookie },
    payload: { audienceId, body },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<PostView>();
}

let seatedCookie: string;
let colleagueCookie: string;
let outsiderCookie: string;
let administratorCookie: string;
let karinCookie: string;
let erikCookie: string;
let boardAudienceId: string;
let allAudienceId: string;

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
  purge = app.get(FeedPurgeService);
  reports = app.get(DataSubjectReportService);
  news = app.get(NewsWriteService);

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

  await prisma.person.createMany({
    data: [
      { id: seated.personId, firstName: "Astrid", lastName: `Flode${suffix}` },
      { id: colleague.personId, firstName: "Bo", lastName: `Flode${suffix}` },
      { id: outsider.personId, firstName: "Nils", lastName: `Flode${suffix}` },
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Flode${suffix}`,
      },
      { id: held.personId, firstName: "Elin", lastName: `Flode${suffix}` },
      { id: karin.personId, firstName: "Karin", lastName: `Flode${suffix}` },
      { id: erik.personId, firstName: "Erik", lastName: `Flode${suffix}` },
      { id: noor.personId, firstName: "Noor", lastName: `Flode${suffix}` },
      { id: sven.personId, firstName: "Sven", lastName: `Flode${suffix}` },
    ],
  });

  await prisma.boardPosition.createMany({
    data: [seated, colleague, held].map((person) => ({
      personId: person.personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2026-01-01"),
    })),
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });

  /*
   * Two neighbours with a home here and no seat, so Alla is read by somebody
   * the board's own audience never holds - the two halves of who Alla is.
   */
  const address = await prisma.address.create({
    data: {
      street: `Flödesgatan ${suffix}`,
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
  await prisma.residency.createMany({
    data: [karin, erik].map((person) => ({
      personId: person.personId,
      apartmentId,
      role: "RESIDENT" as const,
      movedInOn: new Date("2026-01-01"),
    })),
  });

  const auth = app.get(AuthService);
  for (const who of [seated, colleague, outsider, administrator, karin, erik]) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  seatedCookie = await signIn(seated.email);
  colleagueCookie = await signIn(colleague.email);
  outsiderCookie = await signIn(outsider.email);
  administratorCookie = await signIn(administrator.email);
  karinCookie = await signIn(karin.email);
  erikCookie = await signIn(erik.email);

  const audiences = await audiencesOf(seatedCookie);
  allAudienceId =
    audiences.find((audience) => audience.kind === "ALL")?.id ?? "";
  boardAudienceId =
    audiences.find((audience) => audience.kind === "BOARD")?.id ?? "";
});

afterAll(async () => {
  if (prisma !== undefined) {
    /*
     * This suite's own rows, and not the audiences they were written in.
     *
     * Alla and Styrelsen are singletons the migration creates and the service
     * reuses for ever, so they are not this suite's to remove: deleting either
     * would cascade to every post in it, including any a suite sharing this
     * database had written, and the next suite to ask for it would get a
     * different one. What is left behind is an audience with fewer posts in
     * it, which is exactly what the service expects to find.
     *
     * The comments first, by name: a comment's key to its post refuses a
     * cascade, so a post with a comment under it cannot go before the comment
     * does. Likes and read records cascade with the post they name. An erased
     * post names nobody, so it is found as one nothing stands under once this
     * suite's comments have gone, exactly as the purge finds it.
     */
    await prisma.postComment.deleteMany({
      where: {
        OR: [
          { authorPersonId: { in: personIds } },
          { post: { authorPersonId: { in: personIds } } },
        ],
      },
    });
    await prisma.post.deleteMany({
      where: {
        OR: [
          { authorPersonId: { in: personIds } },
          { erasedAt: { not: null }, comments: { none: {} } },
        ],
      },
    });
    // The news items, and with them the board posts that are their place in
    // the feed.
    await prisma.news.deleteMany({
      where: { slug: { in: Object.values(slugs) } },
    });
    await prisma.postLike.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.postRead.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.postCommentLike.deleteMany({
      where: { personId: { in: personIds } },
    });
    // Uploads for a post, attached or not: the image rows cascade with the
    // posts above, and the files are this suite's.
    await prisma.mediaFile.deleteMany({
      where: { uploadedByPersonId: { in: personIds } },
    });
    await prisma.audienceRead.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.legalHold.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.dataSubjectRequest.deleteMany({
      where: { personId: { in: personIds } },
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
    /*
     * The audit entries are deliberately not cleared. The table is append-only
     * and DELETE is revoked from the application's own role, so a suite that
     * tidied up after itself here would be asserting against a guarantee the
     * product makes - the assertions below count instead.
     */
  }
  await app?.close();
});

describe("the audiences somebody is in", () => {
  it("answers exactly one Alla and one Styrelsen, however many readers arrive at once", async () => {
    /*
     * The partial unique indexes, which are the whole of what makes the
     * create-if-absent safe on a database emptied by hand. Prisma cannot
     * express a WHERE on an index, so they are written by hand into the
     * migration and there is nothing in the schema that would fail without
     * them - only this, and the migration's own suite.
     */
    const answers = await Promise.all([
      audiencesOf(seatedCookie),
      audiencesOf(colleagueCookie),
      audiencesOf(seatedCookie),
    ]);

    for (const audiences of answers) {
      // Alla first, because it is the house, and then the board's own.
      expect(audiences.map((audience) => audience.id)).toEqual([
        allAudienceId,
        boardAudienceId,
      ]);
      expect(audiences.map((audience) => audience.kind)).toEqual([
        "ALL",
        "BOARD",
      ]);
      // Neither has a name: its name is its kind.
      expect(audiences.map((audience) => audience.name)).toEqual([null, null]);
    }

    expect(await prisma.audience.count({ where: { kind: "BOARD" } })).toBe(1);
    expect(await prisma.audience.count({ where: { kind: "ALL" } })).toBe(1);
  });

  it("offers a neighbour Alla and nothing of the board's", async () => {
    // A home here and no seat: the house's audience, and a group of their own
    // if they make one.
    const audiences = await audiencesOf(karinCookie, true);

    expect(audiences.map((audience) => audience.id)).toEqual([allAudienceId]);
  });

  it("offers the administrator no audience although they reach every route", async () => {
    /*
     * The case a screen has to put into words. They hold the capability through
     * ADMIN_CAPABILITIES = CAPABILITIES and they hold no board seat and no
     * residency, so the guard lets them in and the service answers nothing. An
     * empty list rather than a 403: it is an answer about membership, and
     * membership is not a capability.
     */
    const response = await inject({
      method: "GET",
      url: "/api/feed/audiences",
      headers: { cookie: administratorCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ audiences: [], mayCreateGroup: false });

    // And the feed itself is empty for them, rather than everything.
    const page = await pageOf(administratorCookie);
    expect(page.posts).toEqual([]);
    expect(page.pinned).toEqual([]);
  });

  it("refuses somebody with neither a seat nor a home here", async () => {
    /*
     * A person and an account and nothing else: no board seat, and no residency
     * either, which is what the feed's capability follows. So they are stopped
     * by the guard before membership is ever asked about - and somebody who
     * does live here is not, which the neighbours below show.
     */
    const response = await inject({
      method: "GET",
      url: "/api/feed/audiences",
      headers: { cookie: outsiderCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(
      (response.json<{ message?: string }>().message ?? "").includes(
        "chat:participate",
      ),
    ).toBe(true);
  });

  it("refuses a caller with no session at all", async () => {
    const response = await inject({ method: "GET", url: "/api/feed/posts" });

    expect(response.statusCode).toBe(401);
  });
});

describe("writing and reading over HTTP", () => {
  it("carries a post from one board member to another", async () => {
    const post = await write(
      seatedCookie,
      boardAudienceId,
      "Jag tar in en offert till pa taket.",
    );
    expect(post.author?.kind).toBe("person");
    expect(post.byBoard).toBe(false);

    const read = await pageOf(colleagueCookie, `audience=${boardAudienceId}`);

    expect(read.posts.map((row) => row.id)).toContain(post.id);
    expect(read.latest).not.toBeNull();
  });

  it("brings in what somebody else wrote, through the poll and nothing else", async () => {
    const before = await pageOf(seatedCookie, `audience=${boardAudienceId}`);
    const cursor = before.latest ?? "";

    await write(
      colleagueCookie,
      boardAudienceId,
      "Den kom i morse och ar dyrare.",
    );

    const update = await inject({
      method: "GET",
      url: `/api/feed/posts/since?audience=${boardAudienceId}&after=${encodeURIComponent(cursor)}`,
      headers: { cookie: seatedCookie },
    });
    expect(update.statusCode).toBe(200);
    const since = update.json<FeedUpdate>();

    expect(since.posts.map((row) => row.body)).toEqual([
      "Den kom i morse och ar dyrare.",
    ]);
    expect(since.more).toBe(false);
    // The cursor moved, so the next poll asks from here rather than repeating.
    expect(since.cursor).not.toBe(cursor);
  });

  it("answers an idle poll with nothing and the cursor it was given", async () => {
    const page = await pageOf(seatedCookie, `audience=${boardAudienceId}`);
    const cursor = page.latest ?? "";

    const update = await inject({
      method: "GET",
      url: `/api/feed/posts/since?audience=${boardAudienceId}&after=${encodeURIComponent(cursor)}`,
      headers: { cookie: seatedCookie },
    });

    expect(update.json<FeedUpdate>()).toEqual({
      posts: [],
      cursor,
      more: false,
    });
  });

  it("refuses a cursor this application did not hand out", async () => {
    // A value the screen could not have produced is answered rather than
    // repaired: answering the newest page to somebody who asked for an older
    // one would tell a reader the feed ends where it does not.
    const response = await inject({
      method: "GET",
      url: `/api/feed/posts?audience=${boardAudienceId}&before=not-a-cursor`,
      headers: { cookie: seatedCookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a post carrying a personal identity number, naming no digits", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/feed/posts",
      headers: { cookie: seatedCookie },
      payload: {
        audienceId: boardAudienceId,
        body: "Det ar 19811218-9876 som star i registret.",
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.body;
    expect(body).toContain("personal-identity-number");
    // The whole serialised refusal, because the message and the details both
    // travel back to the caller.
    expect(body).not.toContain("19811218");

    expect(
      await prisma.post.count({
        where: { audienceId: boardAudienceId, body: { contains: "19811218" } },
      }),
    ).toBe(0);
  });

  it("refuses a post of nothing but spaces", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/feed/posts",
      headers: { cookie: seatedCookie },
      payload: { audienceId: boardAudienceId, body: "   " },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("the one refusal", () => {
  it("answers an unknown audience exactly as an audience this person is not in", async () => {
    /*
     * A group nobody in this file is in stands in for "an audience this person
     * is not in". The refusal has to be indistinguishable from an audience that
     * is not there, or the identifier space can be walked to learn what groups
     * the house has made - which is also the whole of what makes a group
     * invisible to somebody outside it. Every other route is
     * `group.int-spec.ts`.
     */
    const group = await prisma.audience.create({
      data: { kind: "GROUP", name: `Garden ${suffix}` },
      select: { id: true },
    });

    try {
      const unknown = await inject({
        method: "GET",
        url: `/api/feed/posts?audience=feed-nothing-${suffix}`,
        headers: { cookie: seatedCookie },
      });
      const notIn = await inject({
        method: "GET",
        url: `/api/feed/posts?audience=${group.id}`,
        headers: { cookie: seatedCookie },
      });

      expect(unknown.statusCode).toBe(404);
      expect(notIn.statusCode).toBe(unknown.statusCode);
      expect(notIn.body).toBe(unknown.body);
    } finally {
      await prisma.audience.delete({ where: { id: group.id } });
    }
  });

  it("refuses the write into an audience this person is not in", async () => {
    const group = await prisma.audience.create({
      data: { kind: "GROUP", name: `Trapphus ${suffix}` },
      select: { id: true },
    });

    try {
      const response = await inject({
        method: "POST",
        url: "/api/feed/posts",
        headers: { cookie: seatedCookie },
        payload: { audienceId: group.id, body: "Hej." },
      });

      expect(response.statusCode).toBe(404);
      expect(await prisma.post.count({ where: { audienceId: group.id } })).toBe(
        0,
      );
    } finally {
      await prisma.audience.delete({ where: { id: group.id } });
    }
  });

  it("refuses a neighbour the board's own audience, by every route that names it", async () => {
    /*
     * Styrelsen is an audience like a group is, and a neighbour is outside it.
     * A post there is refused by its identifier exactly as one that was never
     * written, and the audience exactly as one that does not exist.
     */
    const post = await write(
      seatedCookie,
      boardAudienceId,
      "Styrelsens egna overvaganden.",
    );

    const audience = await inject({
      method: "GET",
      url: `/api/feed/posts?audience=${boardAudienceId}`,
      headers: { cookie: karinCookie },
    });
    const noAudience = await inject({
      method: "GET",
      url: `/api/feed/posts?audience=feed-nothing-${suffix}`,
      headers: { cookie: karinCookie },
    });
    expect(audience.statusCode).toBe(404);
    expect(audience.body).toBe(noAudience.body);

    const byId = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}`,
      headers: { cookie: karinCookie },
    });
    const noPost = await inject({
      method: "GET",
      url: `/api/feed/posts/feed-nothing-${suffix}`,
      headers: { cookie: karinCookie },
    });
    expect(byId.statusCode).toBe(404);
    expect(byId.body).toBe(noPost.body);

    // And the feed without an audience reaches no further than hers.
    expect(idsOn(await pageOf(karinCookie))).not.toContain(post.id);
  });
});

describe("the read marker", () => {
  it("is written once per person per audience and never moves backwards", async () => {
    /*
     * Both in the past, because the service caps a marker at its own clock: a
     * marker can only say somebody has read as far as something that already
     * exists. The pair is what this test is about, so they are minutes apart
     * rather than days.
     */
    const later = MARKED_AT;
    const earlier = new Date(MARKED_AT.getTime() - 10 * 60 * 1000);

    const first = await inject({
      method: "POST",
      url: `/api/feed/audiences/${boardAudienceId}/read`,
      headers: { cookie: seatedCookie },
      payload: { readAt: later.toISOString() },
    });
    expect(first.statusCode).toBe(200);

    const second = await inject({
      method: "POST",
      url: `/api/feed/audiences/${boardAudienceId}/read`,
      headers: { cookie: seatedCookie },
      payload: { readAt: earlier.toISOString() },
    });

    /*
     * The upsert and its comparison are one statement, which is what makes two
     * tabs settle rather than overwrite. The loser is told the marker that
     * actually stands rather than the instant it sent.
     */
    expect(second.json()).toEqual({ readAt: later.toISOString() });

    const rows = await prisma.audienceRead.findMany({
      where: { audienceId: boardAudienceId, personId: seated.personId },
      select: { readAt: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.readAt).toEqual(later);
  });

  it("counts what arrived after the marker, and never this person's own", async () => {
    const boardOf = async (cookie: string) =>
      (await audiencesOf(cookie)).find(
        (audience) => audience.id === boardAudienceId,
      );

    await inject({
      method: "POST",
      url: `/api/feed/audiences/${boardAudienceId}/read`,
      headers: { cookie: colleagueCookie },
      payload: { readAt: new Date().toISOString() },
    });

    await write(
      colleagueCookie,
      boardAudienceId,
      "Min egen rad, som inte ar olast for mig.",
    );
    expect((await boardOf(colleagueCookie))?.unread).toBe(0);

    await write(seatedCookie, boardAudienceId, "Och en rad fran nagon annan.");
    expect((await boardOf(colleagueCookie))?.unread).toBe(1);
  });

  it("refuses an instant that is not one", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/feed/audiences/${boardAudienceId}/read`,
      headers: { cookie: seatedCookie },
      payload: { readAt: "igar" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("the access report", () => {
  it("carries this person's own posts in full, and nobody else's", async () => {
    /*
     * The section tuple in data-subject-report.service.ts has no type link to
     * the report shape, so a section left out of it is not a compile error. It
     * is asserted here, against the transaction the whole report is gathered
     * in.
     */
    await write(
      seatedCookie,
      boardAudienceId,
      "Detta ska sta pa mitt registerutdrag.",
    );
    await write(colleagueCookie, boardAudienceId, "Detta ar inte hennes ord.");

    const report = await reports.generate({
      personId: seated.personId,
      actorPersonId: administrator.personId,
    });

    expect(report.feed).toHaveLength(1);
    const audience = report.feed[0];
    expect(audience?.audienceKind).toBe("BOARD");
    expect(audience?.audienceName).toBeNull();
    // The read marker is a field of the audience rather than a section of its
    // own.
    expect(audience?.readUpTo).toBe(MARKED_AT.toISOString());

    const bodies = (audience?.posts ?? []).map((post) => post.body);
    expect(bodies).toContain("Detta ska sta pa mitt registerutdrag.");
    // An audience's other readers wrote about themselves and about the
    // association's business; a report carrying the whole audience would hand
    // one board member everything the other seven said.
    expect(bodies).not.toContain("Detta ar inte hennes ord.");

    // And the date the purge will actually reach each of them, derived rather
    // than stored.
    for (const post of audience?.posts ?? []) {
      expect(post.erasableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("carries an audience somebody read and never posted in", async () => {
    /*
     * A read marker is a fact the association stores about a person - that they
     * opened this audience, and how far down it they had got - and it is stored
     * whether or not they ever answered. A report that listed only the
     * audiences somebody had written in would omit it, and the art. 20 export
     * that projects from this report would omit it too.
     *
     * Art. 15 is a right to what is held rather than to what is interesting, so
     * the audience is on the report with an empty list of posts: the true
     * statement is that they read it and wrote nothing, and an absence says
     * neither.
     *
     * The marker is written directly because this person holds a seat and no
     * account, which is the shape the case needs: somebody in the audience who
     * has never posted.
     */
    await prisma.audienceRead.create({
      data: {
        audienceId: boardAudienceId,
        personId: held.personId,
        readAt: READ_ONLY_AT,
      },
    });

    const report = await reports.generate({
      personId: held.personId,
      actorPersonId: administrator.personId,
    });

    expect(report.feed).toHaveLength(1);
    expect(report.feed[0]).toMatchObject({
      audienceKind: "BOARD",
      audienceName: null,
      readUpTo: READ_ONLY_AT.toISOString(),
      posts: [],
    });
  });
});

describe("a neighbour's post to Alla", () => {
  it("is read, liked, answered and opened by the house, and counted", async () => {
    const written = await write(
      karinCookie,
      allAudienceId,
      `Loppis pa garden pa lordag ${suffix}.`,
    );
    expect(written.audience).toEqual({
      id: allAudienceId,
      kind: "ALL",
      name: null,
    });
    expect(written.author).toMatchObject({
      kind: "person",
      personId: karin.personId,
    });

    // A neighbour reads it in the feed, and so does the board: the board is in
    // Alla because it answers for what is written there.
    expect(idsOn(await pageOf(erikCookie))).toContain(written.id);
    expect(idsOn(await pageOf(seatedCookie))).toContain(written.id);

    // Liking twice is liking once, and the count is the rows.
    for (let press = 0; press < 2; press += 1) {
      const liked = await inject({
        method: "PUT",
        url: `/api/feed/posts/${written.id}/like`,
        headers: { cookie: erikCookie },
      });
      expect(liked.statusCode).toBe(200);
      expect(liked.json<LikeView>()).toEqual({ liked: true, likes: 1 });
    }

    const commented = await inject({
      method: "POST",
      url: `/api/feed/posts/${written.id}/comments`,
      headers: { cookie: erikCookie },
      payload: { body: "Jag tar med kaffe." },
    });
    expect(commented.statusCode).toBe(201);
    const comment = commented.json<PostCommentView>();
    expect(comment.postId).toBe(written.id);

    // The author likes the answer, and reads the thread oldest first.
    const commentLiked = await inject({
      method: "PUT",
      url: `/api/feed/comments/${comment.id}/like`,
      headers: { cookie: karinCookie },
    });
    expect(commentLiked.json<LikeView>()).toEqual({ liked: true, likes: 1 });
    const thread = await inject({
      method: "GET",
      url: `/api/feed/posts/${written.id}/comments`,
      headers: { cookie: karinCookie },
    });
    expect(thread.statusCode).toBe(200);
    expect(thread.json<PostCommentPage>().comments).toMatchObject([
      { id: comment.id, body: "Jag tar med kaffe.", likes: 1, liked: true },
    ]);

    /*
     * Opening a post is recorded once, and never for its own author: she wrote
     * it rather than read it, and a count that included her would say one
     * more neighbour had seen it than had.
     */
    for (let press = 0; press < 2; press += 1) {
      const opened = await inject({
        method: "POST",
        url: `/api/feed/posts/${written.id}/read`,
        headers: { cookie: erikCookie },
      });
      expect(opened.statusCode).toBe(200);
      expect(opened.json<PostReadView>()).toEqual({ readBy: 1 });
    }
    const ownOpen = await inject({
      method: "POST",
      url: `/api/feed/posts/${written.id}/read`,
      headers: { cookie: karinCookie },
    });
    expect(ownOpen.json<PostReadView>()).toEqual({ readBy: 1 });

    // The post as each of them is shown it: one count for everybody, and
    // "liked" for the reader who did.
    const forTheAuthor = await inject({
      method: "GET",
      url: `/api/feed/posts/${written.id}`,
      headers: { cookie: karinCookie },
    });
    expect(forTheAuthor.json<PostView>()).toMatchObject({
      likes: 1,
      liked: false,
      comments: 1,
      readBy: 1,
    });
    const forTheNeighbour = await inject({
      method: "GET",
      url: `/api/feed/posts/${written.id}`,
      headers: { cookie: erikCookie },
    });
    expect(forTheNeighbour.json<PostView>()).toMatchObject({
      likes: 1,
      liked: true,
    });

    // And a like taken back is a row gone, not a flag.
    const unliked = await inject({
      method: "DELETE",
      url: `/api/feed/posts/${written.id}/like`,
      headers: { cookie: erikCookie },
    });
    expect(unliked.json<LikeView>()).toEqual({ liked: false, likes: 0 });
    expect(await prisma.postLike.count({ where: { postId: written.id } })).toBe(
      0,
    );
  });

  it("delivers its thread forwards from where a reader's copy ends, past more than a page", async () => {
    /*
     * Karin opens the thread with one comment in it. More than a page is then
     * written under it - three sharing one instant, so the tie is the
     * database's to order - and the forward read from her cursor reaches every
     * one of them exactly once, where the newest page alone would have left the
     * first of them behind a gap.
     */
    const written = await write(
      karinCookie,
      allAudienceId,
      `Vem lanar ut en stege ${suffix}?`,
    );
    const first = await inject({
      method: "POST",
      url: `/api/feed/posts/${written.id}/comments`,
      headers: { cookie: erikCookie },
      payload: { body: "Jag har en." },
    });
    expect(first.statusCode, first.body).toBe(201);
    const opened = await inject({
      method: "GET",
      url: `/api/feed/posts/${written.id}/comments`,
      headers: { cookie: karinCookie },
    });
    const page = opened.json<PostCommentPage>();
    expect(page.comments.map((comment) => comment.id)).toEqual([
      first.json<PostCommentView>().id,
    ]);
    expect(page.earlier).toBeNull();
    if (page.latest === null) {
      throw new Error("A thread with a comment in it has a cursor.");
    }

    /*
     * Written straight into the table, a minute ahead of the clock, and taken
     * out again whatever happens: left behind, they would be Erik's whole
     * comment budget for every case after this one.
     */
    try {
      const later = new Date(Date.now() + 60_000);
      const tied = new Date(later.getTime() + 1000);
      const count = COMMENTS_PER_PAGE + 3;
      await prisma.postComment.createMany({
        data: Array.from({ length: count }, (_, index) => ({
          postId: written.id,
          authorPersonId: erik.personId,
          body: `Svar ${String(index + 1)}.`,
          createdAt:
            index >= count - 3 ? tied : new Date(later.getTime() + index),
        })),
      });
      const expected = (
        await prisma.postComment.findMany({
          where: { postId: written.id, createdAt: { gte: later } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true },
        })
      ).map((comment) => comment.id);
      expect(expected).toHaveLength(count);

      const delivered: string[] = [];
      let after = page.latest;
      let answers = 0;
      for (;;) {
        const response = await inject({
          method: "GET",
          url: `/api/feed/posts/${written.id}/comments/since?${new URLSearchParams({ after }).toString()}`,
          headers: { cookie: karinCookie },
        });
        expect(response.statusCode, response.body).toBe(200);
        const update = response.json<PostCommentUpdate>();
        delivered.push(...update.comments.map((comment) => comment.id));
        after = update.cursor;
        answers += 1;
        if (!update.more) {
          break;
        }
      }
      expect(delivered).toEqual(expected);
      expect(answers).toBe(2);

      /*
       * Those were stamped a minute ahead of the clock. A comment written now is
       * stamped after them rather than with the clock, or it would sort behind a
       * cursor the poll has already passed and never be delivered.
       */
      const reply = await inject({
        method: "POST",
        url: `/api/feed/posts/${written.id}/comments`,
        headers: { cookie: karinCookie },
        payload: { body: "Tack, alla." },
      });
      expect(reply.statusCode, reply.body).toBe(201);
      const arrived = await inject({
        method: "GET",
        url: `/api/feed/posts/${written.id}/comments/since?${new URLSearchParams({ after }).toString()}`,
        headers: { cookie: erikCookie },
      });
      expect(
        arrived.json<PostCommentUpdate>().comments.map((comment) => comment.id),
      ).toEqual([reply.json<PostCommentView>().id]);

      // A cursor the API never issued is refused rather than read leniently.
      const malformed = await inject({
        method: "GET",
        url: `/api/feed/posts/${written.id}/comments/since?after=nonsense`,
        headers: { cookie: karinCookie },
      });
      expect(malformed.statusCode).toBe(400);
    } finally {
      await prisma.postComment.deleteMany({ where: { postId: written.id } });
    }
  });

  it("is found by a search and by the filters that match it, and by no other", async () => {
    const word = `Cykelrensning${suffix}`;
    const written = await write(
      karinCookie,
      allAudienceId,
      `${word} i cykelrummet nasta vecka.`,
    );

    // The search is the word and nothing else matches it, so the answer is
    // exactly the one post.
    const searched = await pageOf(erikCookie, `q=${encodeURIComponent(word)}`);
    expect(idsOn(searched)).toEqual([written.id]);
    // Matched without regard to case, as somebody half remembering it types.
    const lower = await pageOf(
      erikCookie,
      `q=${encodeURIComponent(word.toLowerCase())}`,
    );
    expect(idsOn(lower)).toEqual([written.id]);

    expect(idsOn(await pageOf(erikCookie, "from=neighbours"))).toContain(
      written.id,
    );
    expect(idsOn(await pageOf(erikCookie, "from=board"))).not.toContain(
      written.id,
    );
    // A neighbour's post is never important: only the board marks one.
    expect(idsOn(await pageOf(erikCookie, "important=true"))).not.toContain(
      written.id,
    );
    expect(
      idsOn(await pageOf(erikCookie, `audience=${allAudienceId}`)),
    ).toContain(written.id);
  });
});

describe("a scheduled post", () => {
  it("is in nobody's feed until its instant, and then in it by every path", async () => {
    /*
     * Written directly, because nothing over HTTP schedules a post yet: a
     * board post whose instant is a few seconds away, carrying `scheduledAt`
     * as a scheduled one does. What is under test is the one condition every
     * read asks (`shownAt`), and a few seconds is enough to see it both ways.
     */
    const word = `Vattenavstangning${suffix}`;
    const instant = new Date(Date.now() + 4000);
    const scheduled = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: seated.personId,
        byBoard: true,
        namesAuthor: false,
        body: `${word} pa tisdag mellan nio och tolv.`,
        important: true,
        scheduledAt: instant,
        createdAt: instant,
      },
      select: { id: true },
    });

    const before = await pageOf(erikCookie);
    expect(idsOn(before)).not.toContain(scheduled.id);
    expect(
      idsOn(await pageOf(erikCookie, `q=${encodeURIComponent(word)}`)),
    ).toEqual([]);
    expect(idsOn(await pageOf(erikCookie, "important=true"))).not.toContain(
      scheduled.id,
    );
    expect(idsOn(await pageOf(erikCookie, "from=board"))).not.toContain(
      scheduled.id,
    );

    // By its identifier it is a post that does not exist - to the board too.
    const notYet = await inject({
      method: "GET",
      url: `/api/feed/posts/${scheduled.id}`,
      headers: { cookie: erikCookie },
    });
    const notThere = await inject({
      method: "GET",
      url: `/api/feed/posts/feed-nothing-${suffix}`,
      headers: { cookie: erikCookie },
    });
    expect(notYet.statusCode).toBe(404);
    expect(notYet.body).toBe(notThere.body);
    expect(
      (
        await inject({
          method: "GET",
          url: `/api/feed/posts/${scheduled.id}`,
          headers: { cookie: seatedCookie },
        })
      ).statusCode,
    ).toBe(404);
    // Nor can it be answered or liked ahead of time.
    for (const attempt of [
      { method: "PUT" as const, url: `/api/feed/posts/${scheduled.id}/like` },
      { method: "POST" as const, url: `/api/feed/posts/${scheduled.id}/read` },
      {
        method: "GET" as const,
        url: `/api/feed/posts/${scheduled.id}/comments`,
      },
    ]) {
      const refused = await inject({
        ...attempt,
        headers: { cookie: erikCookie },
      });
      expect(refused.statusCode, attempt.url).toBe(404);
    }

    await waitFor(async () => Date.now() > instant.getTime() + 50, 10_000);

    // The poll from the page drawn before delivers it once its instant comes,
    // because it was stamped later than everything on that page.
    const update = await inject({
      method: "GET",
      url: `/api/feed/posts/since?after=${encodeURIComponent(before.latest ?? "")}`,
      headers: { cookie: erikCookie },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json<FeedUpdate>().posts.map((post) => post.id)).toContain(
      scheduled.id,
    );

    expect(idsOn(await pageOf(erikCookie))).toContain(scheduled.id);
    expect(
      idsOn(await pageOf(erikCookie, `q=${encodeURIComponent(word)}`)),
    ).toEqual([scheduled.id]);
    expect(idsOn(await pageOf(erikCookie, "important=true"))).toContain(
      scheduled.id,
    );
    const shown = await inject({
      method: "GET",
      url: `/api/feed/posts/${scheduled.id}`,
      headers: { cookie: erikCookie },
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.json<PostView>()).toMatchObject({
      byBoard: true,
      // Written as Styrelsen without the writer's name, so none is shown.
      author: null,
      createdAt: instant.toISOString(),
    });
  }, 30_000);
});

describe("a news item in the feed", () => {
  it("is a board post while it is published, and only then", async () => {
    const actor = { personId: seated.personId, channel: "WEB" } as const;
    const item = await news.create(
      {
        slug: slugs.published,
        title: `Arsstamma ${suffix}`,
        content: paragraphsContent(["Valkommen till arsstamman."]),
        authorPersonId: seated.personId,
      },
      actor,
    );

    // A draft has no place in the feed: nothing put it in front of the house.
    expect(await prisma.post.count({ where: { newsId: item.id } })).toBe(0);

    await news.publish(item.id, { published: true }, actor);

    // Publishing is what put it in the feed, as a Styrelsen post to Alla.
    const post = await prisma.post.findUniqueOrThrow({
      where: { newsId: item.id },
      select: { id: true, audienceId: true, createdAt: true },
    });
    expect(post.audienceId).toBe(allAudienceId);

    const shown = (await pageOf(erikCookie)).posts.find(
      (row) => row.id === post.id,
    );
    expect(shown).toMatchObject({
      byBoard: true,
      // The text is the item's, and the writer of a news item is not named.
      body: null,
      author: null,
      news: {
        id: item.id,
        slug: slugs.published,
        title: `Arsstamma ${suffix}`,
      },
    });
    // Found by its title, which is the text a board post has.
    expect(
      idsOn(
        await pageOf(
          erikCookie,
          `q=${encodeURIComponent(`Arsstamma ${suffix}`)}`,
        ),
      ),
    ).toEqual([post.id]);
    expect(idsOn(await pageOf(erikCookie, "from=board"))).toContain(post.id);
    expect(idsOn(await pageOf(erikCookie, "from=neighbours"))).not.toContain(
      post.id,
    );

    // Taken down, it is gone from the feed and refused by its identifier as a
    // post that never was.
    await news.publish(item.id, { published: false }, actor);
    expect(idsOn(await pageOf(erikCookie))).not.toContain(post.id);
    const down = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}`,
      headers: { cookie: erikCookie },
    });
    const notThere = await inject({
      method: "GET",
      url: `/api/feed/posts/feed-nothing-${suffix}`,
      headers: { cookie: erikCookie },
    });
    expect(down.statusCode).toBe(404);
    expect(down.body).toBe(notThere.body);

    // Put back, it is back where it was - the same post at the same instant -
    // rather than a second one at the top.
    await news.publish(item.id, { published: true }, actor);
    const again = await prisma.post.findMany({
      where: { newsId: item.id },
      select: { id: true, createdAt: true },
    });
    expect(again).toEqual([{ id: post.id, createdAt: post.createdAt }]);
    expect(idsOn(await pageOf(erikCookie))).toContain(post.id);
  });
});

/** When the purge tests' posts were written: long past their year. */
const WRITTEN_LONG_AGO = new Date("2025-01-01T10:00:00.000Z");
/** When an answer was written that is past its year by the first run too. */
const ANSWERED_LONG_AGO = new Date("2025-02-01T10:00:00.000Z");
/** The purge tests' run. */
const FIRST_RUN = new Date("2026-06-01T03:59:00.000Z");
/** The week before {@link FIRST_RUN}: an answer with most of its year to go. */
const ANSWERED_BEFORE_FIRST_RUN = new Date("2026-05-25T10:00:00.000Z");
/** A year and a day after {@link ANSWERED_BEFORE_FIRST_RUN}. */
const ANSWER_EXPIRED_RUN = new Date("2027-05-26T03:59:00.000Z");

describe("the purge", () => {
  it("erases a post a year after it was written, with what hangs on its text, and leaves the answer under it to its own year", async () => {
    /*
     * Written directly, with the date set. The window is a year and this suite
     * is not going to wait for it; the API's own path is exercised above.
     */
    const old = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: karin.personId,
        body: "Skrivet for lange sedan.",
        createdAt: WRITTEN_LONG_AGO,
      },
      select: { id: true },
    });
    const unanswered = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: karin.personId,
        body: "Ingen svarade pa det har.",
        createdAt: WRITTEN_LONG_AGO,
      },
      select: { id: true },
    });
    const recent = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: karin.personId,
        body: "Skrivet nyligen.",
      },
      select: { id: true },
    });
    /*
     * A neighbour's answer, written the week before the run, and what hangs on
     * the post's text: a like, a read record, a report and an earlier version.
     * The answer is his, on his own clock, and has most of a year left.
     */
    const answer = await prisma.postComment.create({
      data: {
        postId: old.id,
        authorPersonId: erik.personId,
        body: "Ett svar pa det gamla.",
        createdAt: ANSWERED_BEFORE_FIRST_RUN,
      },
      select: { id: true },
    });
    await prisma.postLike.create({
      data: { postId: old.id, personId: erik.personId },
    });
    await prisma.postCommentLike.create({
      data: { commentId: answer.id, personId: karin.personId },
    });
    await prisma.postRead.create({
      data: { postId: old.id, personId: erik.personId },
    });
    await prisma.postReport.create({
      data: { postId: old.id, reporterPersonId: erik.personId, note: null },
    });
    await prisma.postRevision.create({
      data: {
        postId: old.id,
        body: "Forsta versionen.",
        writtenAt: WRITTEN_LONG_AGO,
      },
    });

    /*
     * The run is unscoped: it scans every author in the integration database,
     * which the suites share. So this asserts on the rows it created and never
     * on the run summary - a count over the whole table reports another
     * suite's fixture as this purge's work, and fails for a reason belonging
     * to whichever suite happened to run before.
     */
    await purge.run(FIRST_RUN, 365);

    // Nobody answered this one, so it goes whole.
    expect(
      await prisma.post.findUnique({
        where: { id: unanswered.id },
        select: { id: true },
      }),
    ).toBeNull();
    // This one stays as the place the answer stands, with nothing of hers on it.
    expect(
      await prisma.post.findUnique({
        where: { id: old.id },
        select: { authorPersonId: true, body: true, erasedAt: true },
      }),
    ).toEqual({ authorPersonId: null, body: null, erasedAt: FIRST_RUN });
    const onOld = { where: { postId: old.id } };
    expect(await prisma.postLike.count(onOld)).toBe(0);
    expect(await prisma.postRead.count(onOld)).toBe(0);
    expect(await prisma.postReport.count(onOld)).toBe(0);
    expect(await prisma.postRevision.count(onOld)).toBe(0);
    // His answer stands, with the like on it, which is on his comment.
    expect(
      await prisma.postComment.findUnique({
        where: { id: answer.id },
        select: { body: true },
      }),
    ).toEqual({ body: "Ett svar pa det gamla." });
    expect(
      await prisma.postCommentLike.count({ where: { commentId: answer.id } }),
    ).toBe(1);
    // And the one inside its window is untouched, so the cutoff is a cutoff and
    // not a table scan.
    expect(
      await prisma.post.findUnique({
        where: { id: recent.id },
        select: { id: true },
      }),
    ).not.toBeNull();

    // The house reads it as erased, with the answer under it.
    const shown = await inject({
      method: "GET",
      url: `/api/feed/posts/${old.id}`,
      headers: { cookie: erikCookie },
    });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json<PostView>()).toMatchObject({
      author: null,
      byBoard: false,
      body: null,
      erasedAt: FIRST_RUN.toISOString(),
      commentsAllowed: false,
      likes: 0,
      comments: 1,
      readBy: 0,
    });
    const thread = await inject({
      method: "GET",
      url: `/api/feed/posts/${old.id}/comments`,
      headers: { cookie: erikCookie },
    });
    expect(thread.statusCode).toBe(200);
    expect(thread.json<PostCommentPage>().comments).toMatchObject([
      { id: answer.id, body: "Ett svar pa det gamla." },
    ]);
    // And can add nothing to it.
    for (const attempt of [
      { method: "PUT" as const, url: `/api/feed/posts/${old.id}/like` },
      {
        method: "POST" as const,
        url: `/api/feed/posts/${old.id}/comments`,
        payload: { body: "Ett svar till." },
      },
    ]) {
      const refused = await inject({
        ...attempt,
        headers: { cookie: erikCookie },
      });
      expect(refused.statusCode, attempt.url).toBe(422);
      expect(refused.json<{ reason: string }>().reason).toBe("post-erased");
    }
    // Opening it is not refused, and records nothing.
    const opened = await inject({
      method: "POST",
      url: `/api/feed/posts/${old.id}/read`,
      headers: { cookie: erikCookie },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json<PostReadView>()).toEqual({ readBy: 0 });

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetPersonId: karin.personId,
        targetKind: "post",
      },
      select: { context: true, actorPersonId: true },
    });
    expect(entries).toHaveLength(1);
    // Nobody clicked it: the job ran because a date arrived.
    expect(entries[0]?.actorPersonId).toBeNull();
    expect(entries[0]?.context).toMatchObject({
      posts: 2,
      comments: 0,
      // The neighbour's answer is counted and kept: it is his data, not hers.
      commentsKeptUnderErasedPosts: 1,
      retentionDaysAfterWriting: 365,
    });

    // A year after the answer was written it goes, and the post's row with it.
    await purge.run(ANSWER_EXPIRED_RUN, 365);
    expect(
      await prisma.postComment.findUnique({
        where: { id: answer.id },
        select: { id: true },
      }),
    ).toBeNull();
    expect(
      await prisma.post.findUnique({
        where: { id: old.id },
        select: { id: true },
      }),
    ).toBeNull();
  });

  it("keeps a comment its writer's legal hold stands over, under the erased post, until the hold is released", async () => {
    /*
     * Karin's post and Noor's answer are both past their year. The hold is
     * Noor's, so Karin's part goes and Noor's stays: erasing the answer with
     * the post would be erasing Noor's data past the hold placed to keep it.
     */
    const post = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: karin.personId,
        body: "Ett inlagg om tvatstugan.",
        createdAt: WRITTEN_LONG_AGO,
      },
      select: { id: true },
    });
    const kept = await prisma.postComment.create({
      data: {
        postId: post.id,
        authorPersonId: noor.personId,
        body: "Det var inte jag.",
        createdAt: ANSWERED_LONG_AGO,
      },
      select: { id: true },
    });
    const hold = await prisma.legalHold.create({
      data: {
        personId: noor.personId,
        reason: "Tvist om tvatstugan",
        placedByPersonId: administrator.personId,
      },
      select: { id: true },
    });

    await purge.run(FIRST_RUN, 365);

    expect(
      await prisma.post.findUnique({
        where: { id: post.id },
        select: { authorPersonId: true, body: true, erasedAt: true },
      }),
    ).toEqual({ authorPersonId: null, body: null, erasedAt: FIRST_RUN });
    expect(
      await prisma.postComment.findUnique({
        where: { id: kept.id },
        select: { body: true },
      }),
    ).toEqual({ body: "Det var inte jag." });

    // Released, and the next run takes the answer and the row it stood under.
    await prisma.legalHold.update({
      where: { id: hold.id },
      data: {
        releasedAt: new Date(),
        releasedByPersonId: administrator.personId,
      },
    });
    await purge.run(FIRST_RUN, 365);

    expect(
      await prisma.postComment.findUnique({
        where: { id: kept.id },
        select: { id: true },
      }),
    ).toBeNull();
    expect(
      await prisma.post.findUnique({
        where: { id: post.id },
        select: { id: true },
      }),
    ).toBeNull();
  });

  it("keeps a comment whose writer restricted processing, under the erased post, until the restriction is lifted", async () => {
    const post = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: karin.personId,
        body: "Ett inlagg om cykelrummet.",
        createdAt: WRITTEN_LONG_AGO,
      },
      select: { id: true },
    });
    const kept = await prisma.postComment.create({
      data: {
        postId: post.id,
        authorPersonId: sven.personId,
        body: "Min cykel stod dar forst.",
        createdAt: ANSWERED_LONG_AGO,
      },
      select: { id: true },
    });
    await prisma.person.update({
      where: { id: sven.personId },
      data: { processingRestrictedAt: new Date() },
    });

    try {
      await purge.run(FIRST_RUN, 365);

      expect(
        await prisma.post.findUnique({
          where: { id: post.id },
          select: { authorPersonId: true, body: true, erasedAt: true },
        }),
      ).toEqual({ authorPersonId: null, body: null, erasedAt: FIRST_RUN });
      expect(
        await prisma.postComment.findUnique({
          where: { id: kept.id },
          select: { body: true },
        }),
      ).toEqual({ body: "Min cykel stod dar forst." });
    } finally {
      await prisma.person.update({
        where: { id: sven.personId },
        data: { processingRestrictedAt: null },
      });
    }

    await purge.run(FIRST_RUN, 365);

    expect(
      await prisma.postComment.findUnique({
        where: { id: kept.id },
        select: { id: true },
      }),
    ).toBeNull();
    expect(
      await prisma.post.findUnique({
        where: { id: post.id },
        select: { id: true },
      }),
    ).toBeNull();
  });

  it("erases the post a granted request names, and no comment under it that somebody else wrote", async () => {
    /*
     * The request brings the purge of the author's own data forward to
     * tonight. The answers under the post are three other people's: one whose
     * hold stands, one whose processing is restricted, and one written today
     * by somebody with neither, who has a year to go.
     */
    const post = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: outsider.personId,
        body: "Jag flyttar snart harifran.",
      },
      select: { id: true },
    });
    const answers = await Promise.all(
      [
        { person: noor, body: "Lycka till.", createdAt: ANSWERED_LONG_AGO },
        { person: sven, body: "Vi saknar dig.", createdAt: ANSWERED_LONG_AGO },
        { person: erik, body: "Hor av dig.", createdAt: new Date() },
      ].map(({ person, body, createdAt }) =>
        prisma.postComment.create({
          data: {
            postId: post.id,
            authorPersonId: person.personId,
            body,
            createdAt,
          },
          select: { id: true },
        }),
      ),
    );
    const hold = await prisma.legalHold.create({
      data: {
        personId: noor.personId,
        reason: "Tvist om en flyttstadning",
        placedByPersonId: administrator.personId,
      },
      select: { id: true },
    });
    await prisma.person.update({
      where: { id: sven.personId },
      data: { processingRestrictedAt: new Date() },
    });
    const request = await grantErasure(
      prisma,
      outsider.personId,
      seated.personId,
    );

    try {
      const now = new Date();
      await purge.purgePerson(outsider.personId, now, 365);

      expect(
        await prisma.post.findUnique({
          where: { id: post.id },
          select: { authorPersonId: true, body: true },
        }),
      ).toEqual({ authorPersonId: null, body: null });
      expect(
        await prisma.postComment.count({
          where: { id: { in: answers.map((answer) => answer.id) } },
        }),
      ).toBe(3);
      // Nothing of the person's own is left for the closing purge to find.
      await expect(
        erasureRemainder(
          prisma,
          outsider.personId,
          now,
          app.get(FieldEncryptionService),
        ),
      ).resolves.toEqual([]);
    } finally {
      await prisma.dataSubjectRequest.deleteMany({ where: { id: request.id } });
      await prisma.legalHold.update({
        where: { id: hold.id },
        data: {
          releasedAt: new Date(),
          releasedByPersonId: administrator.personId,
        },
      });
      await prisma.person.update({
        where: { id: sven.personId },
        data: { processingRestrictedAt: null },
      });
    }
  });

  it("holds a comment arriving while its post is erased until the erasure commits, and then refuses it", async () => {
    /*
     * The comment checks the post before its transaction and finds it standing.
     * The erasure is in flight: it has updated the row and not committed. The
     * share lock the comment reads the row under is what makes it wait and
     * then read the row the erasure left, rather than writing a comment under
     * a post whose author's part has just gone.
     */
    const post = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: karin.personId,
        body: "Strax borta.",
      },
      select: { id: true },
    });

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let updated = false;
    const erasing = prisma.$transaction(
      async (tx) => {
        await tx.post.update({
          where: { id: post.id },
          data: { erasedAt: new Date(), authorPersonId: null, body: null },
        });
        updated = true;
        await gate;
      },
      { timeout: 20_000 },
    );
    await waitFor(async () => updated, 10_000);

    const commenting = inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      headers: { cookie: erikCookie },
      payload: { body: "Hann jag?" },
    });
    // Read out of the database rather than out of a delay: the comment is
    // waiting on the row.
    await waitFor(async () => {
      const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      return (row?.waiting ?? 0) > 0;
    }, 10_000);
    release();
    await erasing;

    const refused = await commenting;
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ reason: string }>().reason).toBe("post-erased");
    expect(await prisma.postComment.count({ where: { postId: post.id } })).toBe(
      0,
    );
  });

  it("never touches a post written as Styrelsen, though its writer's own go", async () => {
    /*
     * A board post is a news item and goes when the item does, so the window
     * does not reach it - even when the board member whose name the row still
     * carries has a post of their own the same age, which it does reach.
     */
    const item = await prisma.news.create({
      data: {
        slug: slugs.purged,
        title: `Gammal nyhet ${suffix}`,
        content: { blocks: [] },
        published: true,
        publishedAt: new Date("2025-01-01T09:00:00.000Z"),
        authorPersonId: colleague.personId,
      },
      select: { id: true },
    });
    const boardPost = await prisma.post.create({
      data: {
        audienceId: allAudienceId,
        authorPersonId: colleague.personId,
        byBoard: true,
        namesAuthor: false,
        body: null,
        newsId: item.id,
        createdAt: new Date("2025-01-01T09:00:00.000Z"),
      },
      select: { id: true },
    });
    const ownPost = await prisma.post.create({
      data: {
        audienceId: boardAudienceId,
        authorPersonId: colleague.personId,
        body: "Mitt eget, lika gammalt.",
        createdAt: new Date("2025-01-01T09:00:00.000Z"),
      },
      select: { id: true },
    });

    await purge.run(new Date("2026-06-01T03:59:00.000Z"), 365);

    expect(
      await prisma.post.findUnique({
        where: { id: boardPost.id },
        select: { id: true },
      }),
    ).not.toBeNull();
    expect(
      await prisma.post.findUnique({
        where: { id: ownPost.id },
        select: { id: true },
      }),
    ).toBeNull();
  });

  it("is stopped by a legal hold standing against the author", async () => {
    const post = await prisma.post.create({
      data: {
        audienceId: boardAudienceId,
        authorPersonId: held.personId,
        body: "Skrivet av nagon som star under hold.",
        createdAt: new Date("2025-01-01T10:00:00.000Z"),
      },
      select: { id: true },
    });
    await prisma.legalHold.create({
      data: {
        personId: held.personId,
        reason: "Tvist om en offert",
        placedByPersonId: administrator.personId,
      },
    });

    const at = new Date("2026-06-01T03:59:00.000Z");
    await purge.run(at, 365);

    expect(
      await prisma.post.findUnique({
        where: { id: post.id },
        select: { id: true },
      }),
    ).not.toBeNull();

    // Not in the scan's answer at all: held people are excluded by the query
    // rather than dropped from it, or five hundred of them could spend a run's
    // whole bound and the posts behind them would outlive their window.
    expect(await purge.eligible(at, 365)).not.toContain(held.personId);

    // And the check inside the deleting transaction is the one that counts: a
    // hold placed after the scan has to win, which is what this asserts by
    // asking the purge to erase for a person it was never given.
    await expect(purge.purgePerson(held.personId, at, 365)).resolves.toEqual({
      posts: 0,
      comments: 0,
    });
  });

  it("takes a person's places, read markers, likes, read records and reports on a granted erasure request", async () => {
    /*
     * The posts were always erased on a request; what else the feed holds of
     * the person was not, and the request was closed as carried out with their
     * report and its note still in the moderation queue.
     */
    const group = await prisma.audience.create({
      data: {
        kind: "GROUP",
        name: `Erasure ${suffix}`,
        createdByPersonId: seated.personId,
      },
      select: { id: true },
    });
    const reported = await prisma.post.create({
      data: {
        audienceId: boardAudienceId,
        authorPersonId: seated.personId,
        body: "Ett inlagg nagon anmalde.",
      },
      select: { id: true },
    });
    await prisma.groupMember.create({
      data: {
        audienceId: group.id,
        personId: outsider.personId,
        addedByPersonId: seated.personId,
      },
    });
    await prisma.audienceRead.create({
      data: {
        audienceId: group.id,
        personId: outsider.personId,
        readAt: new Date(),
      },
    });
    await prisma.postLike.create({
      data: { postId: reported.id, personId: outsider.personId },
    });
    await prisma.postRead.create({
      data: { postId: reported.id, personId: outsider.personId },
    });
    await prisma.postReport.create({
      data: {
        postId: reported.id,
        reporterPersonId: outsider.personId,
        note: "Jag tycker att det har var fel.",
      },
    });
    const request = await grantErasure(
      prisma,
      outsider.personId,
      seated.personId,
    );

    try {
      const now = new Date();
      expect(await purge.eligible(now, 365)).toContain(outsider.personId);
      await purge.purgePerson(outsider.personId, now, 365);

      const where = { personId: outsider.personId };
      expect(await prisma.groupMember.count({ where })).toBe(0);
      expect(await prisma.audienceRead.count({ where })).toBe(0);
      expect(await prisma.postLike.count({ where })).toBe(0);
      expect(await prisma.postRead.count({ where })).toBe(0);
      expect(
        await prisma.postReport.count({
          where: { reporterPersonId: outsider.personId },
        }),
      ).toBe(0);
      // And the closing purge, counting the same rows, finds nothing owed.
      await expect(
        erasureRemainder(
          prisma,
          outsider.personId,
          now,
          app.get(FieldEncryptionService),
        ),
      ).resolves.toEqual([]);
      // The reported post is somebody else's, and stays.
      expect(
        await prisma.post.findUnique({
          where: { id: reported.id },
          select: { id: true },
        }),
      ).not.toBeNull();
    } finally {
      await prisma.dataSubjectRequest.deleteMany({ where: { id: request.id } });
      await prisma.post.deleteMany({ where: { id: reported.id } });
      await prisma.audience.deleteMany({ where: { id: group.id } });
    }
  });
});

describe("images on a post", () => {
  /** A multipart body carrying one file, built by hand so no client is assumed. */
  function multipart(bytes: Buffer, fileName: string) {
    const boundary = "----openbrfFeedBoundary";
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        "Content-Type: image/png\r\n\r\n",
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    return {
      payload: Buffer.concat([head, bytes, tail]),
      // A form body names where it came from, or the guard takes it for a
      // sibling site's form.
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        origin: new URL(baseEnv.APP_URL).origin,
      },
    };
  }

  async function upload(cookie: string, fileName: string) {
    const body = multipart(pngBytes(32, 24), fileName);
    return inject({
      method: "POST",
      url: "/api/feed/images",
      headers: { cookie, ...body.headers },
      payload: body.payload,
    });
  }

  async function uploaded(
    cookie: string,
    fileName: string,
  ): Promise<PostImageView> {
    const response = await upload(cookie, fileName);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<PostImageView>();
  }

  /** A served request for a file, as the media route answers this cookie. */
  async function serve(url: string, cookie?: string) {
    return inject({
      method: "GET",
      url,
      headers: cookie === undefined ? {} : { cookie },
    });
  }

  /** A group Karin made, with Erik in it only when asked. */
  async function karinsGroup(withErik: boolean): Promise<string> {
    const group = await prisma.audience.create({
      data: {
        kind: "GROUP",
        name: `Bildgruppen ${suffix}`,
        createdByPersonId: karin.personId,
      },
    });
    await prisma.groupMember.createMany({
      data: [
        {
          audienceId: group.id,
          personId: karin.personId,
          addedByPersonId: karin.personId,
        },
        ...(withErik
          ? [
              {
                audienceId: group.id,
                personId: erik.personId,
                addedByPersonId: karin.personId,
              },
            ]
          : []),
      ],
    });
    return group.id;
  }

  async function writeWithImages(
    cookie: string,
    audienceId: string,
    imageIds: string[],
  ) {
    return inject({
      method: "POST",
      url: "/api/feed/posts",
      headers: { cookie },
      payload: { audienceId, body: "Så här ser cykelrummet ut.", imageIds },
    });
  }

  it("serves a group post's image to the group, and to nobody else by its address", async () => {
    const groupId = await karinsGroup(false);
    try {
      const image = await uploaded(karinCookie, "cykelrummet.png");
      expect(image.url).toBe(`/api/media/${image.id}`);
      expect([image.width, image.height]).toEqual([32, 24]);

      // On no post yet, so nobody reads it - not even the person who chose it.
      expect((await serve(image.url, karinCookie)).statusCode).toBe(404);

      const written = await writeWithImages(karinCookie, groupId, [image.id]);
      expect(written.statusCode, written.body).toBe(201);
      expect(written.json<PostView>().images).toEqual([image]);

      const served = await serve(image.url, karinCookie);
      expect(served.statusCode).toBe(200);
      expect(served.headers["content-type"]).toBe("image/png");
      expect(served.headers["cache-control"]).toBe("private, no-store");

      /*
       * Everybody outside the group, the board and the administrator included,
       * is answered exactly as for a file that was never stored: the same
       * status and the same body. Anything else would let the address be used
       * to learn that a group has a picture.
       */
      const missing = await serve("/api/media/no-such-file", erikCookie);
      for (const cookie of [
        erikCookie,
        seatedCookie,
        administratorCookie,
        outsiderCookie,
        undefined,
      ]) {
        const refused = await serve(image.url, cookie);
        expect(refused.statusCode).toBe(missing.statusCode);
        expect(refused.body).toBe(missing.body);
      }
    } finally {
      await prisma.post.deleteMany({ where: { audienceId: groupId } });
      await prisma.audience.deleteMany({ where: { id: groupId } });
    }
  });

  it("withholds a struck post's image from the group and serves it to its author", async () => {
    const groupId = await karinsGroup(true);
    try {
      const image = await uploaded(karinCookie, "grannen.png");
      const written = await writeWithImages(karinCookie, groupId, [image.id]);
      expect(written.statusCode, written.body).toBe(201);
      const postId = written.json<PostView>().id;
      expect((await serve(image.url, erikCookie)).statusCode).toBe(200);

      await prisma.post.update({
        where: { id: postId },
        data: { struckAt: new Date(), struckByPersonId: seated.personId },
      });

      expect((await serve(image.url, erikCookie)).statusCode).toBe(404);
      expect((await serve(image.url, karinCookie)).statusCode).toBe(200);
      const asErik = await inject({
        method: "GET",
        url: `/api/feed/posts/${postId}`,
        headers: { cookie: erikCookie },
      });
      expect(asErik.json<PostView>()).toMatchObject({ body: null, images: [] });
    } finally {
      await prisma.post.deleteMany({ where: { audienceId: groupId } });
      await prisma.audience.deleteMany({ where: { id: groupId } });
    }
  });

  it("serves a group's image to the board through an open report and through nothing else", async () => {
    /*
     * ADR 0026: the board reaches a group's image exactly as it reaches the
     * group's post, through a report or not at all. The board member is in no
     * group here, so before the report and after the answer the picture is a
     * file that does not exist to them; while the report is open it is served,
     * and the serve is written to the log.
     */
    const groupId = await karinsGroup(true);
    try {
      const image = await uploaded(karinCookie, "trappan.png");
      const written = await writeWithImages(karinCookie, groupId, [image.id]);
      expect(written.statusCode, written.body).toBe(201);
      const postId = written.json<PostView>().id;

      const missing = await serve("/api/media/no-such-file", seatedCookie);
      const before = await serve(image.url, seatedCookie);
      expect(before.statusCode).toBe(missing.statusCode);
      expect(before.body).toBe(missing.body);

      const reported = await inject({
        method: "POST",
        url: "/api/feed/reports",
        headers: { cookie: erikCookie },
        payload: { postId },
      });
      expect(reported.statusCode, reported.body).toBe(201);
      const { reportId } = reported.json<{ reportId: string }>();

      // The queue carries the picture, at the address the board then fetches.
      const queue = await inject({
        method: "GET",
        url: "/api/feed/reports",
        headers: { cookie: seatedCookie },
      });
      expect(queue.statusCode, queue.body).toBe(200);
      expect(
        queue
          .json<PostReportQueueView>()
          .reports.find((report) => report.reportId === reportId)?.images,
      ).toEqual([image]);

      const served = await serve(image.url, seatedCookie);
      expect(served.statusCode).toBe(200);
      expect(served.headers["content-type"]).toBe("image/png");
      expect(
        await prisma.auditLogEntry.findMany({
          where: { action: "MEDIA_ACCESSED", targetId: image.id },
          select: { actorPersonId: true, context: true },
        }),
      ).toEqual([
        { actorPersonId: seated.personId, context: { throughReport: true } },
      ]);

      /*
       * The report opens the post to the board and to nobody else: the
       * administrator holds the capability and no seat, and an outsider holds
       * neither. Each is answered as for a file that was never stored.
       */
      for (const cookie of [administratorCookie, outsiderCookie, undefined]) {
        const refused = await serve(image.url, cookie);
        expect(refused.statusCode).toBe(missing.statusCode);
        expect(refused.body).toBe(missing.body);
      }

      // Answered, and the post is back behind its group.
      const dismissed = await inject({
        method: "POST",
        url: `/api/feed/reports/${reportId}/dismiss`,
        headers: { cookie: seatedCookie },
      });
      expect(dismissed.statusCode, dismissed.body).toBe(200);
      expect(dismissed.json<PostReportView>().images).toEqual([]);
      const after = await serve(image.url, seatedCookie);
      expect(after.statusCode).toBe(missing.statusCode);
      expect(after.body).toBe(missing.body);
    } finally {
      await prisma.post.deleteMany({ where: { audienceId: groupId } });
      await prisma.audience.deleteMany({ where: { id: groupId } });
    }
  });

  it("puts an upload on one post only, and only its own uploader's", async () => {
    const image = await uploaded(karinCookie, "en-gang.png");

    const byErik = await writeWithImages(erikCookie, allAudienceId, [image.id]);
    expect(byErik.statusCode).toBe(404);
    expect(byErik.json()).toMatchObject({ reason: "image-not-found" });

    const first = await writeWithImages(karinCookie, allAudienceId, [image.id]);
    expect(first.statusCode, first.body).toBe(201);
    const again = await writeWithImages(karinCookie, allAudienceId, [image.id]);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ reason: "image-not-found" });

    // Alla is the house: a neighbour reads the picture on a neighbour's post.
    expect((await serve(image.url, erikCookie)).statusCode).toBe(200);
  });

  it("refuses an upload to somebody in no audience, and stores nothing", async () => {
    const before = await prisma.mediaFile.count({
      where: { uploadedByPersonId: administrator.personId },
    });

    const response = await upload(administratorCookie, "admin.png");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ reason: "audience-not-found" });
    expect(
      await prisma.mediaFile.count({
        where: { uploadedByPersonId: administrator.personId },
      }),
    ).toBe(before);
  });

  it("removes the file with the post the purge erases", async () => {
    const image = await uploaded(karinCookie, "forra-aret.png");
    const written = await writeWithImages(karinCookie, allAudienceId, [
      image.id,
    ]);
    expect(written.statusCode, written.body).toBe(201);
    const postId = written.json<PostView>().id;
    // A year and a bit ago, and nothing else of Karin's is that old.
    await prisma.post.update({
      where: { id: postId },
      data: { createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });

    await purge.purgePerson(karin.personId, new Date(), 365);

    expect(await prisma.post.findUnique({ where: { id: postId } })).toBeNull();
    expect(
      await prisma.mediaFile.findUnique({ where: { id: image.id } }),
    ).toBeNull();
    expect((await serve(image.url, karinCookie)).statusCode).toBe(404);
    // Recorded as the erasure of a file, by nobody.
    const deleted = await prisma.auditLogEntry.findMany({
      where: { action: "MEDIA_DELETED", targetId: image.id },
      select: { actorPersonId: true, channel: true },
    });
    expect(deleted).toEqual([{ actorPersonId: null, channel: "SYSTEM" }]);
  });

  it("sweeps an upload that went on no post two days on, and leaves a younger one", async () => {
    const abandoned = await uploaded(karinCookie, "angrade-mig.png");
    const recent = await uploaded(karinCookie, "skriver-fortfarande.png");
    await prisma.mediaFile.update({
      where: { id: abandoned.id },
      data: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });

    const summary = await purge.run(new Date(), 365);

    expect(summary.unattachedImagesRemoved).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.mediaFile.findUnique({ where: { id: abandoned.id } }),
    ).toBeNull();
    expect(
      await prisma.mediaFile.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();
  });

  /** An upload of Karin's on no post, aged past the sweep's two days. */
  async function abandonedUpload(fileName: string): Promise<string> {
    const image = await uploaded(karinCookie, fileName);
    await prisma.mediaFile.update({
      where: { id: image.id },
      data: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });
    return image.id;
  }

  async function stillStored(fileId: string): Promise<boolean> {
    return (
      (await prisma.mediaFile.findUnique({ where: { id: fileId } })) !== null
    );
  }

  it("keeps an upload on no post while a legal hold or a restriction stands over its uploader", async () => {
    /*
     * A picture chosen and never posted is the uploader's data like anything
     * they wrote, and a hold or a restriction forbids erasing it. Each is
     * tried alone, and the file goes on the first run after the second has
     * been lifted.
     */
    const fileId = await abandonedUpload("tvisten.png");
    const hold = await prisma.legalHold.create({
      data: {
        personId: karin.personId,
        reason: "Tvist om en bild",
        placedByPersonId: administrator.personId,
      },
    });
    try {
      await purge.run(new Date(), 365);
      expect(await stillStored(fileId)).toBe(true);
    } finally {
      await prisma.legalHold.update({
        where: { id: hold.id },
        data: {
          releasedAt: new Date(),
          releasedByPersonId: administrator.personId,
        },
      });
    }

    await prisma.person.update({
      where: { id: karin.personId },
      data: { processingRestrictedAt: new Date() },
    });
    try {
      await purge.run(new Date(), 365);
      expect(await stillStored(fileId)).toBe(true);
    } finally {
      await prisma.person.update({
        where: { id: karin.personId },
        data: { processingRestrictedAt: null },
      });
    }

    await purge.run(new Date(), 365);
    expect(await stillStored(fileId)).toBe(false);
  });

  it("keeps an upload whose uploader a hold is placed over while the sweep is running", async () => {
    /*
     * The placement holds Karin's legal hold key and has written the hold
     * without committing it, so the sweep's scan does not see it and selects
     * her file. The removal then reaches for the same key, waits - read out of
     * `pg_locks` rather than inferred from a delay - and reads the hold once
     * the placement has committed. The file stays.
     */
    const fileId = await abandonedUpload("medan-svepet-gick.png");
    const key = `legal-hold:${karin.personId}`;

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holder: Promise<string> | undefined;
    let holdId: string | undefined;

    try {
      // Longer than the waits below, so the transaction held open on purpose
      // is not aborted by the five-second default and its lock released early.
      holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
          const placed = await tx.legalHold.create({
            data: {
              personId: karin.personId,
              reason: "Tvist under svepet",
              placedByPersonId: administrator.personId,
            },
            select: { id: true },
          });
          await holderDone;
          return placed.id;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, true)) > 0n,
      );

      const running = purge.run(new Date(), 365);
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );

      releaseHolder?.();
      holdId = await holder;

      await running;
      expect(await stillStored(fileId)).toBe(true);
    } finally {
      releaseHolder?.();
      await holder?.catch(() => undefined);
      if (holdId !== undefined) {
        await prisma.legalHold.update({
          where: { id: holdId },
          data: {
            releasedAt: new Date(),
            releasedByPersonId: administrator.personId,
          },
        });
      }
    }
  }, 60_000);
});
