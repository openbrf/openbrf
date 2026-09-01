import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { NEWS_COMMENT_MAX_LENGTH } from "./news-comment.service";
import { NewsCommentPurgeService } from "./news-comment-purge.service";

/**
 * Comments on the association's news, over HTTP and against a real database.
 *
 * The unit tests pin the rules. Four things only this suite can show, and each
 * one is a promise made outside the service.
 *
 * That the capability really gates the routes as the class decorators claim -
 * a resident writes and reads, somebody holding neither capability is refused,
 * and nobody at all is refused without a session.
 *
 * That no comment reaches the public website. That is a property of the whole
 * application rather than of one service: the website renders in the same
 * process from its own module, and the only honest way to assert it is to
 * publish an item, comment on it, and read the rendered page as a visitor from
 * the street.
 *
 * That the visibility a comment inherits holds in both directions - a
 * member-only item's thread opens to a resident signed in, and a draft's thread
 * is answered exactly as an item that was never written.
 *
 * And that the purge erases what it says it does, that a legal hold placed
 * against the author stops it, and that the audit entry lands in the same
 * transaction.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
/** Whether this suite is what created the association, and so owes its removal. */
let associationCreated = false;

let prisma: PrismaService;
let purge: NewsCommentPurgeService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const boardMember = {
  personId: `comment-board-${suffix}`,
  email: `comment-board-${suffix}@exempel.se`,
};
const member = {
  personId: `comment-member-${suffix}`,
  email: `comment-member-${suffix}@exempel.se`,
};
/** Protected personal data: named to nobody, in every read. */
const protectedMember = {
  personId: `comment-protected-${suffix}`,
  email: `comment-protected-${suffix}@exempel.se`,
};
/**
 * An external property manager: holds issues:handle and their own account, and
 * neither news:comment nor site:manage.
 */
const manager = {
  personId: `comment-manager-${suffix}`,
  email: `comment-manager-${suffix}@exempel.se`,
};
/**
 * Nobody the purge should reach, because a hold stands against them.
 *
 * Their comment is written directly rather than through the API, so there is no
 * account and no session for them: a hold is about what the association may
 * erase, and nothing here needs them to sign in.
 */
const heldMember = { personId: `comment-held-${suffix}` };

/** Everybody this suite signs in as. */
const actors = [boardMember, member, protectedMember, manager];
const personIds = [...actors, heldMember].map((actor) => actor.personId);

const addressId = `comment-address-${suffix}`;
const apartmentIds = [1, 2, 3, 4].map(
  (n) => `comment-apartment-${suffix}-${n}`,
);

/**
 * Every slug this suite claims, so the cleanup can find them again.
 *
 * One per test that writes an item and never a shared spare, for the reason the
 * news suite gives: a slug is unique in the database, so two tests sharing one
 * are coupled through it and the second is answered 409 for a reason that has
 * nothing to do with what it was asserting.
 */
const slugs = {
  public: `comment-public-${suffix}`,
  member: `comment-member-only-${suffix}`,
  draft: `comment-draft-${suffix}`,
  moderated: `comment-moderated-${suffix}`,
  scanned: `comment-scanned-${suffix}`,
  purged: `comment-purged-${suffix}`,
  held: `comment-held-item-${suffix}`,
};

/** The name nobody is ever shown. Distinctive, so a leak is unmistakable. */
const PROTECTED_LAST_NAME = `Skyddadsson${suffix}`;

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.34.0.0/16 is this suite's; the others each hold their own second octet,
  // with 10.30 the event series suite, 10.31 motions, 10.32 the registers
  // and 10.33 event sign-ups.
  return `10.34.${String(subnet)}.${String(host + 1)}`;
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

interface CommentBody {
  id: string;
  author:
    | { kind: "resident"; personId: string; name: string }
    | { kind: "protected"; personId: string }
    | { kind: "unknown" };
  body: string | null;
  hiddenAt: string | null;
  createdAt: string;
}

/** Writes one news item and publishes it to the audience given. */
async function publishedNews(
  slug: string,
  visibility: "PUBLIC" | "MEMBER",
  text: string,
): Promise<string> {
  const created = await inject({
    method: "POST",
    url: "/api/news",
    payload: {
      slug,
      title: `Nyhet ${slug}`,
      content: { blocks: [{ type: "paragraph", runs: [{ text }] }] },
    },
    headers: { cookie: boardCookie },
  });
  expect(
    created.statusCode,
    `POST /api/news for /nyheter/${slug} answered ${String(
      created.statusCode,
    )}: ${created.body}`,
  ).toBe(201);
  const id = (created.json() as { id: string }).id;

  const published = await inject({
    method: "POST",
    url: `/api/news/${id}/publish`,
    payload: { published: true, visibility },
    headers: { cookie: boardCookie },
  });
  expect(published.statusCode, published.body).toBe(201);
  return id;
}

/** Writes one news item and leaves it a draft. */
async function draftNews(slug: string, text: string): Promise<string> {
  const created = await inject({
    method: "POST",
    url: "/api/news",
    payload: {
      slug,
      title: `Nyhet ${slug}`,
      content: { blocks: [{ type: "paragraph", runs: [{ text }] }] },
    },
    headers: { cookie: boardCookie },
  });
  expect(created.statusCode, created.body).toBe(201);
  return (created.json() as { id: string }).id;
}

/** Writes one comment through the API, insisting that it was written. */
async function writeComment(
  cookie: string,
  newsId: string,
  body: string,
): Promise<CommentBody> {
  const response = await inject({
    method: "POST",
    url: `/api/news-comments/${newsId}`,
    payload: { body },
    headers: { cookie },
  });
  expect(
    response.statusCode,
    `POST /api/news-comments/${newsId} answered ${String(
      response.statusCode,
    )}: ${response.body}`,
  ).toBe(201);
  return response.json() as CommentBody;
}

async function readThread(
  cookie: string,
  newsId: string,
): Promise<CommentBody[]> {
  const response = await inject({
    method: "GET",
    url: `/api/news-comments/${newsId}`,
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as CommentBody[];
}

let boardCookie: string;
let memberCookie: string;
let protectedCookie: string;
let managerCookie: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(baseEnv satisfies Env)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  purge = app.get(NewsCommentPurgeService);

  /*
   * The association this suite needs, made the way every other suite in this
   * directory makes its own: nothing seeds it. An existing row is left as it is
   * - a suite that ran first is entitled to its own.
   */
  const associationBefore = await prisma.association.findUnique({
    where: { id: 1 },
    select: { id: true },
  });
  if (associationBefore === null) {
    associationCreated = true;
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet" },
    });
  }

  await prisma.person.createMany({
    data: [
      {
        id: boardMember.personId,
        firstName: "Bo",
        lastName: `Kommentar${suffix}`,
      },
      {
        id: member.personId,
        firstName: "Astrid",
        lastName: `Kommentar${suffix}`,
      },
      {
        id: protectedMember.personId,
        firstName: "Siv",
        lastName: PROTECTED_LAST_NAME,
        protectedPersonalData: true,
      },
      {
        id: manager.personId,
        firstName: "Mats",
        lastName: `Kommentar${suffix}`,
      },
      {
        id: heldMember.personId,
        firstName: "Harald",
        lastName: `Kommentar${suffix}`,
      },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: boardMember.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: `Kommentarsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: apartmentIds.map((id, index) => ({
          id,
          number: String(1001 + index),
          floor: 0,
        })),
      },
    },
  });
  // Residencies for everybody who has to hold news:comment, and none for the
  // property manager: they handle the association's issues, they do not live
  // in the building.
  await prisma.residency.createMany({
    data: [
      {
        personId: member.personId,
        apartmentId: apartmentIds[0] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: protectedMember.personId,
        apartmentId: apartmentIds[1] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: heldMember.personId,
        apartmentId: apartmentIds[2] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: boardMember.personId,
        apartmentId: apartmentIds[3] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
    ],
  });

  const auth = app.get(AuthService);
  for (const actor of actors) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  boardCookie = await signIn(boardMember.email);
  memberCookie = await signIn(member.email);
  protectedCookie = await signIn(protectedMember.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

async function cleanUp(
  steps: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    await step().catch((cause: unknown) => failures.push(cause));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "The news comment suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        // The comments go with the item; deleting the item is enough, and this
        // is belt and braces for a case that failed part-way through.
        () =>
          prisma.newsComment.deleteMany({
            where: { news: { slug: { in: Object.values(slugs) } } },
          }),
        () =>
          prisma.news.deleteMany({
            where: { slug: { in: Object.values(slugs) } },
          }),
        // The audit log is append-only and its entries stay, like every other
        // suite's: the record of what was written is not test litter.
        () =>
          prisma.legalHold.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.apartment.deleteMany({ where: { id: { in: apartmentIds } } }),
        () => prisma.address.deleteMany({ where: { id: addressId } }),
        () =>
          prisma.boardPosition.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.systemRole.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.session.deleteMany({
            where: { user: { personId: { in: personIds } } },
          }),
        () =>
          prisma.account.deleteMany({
            where: { user: { personId: { in: personIds } } },
          }),
        () =>
          prisma.user.deleteMany({ where: { personId: { in: personIds } } }),
        () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
        () =>
          associationCreated
            ? prisma.association.deleteMany({ where: { id: 1 } })
            : Promise.resolve(),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("who may write and read a comment", () => {
  it("is whoever holds news:comment, and nobody else", async () => {
    const newsId = await publishedNews(
      slugs.public,
      "PUBLIC",
      "Vi byter portkod pa lordag.",
    );

    // A resident holds it.
    await writeComment(memberCookie, newsId, "Tack for beskedet.");
    expect(await readThread(memberCookie, newsId)).toHaveLength(1);

    // The external property manager holds neither news:comment nor
    // site:manage: they handle the association's issues and do not live here.
    const refusedWrite = await inject({
      method: "POST",
      url: `/api/news-comments/${newsId}`,
      payload: { body: "Nej." },
      headers: { cookie: managerCookie },
    });
    const refusedRead = await inject({
      method: "GET",
      url: `/api/news-comments/${newsId}`,
      headers: { cookie: managerCookie },
    });
    expect(refusedWrite.statusCode).toBe(403);
    expect(refusedRead.statusCode).toBe(403);

    // And the thread is unchanged: the refusal is a refusal, not a write that
    // answered 403 afterwards.
    expect(await readThread(memberCookie, newsId)).toHaveLength(1);
  });

  it("is nobody at all without a session", async () => {
    const newsId = (
      await prisma.news.findUniqueOrThrow({
        where: { slug: slugs.public },
        select: { id: true },
      })
    ).id;

    const read = await inject({
      method: "GET",
      url: `/api/news-comments/${newsId}`,
    });
    const write = await inject({
      method: "POST",
      url: `/api/news-comments/${newsId}`,
      payload: { body: "Hej." },
    });

    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
  });

  it("only lets the board hide one", async () => {
    const newsId = await publishedNews(
      slugs.moderated,
      "MEMBER",
      "Om stamningen i tvattstugan.",
    );
    const written = await writeComment(
      memberCookie,
      newsId,
      "Detta blir moddat.",
    );

    const refused = await inject({
      method: "POST",
      url: `/api/news-comment-moderation/${written.id}/hide`,
      headers: { cookie: memberCookie },
    });
    expect(refused.statusCode).toBe(403);

    // Not merely refused: the comment still stands, so the 403 stopped the act
    // and not only the answer.
    const beforeBoard = await readThread(boardCookie, newsId);
    expect(beforeBoard[0]?.hiddenAt).toBeNull();

    const hidden = await inject({
      method: "POST",
      url: `/api/news-comment-moderation/${written.id}/hide`,
      headers: { cookie: boardCookie },
    });
    expect(hidden.statusCode).toBe(201);
    expect((hidden.json() as CommentBody).hiddenAt).not.toBeNull();
  });
});

describe("no comment reaches the public website", () => {
  it("is absent from a public item's own page and from the index", async () => {
    /*
     * The load-bearing assertion of this suite, and a property of the whole
     * application rather than of one service. A comment on a PUBLIC news item is
     * still not public: the website takes no authenticated writes and reads no
     * session at all, so a thread there would be either anonymous or a login
     * wall on a page that promises neither.
     *
     * Read as a visitor from the street, with the item confirmed to be rendering
     * first. Without that the assertion would be satisfied by a page that failed
     * to render anything - which is the shape a test passes in while the thing
     * it guards is broken.
     */
    const newsId = (
      await prisma.news.findUniqueOrThrow({
        where: { slug: slugs.public },
        select: { id: true },
      })
    ).id;
    const secret = `Kommentaren-syns-inte-${suffix}`;
    await writeComment(memberCookie, newsId, secret);

    const article = await inject({
      method: "GET",
      url: `/nyheter/${slugs.public}`,
    });
    expect(article.statusCode).toBe(200);
    // The notice itself is on the page, so the assertions below are about the
    // comment being absent and not about the page being empty.
    expect(article.body).toContain("Vi byter portkod pa lordag.");
    expect(article.body).not.toContain(secret);
    expect(article.body).not.toContain(`Kommentar${suffix}`);
    expect(article.headers["set-cookie"]).toBeUndefined();

    const index = await inject({ method: "GET", url: "/nyheter" });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain(`Nyhet ${slugs.public}`);
    expect(index.body).not.toContain(secret);
  });

  it("is absent even from the page a member is reading", async () => {
    // The website has one renderer and one audience rule, and a session on it
    // opens member-only items and nothing else. A thread rendered for a signed-in
    // visitor would be a second surface for the same data with none of the
    // application's own moderation controls on it.
    const article = await inject({
      method: "GET",
      url: `/nyheter/${slugs.public}`,
      headers: { cookie: memberCookie },
    });

    expect(article.statusCode).toBe(200);
    expect(article.body).not.toContain(`Kommentaren-syns-inte-${suffix}`);
  });
});

describe("a comment is exactly as visible as its news item", () => {
  it("opens a member-only item's thread to a resident signed in", async () => {
    const newsId = await publishedNews(
      slugs.member,
      "MEMBER",
      "Endast for medlemmarna.",
    );

    await writeComment(memberCookie, newsId, "Last och forstatt.");

    // The inheritance in its useful direction: member-only is not no-one, and a
    // resident reaching /app has the session the website's rule asks for.
    expect(await readThread(memberCookie, newsId)).toHaveLength(1);
  });

  it("answers a draft's thread as an item that was never written", async () => {
    const draftId = await draftNews(slugs.draft, "Inte klart an.");

    const onDraft = await inject({
      method: "GET",
      url: `/api/news-comments/${draftId}`,
      headers: { cookie: memberCookie },
    });
    const onNothing = await inject({
      method: "GET",
      url: `/api/news-comments/en-nyhet-som-aldrig-skrivits`,
      headers: { cookie: memberCookie },
    });
    const writeToDraft = await inject({
      method: "POST",
      url: `/api/news-comments/${draftId}`,
      payload: { body: "Hej." },
      headers: { cookie: memberCookie },
    });

    expect(onDraft.statusCode).toBe(404);
    expect(onNothing.statusCode).toBe(404);
    expect((onDraft.json() as { reason: string }).reason).toBe(
      (onNothing.json() as { reason: string }).reason,
    );
    expect(writeToDraft.statusCode).toBe(404);

    // And nothing was written into it, so the draft cannot be commented on by a
    // caller who ignores the answer.
    expect(await prisma.newsComment.count({ where: { newsId: draftId } })).toBe(
      0,
    );
  });
});

describe("what a comment may carry", () => {
  it("refuses a personal identity number, saying where and never what", async () => {
    const newsId = await publishedNews(
      slugs.scanned,
      "MEMBER",
      "Om grannens fordon.",
    );
    const body = `Det ar ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER} som star dar.`;

    const refused = await inject({
      method: "POST",
      url: `/api/news-comments/${newsId}`,
      payload: { body },
      headers: { cookie: memberCookie },
    });

    expect(refused.statusCode).toBe(422);
    const answer = refused.json() as {
      reason: string;
      locations: { part: string; offset: number }[];
    };
    expect(answer.reason).toBe("personal-identity-number");
    expect(answer.locations).toEqual([
      { part: "body", offset: body.indexOf("1981") },
    ]);
    // The whole response body, not the field the number would have travelled in.
    expect(refused.body).not.toContain(LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER);
    expect(refused.body).not.toContain("198112189876");

    expect(await prisma.newsComment.count({ where: { newsId } })).toBe(0);
  });

  it("refuses a comment longer than the cap, and one that is only spaces", async () => {
    const newsId = (
      await prisma.news.findUniqueOrThrow({
        where: { slug: slugs.scanned },
        select: { id: true },
      })
    ).id;

    const tooLong = await inject({
      method: "POST",
      url: `/api/news-comments/${newsId}`,
      payload: { body: "a".repeat(NEWS_COMMENT_MAX_LENGTH + 1) },
      headers: { cookie: memberCookie },
    });
    const blank = await inject({
      method: "POST",
      url: `/api/news-comments/${newsId}`,
      payload: { body: "   " },
      headers: { cookie: memberCookie },
    });
    // The cap itself, to the character: a comment exactly that long is a comment.
    const atTheCap = await inject({
      method: "POST",
      url: `/api/news-comments/${newsId}`,
      payload: { body: "a".repeat(NEWS_COMMENT_MAX_LENGTH) },
      headers: { cookie: memberCookie },
    });

    expect(tooLong.statusCode).toBe(400);
    expect(blank.statusCode).toBe(400);
    expect(atTheCap.statusCode).toBe(201);
  });
});

describe("an author with protected personal data", () => {
  it("is named to nobody, the board included", async () => {
    const newsId = (
      await prisma.news.findUniqueOrThrow({
        where: { slug: slugs.member },
        select: { id: true },
      })
    ).id;

    await writeComment(protectedCookie, newsId, "Ett inlagg fran mig.");

    for (const cookie of [memberCookie, boardCookie, protectedCookie]) {
      const thread = await readThread(cookie, newsId);
      const mine = thread.find(
        (one) =>
          one.author.kind !== "unknown" &&
          one.author.personId === protectedMember.personId,
      );
      expect(mine?.author.kind).toBe("protected");
      // Not merely absent from the name field: the payload does not carry it
      // anywhere, and the board's own reveal capability does not open it here.
      expect(JSON.stringify(thread)).not.toContain(PROTECTED_LAST_NAME);
      expect(JSON.stringify(thread)).not.toContain("Siv");
    }
  });
});

describe("hiding a comment", () => {
  it("strikes it through for readers and leaves it readable to the board", async () => {
    const newsId = (
      await prisma.news.findUniqueOrThrow({
        where: { slug: slugs.moderated },
        select: { id: true },
      })
    ).id;

    const forReader = await readThread(protectedCookie, newsId);
    const forBoard = await readThread(boardCookie, newsId);
    const forAuthor = await readThread(memberCookie, newsId);

    // Still in the thread, for everybody. A board that could make a comment
    // disappear would leave nobody able to tell which had happened.
    expect(forReader).toHaveLength(1);
    expect(forReader[0]?.hiddenAt).not.toBeNull();
    expect(forReader[0]?.body).toBeNull();
    expect(JSON.stringify(forReader)).not.toContain("Detta blir moddat.");

    expect(forBoard[0]?.body).toBe("Detta blir moddat.");
    expect(forAuthor[0]?.body).toBe("Detta blir moddat.");
  });

  it("keeps the row rather than deleting it", async () => {
    const newsId = (
      await prisma.news.findUniqueOrThrow({
        where: { slug: slugs.moderated },
        select: { id: true },
      })
    ).id;

    const rows = await prisma.newsComment.findMany({
      where: { newsId },
      select: { body: true, hiddenAt: true, hiddenByPersonId: true },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("Detta blir moddat.");
    expect(rows[0]?.hiddenAt).not.toBeNull();
    expect(rows[0]?.hiddenByPersonId).toBe(boardMember.personId);
  });

  it("is recorded in the audit log against the person it was done to", async () => {
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "NEWS_COMMENT_HIDDEN",
        actorPersonId: boardMember.personId,
        targetPersonId: member.personId,
      },
      select: { targetKind: true },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetKind).toBe("newsComment");
  });
});

describe("the purge", () => {
  it("erases a comment a year after it was written, and records that it did", async () => {
    const newsId = await publishedNews(
      slugs.purged,
      "MEMBER",
      "En gammal nyhet.",
    );

    /*
     * Written directly, with the date set. The window is a year and this suite
     * is not going to wait for it; the API's own path is exercised by every
     * other test here.
     */
    const old = await prisma.newsComment.create({
      data: {
        newsId,
        authorPersonId: member.personId,
        body: "Skrivet for lange sedan.",
        createdAt: new Date("2025-01-01T10:00:00.000Z"),
      },
      select: { id: true },
    });
    const recent = await prisma.newsComment.create({
      data: {
        newsId,
        authorPersonId: member.personId,
        body: "Skrivet nyligen.",
      },
      select: { id: true },
    });

    const summary = await purge.run(new Date("2026-06-01T03:11:00.000Z"), 365);

    expect(summary.commentsDeleted).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.newsComment.findUnique({
        where: { id: old.id },
        select: { id: true },
      }),
    ).toBeNull();
    // And the one inside its window is untouched, so the cutoff is a cutoff and
    // not a table scan.
    expect(
      await prisma.newsComment.findUnique({
        where: { id: recent.id },
        select: { id: true },
      }),
    ).not.toBeNull();

    const purgeEntries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetPersonId: member.personId,
        targetKind: "newsComment",
      },
      select: { context: true, actorPersonId: true },
    });
    expect(purgeEntries).toHaveLength(1);
    // Nobody clicked it: the job ran because a date arrived.
    expect(purgeEntries[0]?.actorPersonId).toBeNull();
    expect(purgeEntries[0]?.context).toMatchObject({
      retentionDaysAfterComment: 365,
    });
  });

  it("is stopped by a legal hold standing against the author", async () => {
    const newsId = await publishedNews(
      slugs.held,
      "MEMBER",
      "En nyhet med en tvist under.",
    );
    const held = await prisma.newsComment.create({
      data: {
        newsId,
        authorPersonId: heldMember.personId,
        body: "Detta ar vad tvisten handlar om.",
        createdAt: new Date("2025-01-01T10:00:00.000Z"),
      },
      select: { id: true },
    });

    await prisma.legalHold.create({
      data: {
        personId: heldMember.personId,
        reason: `Tvist ${suffix}`,
        placedByPersonId: boardMember.personId,
      },
    });

    const summary = await purge.run(new Date("2026-06-01T03:11:00.000Z"), 365);

    // Not in the scan's answer at all: held people are excluded by the query
    // rather than dropped from it, or five hundred of them could spend a run's
    // whole bound and the comments behind them would outlive their window.
    expect(
      await purge.eligible(new Date("2026-06-01T03:11:00.000Z"), 365),
    ).not.toContain(heldMember.personId);
    expect(summary.commentsDeleted).toBe(0);
    expect(
      await prisma.newsComment.findUnique({
        where: { id: held.id },
        select: { id: true },
      }),
    ).not.toBeNull();

    // And the check inside the deleting transaction is the one that counts: a
    // hold placed after the scan has to win, which is what this asserts by
    // asking the purge to erase for a person it was never given.
    await expect(
      purge.purgePerson(
        heldMember.personId,
        new Date("2026-06-01T03:11:00.000Z"),
        365,
      ),
    ).resolves.toBe(0);
    expect(
      await prisma.newsComment.findUnique({
        where: { id: held.id },
        select: { id: true },
      }),
    ).not.toBeNull();
  });
});

describe("what the association keeps about one person", () => {
  it("carries the comment in full on the data subject access report", async () => {
    /*
     * The section itself is asserted by the retention suite's own fixtures. What
     * this asserts is that the section is populated by a comment written through
     * the API rather than only by a row a fixture inserted - the body in full,
     * whether or not the board struck it through.
     */
    const report = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${member.personId}`,
      headers: { cookie: boardCookie },
    });

    expect(report.statusCode, report.body).toBe(200);
    const body = report.json() as {
      newsComments: { body: string; hidden: boolean; erasableFrom: string }[];
    };
    const struck = body.newsComments.find((one) => one.hidden);
    expect(struck?.body).toBe("Detta blir moddat.");
    // Its own retention date, a year after it was written, and not the one at
    // the foot of the document.
    expect(struck?.erasableFrom).not.toBeNull();
  });
});
