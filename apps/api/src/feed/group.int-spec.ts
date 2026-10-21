import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type {
  AudienceListView,
  CreatedGroupView,
  FeedPage,
  FeedUpdate,
  PostCommentView,
  PostReportQueueView,
  PostView,
} from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { feedCursor } from "./feed-cursor";
import { lockFeedPerson } from "./feed-lock";
import { FeedPurgeService } from "./feed-purge.service";
import { GROUPS_PER_PERSON } from "./group.service";

/**
 * Groups against a real database.
 *
 * Nine properties that only a real run can show, and each is a statement the
 * rest of the change rests on.
 *
 *   The round trip over HTTP. Making a group, being put into one and leaving
 *   one are guarded by the global guard, so who reaches them at all is a
 *   property of a served request rather than of a service call.
 *
 *   A group is invisible from outside, on every route. A neighbour in no group,
 *   a board member and the administrator each ask for the group and for its
 *   post by every path there is - the feed, a search, the filters, the post's
 *   own address, its comments, a like, a read, a report, the group's own
 *   panel - and each answer is the same status and the same body as for an
 *   identifier that does not exist, so the identifier space cannot be walked to
 *   learn what groups the house has made or what is said in them.
 *
 *   A place in a group ends when the residency does. The membership row is still
 *   there and answers nothing, which a unit test can state and only a real
 *   register write can show.
 *
 *   The board reaches a group only through a report. There is no route that
 *   lists groups, and the queue carries the post that was reported and nothing
 *   else about where it came from.
 *
 *   A struck post is withheld from the group and readable to its author, as
 *   two served requests rather than as one decision in a view.
 *
 *   The audit log records the three acts that change who can read a group, and
 *   the write of a post records nothing. The table refuses UPDATE and DELETE
 *   from the application's own role, so counting entries is the assertion.
 *
 *   The access report carries the group, the struck post and the report, in
 *   the transaction the rest of the report is gathered in.
 *
 *   A second press on somebody's last group place waits for the first and then
 *   answers as the idempotent add it is, which holds only while the person's
 *   own lock is taken before the count is.
 *
 *   The nightly purge erases a group that has held nothing for a year, and
 *   leaves one made this morning alone.
 *
 * The rules decided before any row is written are `group.service.spec.ts` and
 * `post-report.service.spec.ts`.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: FeedPurgeService;
let reports: DataSubjectReportService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/** Lives here, and makes the group. */
const nils = {
  personId: `group-nils-${suffix}`,
  email: `group-nils-${suffix}@exempel.se`,
};
/** Lives here, and is put into it. */
const astrid = {
  personId: `group-astrid-${suffix}`,
  email: `group-astrid-${suffix}@exempel.se`,
};
/** Lives here, and is in no group at all. */
const stranger = {
  personId: `group-stranger-${suffix}`,
  email: `group-stranger-${suffix}@exempel.se`,
};
/** Holds a board seat and lives nowhere: the moderation half. */
const boardMember = {
  personId: `group-board-${suffix}`,
  email: `group-board-${suffix}@exempel.se`,
};

/** Holds every capability through the ADMIN grant, and holds no seat. */
const administrator = {
  personId: `group-admin-${suffix}`,
  email: `group-admin-${suffix}@exempel.se`,
};

const personIds = [
  nils.personId,
  astrid.personId,
  stranger.personId,
  boardMember.personId,
  administrator.personId,
];

/** An identifier nothing in the database carries, for every "not there". */
const NOTHING = `group-nothing-${suffix}`;

let addressId: string;
let apartmentId: string;

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

/** The audiences this cookie is offered, and whether it may make a group. */
async function audiencesOf(cookie: string): Promise<AudienceListView> {
  const response = await inject({
    method: "GET",
    url: "/api/feed/audiences",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<AudienceListView>();
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

async function makeGroup(cookie: string, name: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/feed/groups",
    payload: { name },
    headers: { cookie },
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreatedGroupView>().audienceId;
}

async function addToGroup(
  cookie: string,
  audienceId: string,
  personId: string,
) {
  return inject({
    method: "POST",
    url: `/api/feed/groups/${audienceId}/members`,
    payload: { personId },
    headers: { cookie },
  });
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
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function report(
  cookie: string,
  postId: string,
  note?: string,
): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/feed/reports",
    payload: note === undefined ? { postId } : { postId, note },
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ reportId: string }>().reportId;
}

let nilsCookie: string;
let astridCookie: string;
let strangerCookie: string;
let boardCookie: string;
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
  reports = app.get(DataSubjectReportService);

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
      street: `Gruppgatan ${suffix}`,
      number: "1",
      postalCode: "12345",
      city: "Stockholm",
    },
  });
  addressId = address.id;
  const apartment = await prisma.apartment.create({
    data: { addressId, number: `10${suffix.slice(-2)}` },
  });
  apartmentId = apartment.id;

  await prisma.person.createMany({
    data: [
      { id: nils.personId, firstName: "Nils", lastName: `Grupp${suffix}` },
      { id: astrid.personId, firstName: "Astrid", lastName: `Grupp${suffix}` },
      {
        id: stranger.personId,
        firstName: "Sven",
        lastName: `Grupp${suffix}`,
      },
      { id: boardMember.personId, firstName: "Bo", lastName: `Grupp${suffix}` },
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Grupp${suffix}`,
      },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });

  /*
   * Three residencies and no seat between them, plus a board member with a seat
   * and no residency: the two halves of the membership question, kept apart so
   * neither can stand in for the other.
   */
  await prisma.residency.createMany({
    data: [nils, astrid, stranger].map((person) => ({
      personId: person.personId,
      apartmentId,
      role: "RESIDENT" as const,
      movedInOn: new Date("2026-01-01"),
    })),
  });
  await prisma.boardPosition.create({
    data: {
      personId: boardMember.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });

  const auth = app.get(AuthService);
  for (const who of [nils, astrid, stranger, boardMember, administrator]) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  nilsCookie = await signIn(nils.email);
  astridCookie = await signIn(astrid.email);
  strangerCookie = await signIn(stranger.email);
  boardCookie = await signIn(boardMember.email);
  administratorCookie = await signIn(administrator.email);
});

afterAll(async () => {
  if (prisma !== undefined) {
    const groups = await prisma.audience.findMany({
      where: { createdByPersonId: { in: personIds } },
      select: { id: true },
    });
    const audienceIds = groups.map((group) => group.id);
    /*
     * The comments by name first, because a comment's key to its post refuses
     * the cascade the group's delete would otherwise carry down to it. The
     * reports, the likes, the read records, the markers and the posts go with
     * the group through the cascade.
     */
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
    /*
     * The audit entries are deliberately not cleared. The table is append-only
     * and DELETE is revoked from the application's own role, so a suite that
     * tidied up after itself here would be asserting against a guarantee the
     * product makes - the assertions below count instead.
     */
  }
  await app?.close();
});

describe("making a group and being in one", () => {
  it("offers the maker their group, and the board none of it", async () => {
    const audienceId = await makeGroup(nilsCookie, "Trädgårdsgruppen");

    const mine = await audiencesOf(nilsCookie);
    expect(mine.mayCreateGroup).toBe(true);
    expect(mine.audiences.map((audience) => audience.id)).toContain(audienceId);

    /*
     * The board member holds a seat and is answered with Alla, Styrelsen and
     * Administratörer alone. Nothing about this cooperative's groups is on any list they can
     * read, and they may not make one either: they do not live here.
     */
    const board = await audiencesOf(boardCookie);
    expect(board.audiences.map((audience) => audience.kind)).toEqual([
      "ALL",
      "BOARD",
      "ADMIN",
    ]);
    expect(board.mayCreateGroup).toBe(false);
  });

  it("answers a group somebody is not in exactly as one that is not there", async () => {
    const audienceId = await makeGroup(nilsCookie, "Uppgång C");

    const notIn = await inject({
      method: "GET",
      url: `/api/feed/posts?audience=${audienceId}`,
      headers: { cookie: strangerCookie },
    });
    const notThere = await inject({
      method: "GET",
      url: `/api/feed/posts?audience=${NOTHING}`,
      headers: { cookie: strangerCookie },
    });

    expect(notIn.statusCode).toBe(404);
    expect(notThere.statusCode).toBe(notIn.statusCode);
    expect(notThere.json()).toEqual(notIn.json());
  });

  it("lets anybody in the group put somebody in, and lets them leave", async () => {
    const audienceId = await makeGroup(nilsCookie, "Städdagen");

    const added = await addToGroup(nilsCookie, audienceId, astrid.personId);
    expect(added.statusCode).toBe(200);
    expect(added.json<unknown[]>()).toHaveLength(2);

    // She is in the group and can read it.
    const page = await inject({
      method: "GET",
      url: `/api/feed/posts?audience=${audienceId}`,
      headers: { cookie: astridCookie },
    });
    expect(page.statusCode).toBe(200);

    const left = await inject({
      method: "DELETE",
      url: `/api/feed/groups/${audienceId}/members/me`,
      headers: { cookie: astridCookie },
    });
    expect(left.statusCode).toBe(204);

    const after = await inject({
      method: "GET",
      url: `/api/feed/posts?audience=${audienceId}`,
      headers: { cookie: astridCookie },
    });
    expect(after.statusCode).toBe(404);
  });

  it("ends a place in the group the day the residency ends", async () => {
    const audienceId = await makeGroup(nilsCookie, "Uppgång A");
    await addToGroup(nilsCookie, audienceId, stranger.personId);
    expect(
      (
        await inject({
          method: "GET",
          url: `/api/feed/posts?audience=${audienceId}`,
          headers: { cookie: strangerCookie },
        })
      ).statusCode,
    ).toBe(200);

    // The register decides it, and nobody strikes a name off a list.
    await prisma.residency.updateMany({
      where: { personId: stranger.personId },
      data: { movedOutOn: new Date("2026-06-01") },
    });

    try {
      const refused = await inject({
        method: "GET",
        url: `/api/feed/posts?audience=${audienceId}`,
        headers: { cookie: strangerCookie },
      });
      /*
       * The guard, and not the group. Moving out takes the capability itself
       * away - it is a resident's, derived from the same residency the
       * membership rests on - so somebody who has left the building is refused
       * the endpoints before membership is asked about at all. The service's
       * own answer for a person who still lives here and is not in the group
       * is `group.service.spec.ts`, and it is the same refusal as a group that
       * does not exist.
       */
      expect(refused.statusCode).toBe(403);

      // Nor is the group's member list: it asks the register too, and does not
      // count them against the group.
      const listed = await inject({
        method: "GET",
        url: `/api/feed/groups/${audienceId}/members`,
        headers: { cookie: nilsCookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain(stranger.personId);

      /*
       * And the night's purge takes the row, as the act it is. What they wrote
       * stays in the group attributed as before, because attribution is the
       * post's own `authorPersonId` and not this row - which, left, would put
       * them back in the group unannounced if they moved in again.
       */
      const summary = await purge.run(new Date());
      expect(summary.formerResidentsRemoved).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.groupMember.count({
          where: { audienceId, personId: stranger.personId },
        }),
      ).toBe(0);
      expect(
        await prisma.auditLogEntry.findFirst({
          where: {
            action: "CHAT_GROUP_MEMBER_REMOVED",
            actorPersonId: null,
            targetPersonId: stranger.personId,
            targetId: audienceId,
          },
        }),
      ).not.toBeNull();
    } finally {
      await prisma.residency.updateMany({
        where: { personId: stranger.personId },
        data: { movedOutOn: null },
      });
    }
  });

  it("records the acts that change who can read, and not the writing", async () => {
    const before = await prisma.auditLogEntry.count({
      where: { actorPersonId: nils.personId },
    });

    const audienceId = await makeGroup(nilsCookie, "Loppisgruppen");
    await addToGroup(nilsCookie, audienceId, astrid.personId);
    await write(nilsCookie, audienceId, "Vi ses pa lordag.");

    const after = await prisma.auditLogEntry.count({
      where: { actorPersonId: nils.personId },
    });
    // Two: the group, and the person put into it. The post is on its author's
    // access report in full, so an entry would restate the row.
    expect(after - before).toBe(2);
  });
});

describe("a group seen from outside it", () => {
  /*
   * One group, one post in it that matches every narrowing a reader can ask
   * for, a comment under it and a like on that - so that a path which leaked
   * any of it would have something to leak. The post is marked important by
   * hand, as only the board could, because the important filter is a path too.
   */
  const word = `Hemlighet${suffix}`;
  let audienceId: string;
  let postId: string;
  let commentId: string;
  /** A place in the feed just before the group's post, as a poll would hold. */
  let justBefore: string;

  /** The three people outside the group, each a different way of being outside. */
  const outsiders = () => [
    { who: "a neighbour in no group", cookie: strangerCookie },
    { who: "a board member", cookie: boardCookie },
    { who: "the administrator", cookie: administratorCookie },
  ];

  beforeAll(async () => {
    audienceId = await makeGroup(nilsCookie, "Hemliga gruppen");
    await addToGroup(nilsCookie, audienceId, astrid.personId);
    postId = await write(astridCookie, audienceId, `${word} om taket.`);
    const post = await prisma.post.update({
      where: { id: postId },
      data: { important: true },
      select: { createdAt: true },
    });
    justBefore = feedCursor({
      createdAt: new Date(post.createdAt.getTime() - 1),
      id: "0",
    });

    const commented = await inject({
      method: "POST",
      url: `/api/feed/posts/${postId}/comments`,
      payload: { body: "Det vet bara vi." },
      headers: { cookie: nilsCookie },
    });
    expect(commented.statusCode).toBe(201);
    commentId = commented.json<PostCommentView>().id;
    await inject({
      method: "PUT",
      url: `/api/feed/comments/${commentId}/like`,
      headers: { cookie: astridCookie },
    });
  });

  it("is found by its members by every path a reader has", async () => {
    /*
     * The other half of the refusals below, and what makes them mean
     * something: each path that answers an outsider nothing answers a member
     * the post.
     */
    expect(idsOn(await pageOf(nilsCookie))).toContain(postId);
    expect(idsOn(await pageOf(nilsCookie, `audience=${audienceId}`))).toContain(
      postId,
    );
    expect(
      idsOn(await pageOf(nilsCookie, `q=${encodeURIComponent(word)}`)),
    ).toEqual([postId]);
    expect(idsOn(await pageOf(nilsCookie, "from=neighbours"))).toContain(
      postId,
    );
    expect(idsOn(await pageOf(nilsCookie, "from=board"))).not.toContain(postId);
    expect(idsOn(await pageOf(nilsCookie, "important=true"))).toContain(postId);

    const since = await inject({
      method: "GET",
      url: `/api/feed/posts/since?after=${encodeURIComponent(justBefore)}`,
      headers: { cookie: nilsCookie },
    });
    expect(since.json<FeedUpdate>().posts.map((post) => post.id)).toContain(
      postId,
    );

    const own = await inject({
      method: "GET",
      url: `/api/feed/posts/${postId}`,
      headers: { cookie: nilsCookie },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json<PostView>()).toMatchObject({
      audience: { id: audienceId, kind: "GROUP", name: "Hemliga gruppen" },
      body: `${word} om taket.`,
      comments: 1,
    });
  });

  it("is in nobody else's feed, search or filter", async () => {
    for (const { who, cookie } of outsiders()) {
      expect(idsOn(await pageOf(cookie)), who).not.toContain(postId);
      // The word is in the group's post and nowhere else, so the answer is
      // empty rather than merely without it.
      expect(
        idsOn(await pageOf(cookie, `q=${encodeURIComponent(word)}`)),
        who,
      ).toEqual([]);
      for (const filter of [
        "from=neighbours",
        "from=board",
        "important=true",
      ]) {
        expect(
          idsOn(await pageOf(cookie, filter)),
          `${who}, ${filter}`,
        ).not.toContain(postId);
      }
      // Nor does a poll from a place just before it bring it in.
      const since = await inject({
        method: "GET",
        url: `/api/feed/posts/since?after=${encodeURIComponent(justBefore)}`,
        headers: { cookie },
      });
      expect(since.statusCode, who).toBe(200);
      expect(
        since.json<FeedUpdate>().posts.map((post) => post.id),
        who,
      ).not.toContain(postId);
      // And the list of audiences does not name it.
      expect(
        (await audiencesOf(cookie)).audiences.map((audience) => audience.id),
        who,
      ).not.toContain(audienceId);
    }
  });

  it("answers every route that names it exactly as one naming nothing", async () => {
    /*
     * Each route twice, once with the group's identifier or its post's or its
     * comment's, and once with one that does not exist - and the two answers
     * are the same bytes. A difference anywhere, a status or a word, would be
     * an oracle for whether a group exists and what is in it.
     */
    const routes = (group: string, post: string, comment: string) => [
      { method: "GET" as const, url: `/api/feed/posts?audience=${group}` },
      {
        method: "GET" as const,
        url: `/api/feed/posts/since?audience=${group}&after=${encodeURIComponent(justBefore)}`,
      },
      {
        method: "POST" as const,
        url: "/api/feed/posts",
        payload: { audienceId: group, body: "Hej." },
      },
      {
        method: "POST" as const,
        url: `/api/feed/audiences/${group}/read`,
        payload: { readAt: new Date(Date.now() - 60_000).toISOString() },
      },
      { method: "GET" as const, url: `/api/feed/posts/${post}` },
      { method: "POST" as const, url: `/api/feed/posts/${post}/read` },
      { method: "PUT" as const, url: `/api/feed/posts/${post}/like` },
      { method: "DELETE" as const, url: `/api/feed/posts/${post}/like` },
      { method: "GET" as const, url: `/api/feed/posts/${post}/comments` },
      {
        method: "POST" as const,
        url: `/api/feed/posts/${post}/comments`,
        payload: { body: "Jag vill ocksa vara med." },
      },
      { method: "PUT" as const, url: `/api/feed/comments/${comment}/like` },
      { method: "DELETE" as const, url: `/api/feed/comments/${comment}/like` },
      {
        method: "POST" as const,
        url: "/api/feed/reports",
        payload: { postId: post, note: "Vad star det har?" },
      },
      { method: "GET" as const, url: `/api/feed/groups/${group}/members` },
      {
        method: "GET" as const,
        url: `/api/feed/groups/${group}/candidates?search=Sven`,
      },
      {
        method: "POST" as const,
        url: `/api/feed/groups/${group}/members`,
        payload: { personId: stranger.personId },
      },
      {
        method: "DELETE" as const,
        url: `/api/feed/groups/${group}/members/me`,
      },
    ];

    const real = routes(audienceId, postId, commentId);
    const missing = routes(NOTHING, NOTHING, NOTHING);

    for (const { who, cookie } of outsiders()) {
      for (const [index, route] of real.entries()) {
        const name = `${who}: ${route.method} ${route.url}`;
        const refused = await inject({ ...route, headers: { cookie } });
        const absent = await inject({
          ...(missing[index] ?? route),
          headers: { cookie },
        });
        expect(refused.statusCode, name).toBe(404);
        expect(refused.statusCode, name).toBe(absent.statusCode);
        expect(refused.body, name).toBe(absent.body);
      }
    }

    // And none of it wrote anything: no place, no marker, no read, no like, no
    // comment, no report and no post from anybody outside.
    const outside = [
      stranger.personId,
      boardMember.personId,
      administrator.personId,
    ];
    const anyOf = { personId: { in: outside } };
    expect(
      await prisma.groupMember.count({ where: { audienceId, ...anyOf } }),
    ).toBe(0);
    expect(
      await prisma.audienceRead.count({ where: { audienceId, ...anyOf } }),
    ).toBe(0);
    expect(await prisma.postRead.count({ where: { postId, ...anyOf } })).toBe(
      0,
    );
    expect(await prisma.postLike.count({ where: { postId, ...anyOf } })).toBe(
      0,
    );
    expect(
      await prisma.postCommentLike.count({
        where: { commentId, ...anyOf },
      }),
    ).toBe(0);
    expect(
      await prisma.postComment.count({
        where: { postId, authorPersonId: { in: outside } },
      }),
    ).toBe(0);
    expect(
      await prisma.postReport.count({
        where: { postId, reporterPersonId: { in: outside } },
      }),
    ).toBe(0);
    expect(
      await prisma.post.count({
        where: { audienceId, authorPersonId: { in: outside } },
      }),
    ).toBe(0);
  }, 60_000);
});

describe("who a group can be offered", () => {
  /** The picker, asked with the maker's session. */
  async function candidatesFor(
    audienceId: string,
    search: string,
  ): Promise<{ personId: string; name: string }[]> {
    const response = await inject({
      method: "GET",
      url: `/api/feed/groups/${audienceId}/candidates?search=${encodeURIComponent(search)}`,
      headers: { cookie: nilsCookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ personId: string; name: string }[]>();
  }

  it("finds a neighbour by their whole name, in either order", async () => {
    /*
     * What somebody types into the search is a name, and a name is two words.
     * Every word has to match a part of it, as it does in the resident
     * directory the picker's rule is taken from - so "Sven Grupp" finds Sven
     * Grupp, and so does "Grupp Sven". Matched against a single column instead,
     * the whole name is in neither and the picker offers nobody.
     */
    const audienceId = await makeGroup(nilsCookie, "Sökgruppen");
    const surname = `Grupp${suffix}`;

    for (const search of [
      `Sven ${surname}`,
      `${surname} Sven`,
      "Sven",
      "sven",
    ]) {
      const offered = await candidatesFor(audienceId, search);
      expect(
        offered.map((each) => each.personId),
        `searching for "${search}"`,
      ).toContain(stranger.personId);
    }

    // A word that matches nobody's name narrows the list to nobody, rather than
    // being ignored.
    const narrowed = await candidatesFor(audienceId, `Sven Nobody${suffix}`);
    expect(narrowed.map((each) => each.personId)).not.toContain(
      stranger.personId,
    );
  });
});

describe("a post reported to the board", () => {
  it("carries that post to the queue and nothing else about the group", async () => {
    const audienceId = await makeGroup(nilsCookie, "Grillkvällen");
    await addToGroup(nilsCookie, audienceId, astrid.personId);
    const postId = await write(
      astridCookie,
      audienceId,
      "Nagot ingen borde skriva.",
    );
    const other = await write(astridCookie, audienceId, "Och nagot vanligt.");

    await report(nilsCookie, postId, "Det har handlar om min lagenhet.");

    const queue = await inject({
      method: "GET",
      url: "/api/feed/reports",
      headers: { cookie: boardCookie },
    });
    expect(queue.statusCode).toBe(200);
    const { reports: rows } = queue.json<PostReportQueueView>();
    const row = rows.find((each) => each.postId === postId);
    expect(row?.body).toBe("Nagot ingen borde skriva.");
    expect(row?.groupName).toBe("Grillkvällen");
    // The other post in that group is not in the queue and there is no route
    // that would fetch it: a report carries one post.
    expect(rows.some((each) => each.postId === other)).toBe(false);
    expect(
      (
        await inject({
          method: "GET",
          url: `/api/feed/posts?audience=${audienceId}`,
          headers: { cookie: boardCookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await inject({
          method: "GET",
          url: `/api/feed/posts/${other}`,
          headers: { cookie: boardCookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("is refused in the board's own audiences", async () => {
    /*
     * Styrelsen and Administratörer have no strike-through, so a post there is
     * refused as what it is rather than as an absence: somebody in either
     * audience learns nothing about a group. Alla is moderated, and
     * `moderation.int-spec.ts` reports from it.
     */
    const { audiences } = await audiencesOf(boardCookie);
    for (const kind of ["BOARD", "ADMIN"] as const) {
      const audience = audiences.find((each) => each.kind === kind);
      const postId = await write(
        boardCookie,
        audience?.id ?? "",
        `Styrelsens egen rad i ${kind}.`,
      );

      const refused = await inject({
        method: "POST",
        url: "/api/feed/reports",
        payload: { postId },
        headers: { cookie: boardCookie },
      });

      expect(refused.statusCode, kind).toBe(422);
      expect(refused.json<{ reason: string }>().reason, kind).toBe(
        "not-reportable",
      );
    }
  });

  it("withholds a struck post from the group and keeps it for its author", async () => {
    const audienceId = await makeGroup(nilsCookie, "Cykelrummet");
    await addToGroup(nilsCookie, audienceId, astrid.personId);
    const postId = await write(astridCookie, audienceId, "Rad som stryks.");

    const reportId = await report(nilsCookie, postId);

    const struck = await inject({
      method: "POST",
      url: `/api/feed/reports/${reportId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(struck.statusCode).toBe(200);

    const forTheGroup = await pageOf(nilsCookie, `audience=${audienceId}`);
    const withheld = forTheGroup.posts.find((post) => post.id === postId);
    // Still in the feed and still attributed: a strike-through, not a removal.
    expect(withheld?.struckAt).not.toBeNull();
    expect(withheld?.body).toBeNull();
    // Nor is the struck text found by a search for it.
    expect(
      idsOn(
        await pageOf(nilsCookie, `q=${encodeURIComponent("Rad som stryks")}`),
      ),
    ).not.toContain(postId);

    const forTheAuthor = await pageOf(astridCookie, `audience=${audienceId}`);
    const kept = forTheAuthor.posts.find((post) => post.id === postId);
    // A strike is a strike-through and never a disappearance.
    expect(kept?.body).toBe("Rad som stryks.");

    expect(
      await prisma.auditLogEntry.count({
        where: { action: "CHAT_MESSAGE_STRUCK", targetId: postId },
      }),
    ).toBe(1);
  });

  it("is not something a resident can read or answer", async () => {
    const refusedQueue = await inject({
      method: "GET",
      url: "/api/feed/reports",
      headers: { cookie: nilsCookie },
    });

    expect(refusedQueue.statusCode).toBe(403);
    expect(refusedQueue.json<{ message?: string }>().message).toContain(
      "chat:moderate",
    );
  });
});

describe("an account holding every capability and no seat", () => {
  it("is refused the queue, and is told the queue is not theirs", async () => {
    /*
     * The instance's administrator. `ADMIN_CAPABILITIES` is every capability,
     * so they hold `chat:moderate` and pass the guard - and a report carries a
     * private group's post in full. Styrelsen already refuses them the
     * audience; a queue that handed them the same text would keep the promise
     * on one path and break it on the other.
     */
    const audienceId = await makeGroup(nilsCookie, "Insynsgruppen");
    await addToGroup(nilsCookie, audienceId, astrid.personId);
    const postId = await write(astridCookie, audienceId, "Rad i gruppen.");
    const reportId = await report(nilsCookie, postId);

    const queue = await inject({
      method: "GET",
      url: "/api/feed/reports",
      headers: { cookie: administratorCookie },
    });

    expect(queue.statusCode).toBe(200);
    const answer = queue.json<PostReportQueueView>();
    expect(answer.reports).toEqual([]);
    // Not "nothing has been reported": that is a fact about a group they may
    // not be told exists.
    expect(answer.mayModerate).toBe(false);

    // And neither act is theirs, answered as a report that is not there.
    for (const act of ["strike", "dismiss"]) {
      const refused = await inject({
        method: "POST",
        url: `/api/feed/reports/${reportId}/${act}`,
        headers: { cookie: administratorCookie },
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "report-not-found",
      );
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { struckAt: true },
    });
    expect(post?.struckAt).toBeNull();
  });
});

describe("a post two people reported", () => {
  it("is answered once: dismissing one closes the other", async () => {
    /*
     * The board decides about the post rather than about one person's report
     * of it. A sibling left open would let the same post be struck through
     * afterwards - the decision the board has just declined to make, made by
     * whoever pressed next.
     */
    const audienceId = await makeGroup(nilsCookie, "Tvåanmälningar");
    await addToGroup(nilsCookie, audienceId, astrid.personId);
    await addToGroup(nilsCookie, audienceId, stranger.personId);
    const postId = await write(
      astridCookie,
      audienceId,
      "Rad som anmäls två gånger.",
    );

    const firstId = await report(nilsCookie, postId);
    const secondId = await report(strangerCookie, postId);

    const dismissed = await inject({
      method: "POST",
      url: `/api/feed/reports/${firstId}/dismiss`,
      headers: { cookie: boardCookie },
    });
    expect(dismissed.statusCode).toBe(200);

    // The other one is closed with it, and says the board left the post
    // standing rather than staying open for somebody to press again.
    const sibling = await prisma.postReport.findUnique({
      where: { id: secondId },
      select: { resolvedAt: true, upheld: true },
    });
    expect(sibling?.resolvedAt).not.toBeNull();
    expect(sibling?.upheld).toBe(false);

    const struck = await inject({
      method: "POST",
      url: `/api/feed/reports/${secondId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(struck.statusCode).toBe(422);
    expect(struck.json<{ reason: string }>().reason).toBe("report-resolved");

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { struckAt: true },
    });
    expect(post?.struckAt).toBeNull();
  });
});

describe("what the access report says about a group", () => {
  it("carries the group, the struck post and what was reported", async () => {
    const audienceId = await makeGroup(nilsCookie, "Rapportgruppen");
    await addToGroup(nilsCookie, audienceId, astrid.personId);
    const postId = await write(astridCookie, audienceId, "Rad i rapporten.");
    const reportId = await report(nilsCookie, postId, "Anmalt av mig.");
    await inject({
      method: "POST",
      url: `/api/feed/reports/${reportId}/strike`,
      headers: { cookie: boardCookie },
    });

    const authors = await reports.generate({
      personId: astrid.personId,
      actorPersonId: boardMember.personId,
    });
    const group = authors.feed.find(
      (audience) => audience.audienceName === "Rapportgruppen",
    );
    expect(group?.audienceKind).toBe("GROUP");
    expect(group?.joinedOn).not.toBeNull();
    const line = group?.posts.find((each) => each.postId === postId);
    // Their own words, on their own report, struck or not - and the date that
    // says a moderation about them happened.
    expect(line?.body).toBe("Rad i rapporten.");
    expect(line?.struckAt).not.toBeNull();

    const reporter = await reports.generate({
      personId: nils.personId,
      actorPersonId: boardMember.personId,
    });
    const filed = reporter.postReports.find(
      (each) => each.groupName === "Rapportgruppen",
    );
    expect(filed?.part).toBe("REPORTED");
    expect(filed?.note).toBe("Anmalt av mig.");
    expect(filed?.struck).toBe(true);
  });
});

describe("the last place in somebody's groups", () => {
  /**
   * Tops Astrid up to one place short of the cap, with groups the afterAll
   * sweep and the finally of each test below both own. She is in groups from
   * the tests above, so what is missing is counted first.
   */
  async function fillToOnePlaceShort(): Promise<string[]> {
    const held = await prisma.groupMember.count({
      where: { personId: astrid.personId, audience: { kind: "GROUP" } },
    });
    const filler = await Promise.all(
      Array.from({ length: GROUPS_PER_PERSON - 1 - held }, (_, index) =>
        prisma.audience.create({
          data: {
            kind: "GROUP",
            name: `Fyllnad ${String(index)}`,
            createdByPersonId: nils.personId,
            members: {
              create: {
                personId: astrid.personId,
                addedByPersonId: nils.personId,
              },
            },
          },
          select: { id: true },
        }),
      ),
    );
    return filler.map((group) => group.id);
  }

  /**
   * Nils adds Astrid to `audienceId` while another press holds her lock.
   *
   * The other press is a transaction that holds Astrid's lock, so the request
   * has to wait behind it. It is let go only once `pg_locks` shows the request
   * queued behind that lock, and it commits `commit` first - the order two
   * presses reach the database in when one of them is the slower. Without the
   * person's lock the request does not wait, counts the groups before the other
   * press has committed and acts on a count that is no longer true.
   *
   * The request is settled before this returns or throws, so that a caller's
   * cleanup never deletes the groups from under a request still running: if
   * the wait or `commit` fails, the holder rolls back, the request is let
   * through and awaited here, and the failure that surfaces is the original
   * one.
   */
  async function addWhileLockHeld(
    audienceId: string,
    commit: (tx: Parameters<typeof lockFeedPerson>[0]) => Promise<void>,
  ) {
    let request: ReturnType<typeof inject> | undefined;
    try {
      // Longer than the wait below, so the transaction held open on purpose is
      // not aborted by the five-second default and its lock released early.
      await prisma.$transaction(
        async (tx) => {
          await lockFeedPerson(tx, astrid.personId);
          request = addToGroup(nilsCookie, audienceId, astrid.personId);
          await waitFor(
            async () =>
              (await advisoryLockCount(
                prisma,
                `feed-person:${astrid.personId}`,
                false,
              )) > 0n,
          );
          await commit(tx);
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
    } catch (error) {
      // The holder has rolled back and its lock is gone. Let the request run
      // out; its own outcome is of no interest next to the failure above.
      await request?.then(
        () => undefined,
        () => undefined,
      );
      throw error;
    }
    return request;
  }

  it("answers a second press on the same name as an add, not as a refusal", async () => {
    const filler = await fillToOnePlaceShort();
    const audienceId = await makeGroup(nilsCookie, "Sista platsen");
    const groupIds = [audienceId, ...filler];

    try {
      const entriesBefore = await prisma.auditLogEntry.count({
        where: { actorPersonId: nils.personId },
      });

      // The other press commits the very membership the request is adding.
      const response = await addWhileLockHeld(audienceId, async (tx) => {
        await tx.groupMember.create({
          data: {
            audienceId,
            personId: astrid.personId,
            addedByPersonId: stranger.personId,
          },
        });
      });
      expect(response?.statusCode).toBe(200);
      expect(response?.json<unknown[]>()).toHaveLength(2);
      expect(
        await prisma.groupMember.count({
          where: { audienceId, personId: astrid.personId },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLogEntry.count({
          where: { actorPersonId: nils.personId },
        }),
      ).toBe(entriesBefore);
    } finally {
      // She is at the cap here, and the tests below put her into more groups.
      await prisma.audience.deleteMany({ where: { id: { in: groupIds } } });
    }
  }, 60_000);

  it("refuses an add to one group when the last place went to another meanwhile", async () => {
    const filler = await fillToOnePlaceShort();
    const groupA = await makeGroup(nilsCookie, "Sista platsen A");
    const groupB = await makeGroup(nilsCookie, "Sista platsen B");
    const groupIds = [groupA, groupB, ...filler];

    try {
      // The other press takes the last place, in a different group.
      const response = await addWhileLockHeld(groupA, async (tx) => {
        await tx.groupMember.create({
          data: {
            audienceId: groupB,
            personId: astrid.personId,
            addedByPersonId: stranger.personId,
          },
        });
      });
      expect(response?.statusCode).toBe(422);
      expect(response?.json<{ reason: string }>().reason).toBe(
        "too-many-groups",
      );
      expect(
        await prisma.groupMember.count({
          where: { personId: astrid.personId, audience: { kind: "GROUP" } },
        }),
      ).toBe(GROUPS_PER_PERSON);
      expect(
        await prisma.groupMember.count({
          where: { audienceId: groupA, personId: astrid.personId },
        }),
      ).toBe(0);
    } finally {
      await prisma.audience.deleteMany({ where: { id: { in: groupIds } } });
    }
  }, 60_000);
});

describe("the purge", () => {
  it("erases a group that has been empty for a year, with its membership list", async () => {
    const audienceId = await makeGroup(nilsCookie, "Gammal grupp");
    await addToGroup(nilsCookie, audienceId, astrid.personId);
    /*
     * Opened and marked read without anything being written in it, which is
     * the state that leaves a read marker behind on an otherwise empty group.
     * The sweep used to delete these by hand; now the group's own foreign key
     * cascades them, and this is the only place that can be shown.
     */
    const marked = await inject({
      method: "POST",
      url: `/api/feed/audiences/${audienceId}/read`,
      headers: { cookie: nilsCookie },
      payload: { readAt: new Date("2024-01-02T00:00:00.000Z").toISOString() },
    });
    expect(marked.statusCode).toBe(200);
    expect(await prisma.audienceRead.count({ where: { audienceId } })).toBe(1);

    // Nothing was ever written in it, and it was made long enough ago that the
    // list of who was in it is the only thing left.
    await prisma.audience.update({
      where: { id: audienceId },
      data: { createdAt: new Date("2024-01-01T00:00:00.000Z") },
    });

    const summary = await purge.run(new Date("2026-09-18T03:59:00.000Z"));

    expect(summary.groupsDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.audience.count({ where: { id: audienceId } })).toBe(0);
    expect(await prisma.groupMember.count({ where: { audienceId } })).toBe(0);
    expect(await prisma.audienceRead.count({ where: { audienceId } })).toBe(0);
  });

  it("leaves a group somebody made this morning alone", async () => {
    const audienceId = await makeGroup(nilsCookie, "Ny grupp");

    await purge.run(new Date("2026-09-18T03:59:00.000Z"));

    expect(await prisma.audience.count({ where: { id: audienceId } })).toBe(1);
  });
});
