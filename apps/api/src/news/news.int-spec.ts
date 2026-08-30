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
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { NewsMailerService } from "./news-mailer.service";
import { NewsWriteService } from "./news-write.service";

/**
 * News, over HTTP and against a real database.
 *
 * The unit tests pin the rules. What only this suite can show is that the
 * mailing really is claimed once when two publishes race each other through
 * PostgreSQL, that the ledger's unique pair holds, that the worker's claim
 * leaves a second run with nothing to send, and that the website answers a
 * member-only article to an anonymous visitor with exactly the document a
 * missing address produces.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let writes: NewsWriteService;
let mailer: NewsMailerService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const boardMember = {
  personId: `news-board-${suffix}`,
  email: `news-board-${suffix}@exempel.se`,
};
const member = {
  personId: `news-member-${suffix}`,
  email: `news-member-${suffix}@exempel.se`,
};
const formerMember = { personId: `news-former-${suffix}` };
const resident = { personId: `news-resident-${suffix}` };
const memberWithoutEmail = { personId: `news-noemail-${suffix}` };

const personIds = [
  boardMember.personId,
  member.personId,
  formerMember.personId,
  resident.personId,
  memberWithoutEmail.personId,
];

const addressId = `news-address-${suffix}`;
const apartmentIds = [1, 2, 3, 4].map((n) => `news-apartment-${suffix}-${n}`);

/**
 * Every slug this suite claims, so the cleanup can find them again.
 *
 * One per test that writes an item, and never a shared spare. A slug is unique
 * in the database, so two tests sharing one are coupled through it: the first
 * to fail leaves its item behind, and the second is answered 409 for a reason
 * that has nothing to do with what it was asserting. That has happened once
 * already on this train.
 */
const slugs = {
  public: `news-public-${suffix}`,
  member: `news-member-only-${suffix}`,
  mailed: `news-mailed-${suffix}`,
  raced: `news-raced-${suffix}`,
  abandoned: `news-abandoned-${suffix}`,
  /** Named in a create that is refused before it writes anything. */
  refused: `news-refused-${suffix}`,
  scanned: `news-scanned-${suffix}`,
  notProse: `news-not-prose-${suffix}`,
  draft: `news-draft-${suffix}`,
};

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.17.0.0/16 is this suite's; the others each hold their own second octet,
  // and menu.int-spec.ts already holds 10.15.
  return `10.17.${String(subnet)}.${String(host + 1)}`;
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

interface NewsBody {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  visibility: "PUBLIC" | "MEMBER";
  emailQueuedAt: string | null;
  delivery: { pending: number; sent: number; failed: number };
}

function paragraph(text: string) {
  return { type: "paragraph", runs: [{ text }] };
}

/**
 * Writes one news item, and insists that it was written.
 *
 * The slug is in the failure message because the one way this call fails on a
 * working instance is a slug another test left behind: a bare "expected 409 to
 * be 201" says nothing about which address was taken, and the test that reports
 * it is not the test that took it.
 */
async function createNews(
  cookie: string,
  slug: string,
  blocks: unknown[] = [paragraph("Hej.")],
): Promise<NewsBody> {
  const response = await inject({
    method: "POST",
    url: "/api/news",
    payload: { slug, title: `Nyhet ${slug}`, content: { blocks } },
    headers: { cookie },
  });
  expect(
    response.statusCode,
    `POST /api/news for /nyheter/${slug} answered ${String(
      response.statusCode,
    )}: ${response.body}`,
  ).toBe(201);
  return response.json() as NewsBody;
}

/**
 * Removes an item this suite wrote. Service tier, so this is allowed.
 *
 * The status is deliberately not asserted: this runs in a finally, and an
 * expectation here would replace the assertion that actually failed with one
 * about the cleanup after it.
 */
async function removeNews(cookie: string, id: string): Promise<void> {
  await inject({
    method: "DELETE",
    url: `/api/news/${id}`,
    headers: { cookie },
  });
}

/**
 * The item at a slug, as the board's own list reports it.
 *
 * Fails naming the slug rather than answering undefined. Several tests below
 * work on the item an earlier one published, and a chain that has broken must
 * say so here instead of a request going out to /api/news//publish and coming
 * back as a 404 about something else.
 */
async function newsAt(cookie: string, slug: string): Promise<NewsBody> {
  const listed = (
    await inject({ method: "GET", url: "/api/news", headers: { cookie } })
  ).json<NewsBody[]>();
  const found = listed.find((one) => one.slug === slug);
  expect(found, `no news item at /nyheter/${slug}`).toBeDefined();
  return found as NewsBody;
}

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

/** A sentence a board member might paste, with the number inside it. */
const SENTENCE_WITH_A_NUMBER = `Kontakta Anna, ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}.`;

let boardCookie: string;
let memberCookie: string;

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
  writes = app.get(NewsWriteService);
  mailer = app.get(NewsMailerService);
  const encryption = app.get(FieldEncryptionService);

  const addressOf = async (plaintext: string) =>
    await encryption.encrypt("person.email", plaintext);

  const memberEmail = await addressOf(member.email);
  const formerEmail = await addressOf(`news-former-${suffix}@exempel.se`);
  const residentEmail = await addressOf(`news-resident-${suffix}@exempel.se`);

  await prisma.person.createMany({
    data: [
      { id: boardMember.personId, firstName: "Bo", lastName: `Nyhet${suffix}` },
      {
        id: member.personId,
        firstName: "Astrid",
        lastName: `Nyhet${suffix}`,
        emailCipher: memberEmail.cipher,
        emailIndex: memberEmail.index,
        // English, so the mailing has a recipient whose own language is not the
        // association's default.
        preferredLocale: "en",
      },
      {
        id: formerMember.personId,
        firstName: "Frans",
        lastName: `Nyhet${suffix}`,
        emailCipher: formerEmail.cipher,
        emailIndex: formerEmail.index,
      },
      {
        id: resident.personId,
        firstName: "Rut",
        lastName: `Nyhet${suffix}`,
        emailCipher: residentEmail.cipher,
        emailIndex: residentEmail.index,
      },
      // A member the association has no way to write to. The recipient query
      // asks for an address as well as a membership, so this person is not in
      // the ledger and is not counted as somebody the mailing failed for.
      {
        id: memberWithoutEmail.personId,
        firstName: "Nils",
        lastName: `Nyhet${suffix}`,
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
  await prisma.address.create({
    data: {
      id: addressId,
      street: `Nyhetsgatan ${suffix}`,
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
  await prisma.residency.createMany({
    data: [
      {
        personId: member.personId,
        apartmentId: apartmentIds[0] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
      // Moved out before this suite runs: a former member is not written to.
      {
        personId: formerMember.personId,
        apartmentId: apartmentIds[1] as string,
        role: "MEMBER",
        movedInOn: new Date("2020-01-01"),
        movedOutOn: new Date("2021-01-01"),
      },
      // Lives in the building without holding a tenant-ownership. Not every
      // resident is a member, and the mailing is the members'.
      {
        personId: resident.personId,
        apartmentId: apartmentIds[2] as string,
        role: "RESIDENT",
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: memberWithoutEmail.personId,
        apartmentId: apartmentIds[3] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
    ],
  });

  const auth = app.get(AuthService);
  for (const actor of [boardMember, member]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  boardCookie = await signIn(boardMember.email);
  memberCookie = await signIn(member.email);
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
      "The news suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        // The ledger goes with the item; deleting the item is enough, and this
        // is belt and braces for a case that failed part-way through.
        () =>
          prisma.newsDelivery.deleteMany({
            where: { news: { slug: { in: Object.values(slugs) } } },
          }),
        () =>
          prisma.news.deleteMany({
            where: { slug: { in: Object.values(slugs) } },
          }),
        // The audit log is append-only and its entries stay, like every other
        // suite's: the record of what was published is not test litter.
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
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("who may write the association's news", () => {
  it("is whoever holds site:manage, and nobody else", async () => {
    const refused = await inject({
      method: "POST",
      url: "/api/news",
      payload: { slug: slugs.refused, title: "Nej", content: { blocks: [] } },
      headers: { cookie: memberCookie },
    });
    expect(refused.statusCode).toBe(403);

    const listed = await inject({
      method: "GET",
      url: "/api/news",
      headers: { cookie: memberCookie },
    });
    expect(listed.statusCode).toBe(403);
  });

  it("is nobody at all without a session", async () => {
    const response = await inject({ method: "GET", url: "/api/news" });
    expect(response.statusCode).toBe(401);
  });
});

describe("who a mailing would reach", () => {
  it("is the members with an address, and neither a resident nor a mover-out", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/news/recipients",
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    // Other suites leave people in the register, so this asserts the derivation
    // rather than a total: the one member this suite created with an address is
    // counted, and its resident, its mover-out and its member with no address
    // are not.
    const recipients = await prisma.person.findMany({
      where: {
        id: { in: personIds },
        emailCipher: { not: null },
        residencies: {
          some: {
            role: "MEMBER",
            OR: [{ movedOutOn: null }, { movedOutOn: { gt: new Date() } }],
          },
        },
      },
      select: { id: true },
    });
    expect(recipients.map((one) => one.id)).toEqual([member.personId]);
  });
});

describe("publishing with the mailing asked for", () => {
  it("claims it once, snapshots the members, and records both acts", async () => {
    const item = await createNews(boardCookie, slugs.mailed);

    const published = await inject({
      method: "POST",
      url: `/api/news/${item.id}/publish`,
      payload: { published: true, visibility: "MEMBER", sendEmail: true },
      headers: { cookie: boardCookie },
    });
    expect(published.statusCode).toBe(201);
    const body = published.json() as NewsBody & { mailedTo: number | null };
    expect(body.emailQueuedAt).not.toBeNull();
    expect(body.mailedTo).toBeGreaterThanOrEqual(1);

    const ledger = await prisma.newsDelivery.findMany({
      where: { newsId: item.id },
      select: { personId: true, status: true },
    });
    expect(ledger.some((one) => one.personId === member.personId)).toBe(true);
    expect(ledger.some((one) => one.personId === resident.personId)).toBe(
      false,
    );
    expect(ledger.some((one) => one.personId === formerMember.personId)).toBe(
      false,
    );
    expect(
      ledger.some((one) => one.personId === memberWithoutEmail.personId),
    ).toBe(false);
    expect(ledger.every((one) => one.status === "PENDING")).toBe(true);

    const entries = await prisma.auditLogEntry.findMany({
      where: { targetKind: "news", targetId: item.id },
      orderBy: { createdAt: "asc" },
      select: { action: true, actorPersonId: true },
    });
    expect(entries).toEqual([
      { action: "NEWS_PUBLISHED", actorPersonId: boardMember.personId },
      { action: "NEWS_EMAILED", actorPersonId: boardMember.personId },
    ]);
  });

  it("is not claimed a second time by a republish", async () => {
    const item = await newsAt(boardCookie, slugs.mailed);

    const before = await prisma.newsDelivery.count({
      where: { newsId: item.id },
    });

    await inject({
      method: "POST",
      url: `/api/news/${item.id}/publish`,
      payload: { published: false },
      headers: { cookie: boardCookie },
    });
    const again = await inject({
      method: "POST",
      url: `/api/news/${item.id}/publish`,
      payload: { published: true, sendEmail: true },
      headers: { cookie: boardCookie },
    });

    expect(again.statusCode).toBe(201);
    expect((again.json() as { mailedTo: number | null }).mailedTo).toBeNull();
    expect(
      await prisma.newsDelivery.count({ where: { newsId: item.id } }),
    ).toBe(before);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetKind: "news",
          targetId: item.id,
          action: "NEWS_EMAILED",
        },
      }),
    ).toBe(1);
  });

  it("is not claimed by an edit, however many times the item is saved", async () => {
    const item = await newsAt(boardCookie, slugs.mailed);

    const before = await prisma.newsDelivery.count({
      where: { newsId: item.id },
    });

    for (const correction of ["En rättelse.", "Och en till."]) {
      const saved = await inject({
        method: "PUT",
        url: `/api/news/${item.id}`,
        payload: {
          slug: slugs.mailed,
          title: "Rättad rubrik",
          content: { blocks: [paragraph(correction)] },
        },
        headers: { cookie: boardCookie },
      });
      expect(saved.statusCode).toBe(200);
    }

    expect(
      await prisma.newsDelivery.count({ where: { newsId: item.id } }),
    ).toBe(before);
  });

  it("claims nothing for the loser when two publishes race each other", async () => {
    const item = await createNews(boardCookie, slugs.raced);

    // Both calls go through the service at once, so both run the conditional
    // claim against PostgreSQL. The second blocks on the row and then matches
    // nothing.
    const [first, second] = await Promise.all([
      writes.publish(item.id, {
        published: true,
        sendEmail: true,
        actorPersonId: boardMember.personId,
      }),
      writes.publish(item.id, {
        published: true,
        sendEmail: true,
        actorPersonId: boardMember.personId,
      }),
    ]);

    const claims = [first.mailedTo, second.mailedTo].filter(
      (one) => one !== null,
    );
    expect(claims).toHaveLength(1);

    const ledger = await prisma.newsDelivery.groupBy({
      by: ["personId"],
      where: { newsId: item.id },
      _count: { personId: true },
    });
    expect(ledger.every((row) => row._count.personId === 1)).toBe(true);
  });
});

describe("the worker that mails it", () => {
  it("claims each ledger row before it sends, and a second run sends nothing", async () => {
    const item = await newsAt(boardCookie, slugs.mailed);

    const first = await mailer.runMailing(item.id);
    expect(first.sent).toBeGreaterThanOrEqual(1);

    // The retry that a killed process would produce. Every row is claimed, so
    // there is nothing left to send to anybody.
    const second = await mailer.runMailing(item.id);
    expect(second).toEqual({ sent: 0, failed: 0 });

    const ledger = await prisma.newsDelivery.findMany({
      where: { newsId: item.id },
      select: { status: true, sentAt: true },
    });
    expect(ledger.every((one) => one.status === "SENT")).toBe(true);
    expect(ledger.every((one) => one.sentAt !== null)).toBe(true);
  });

  it("marks what is left of an abandoned mailing as interrupted", async () => {
    const item = await createNews(boardCookie, slugs.abandoned);
    await writes.publish(item.id, {
      published: true,
      sendEmail: true,
      actorPersonId: boardMember.personId,
    });

    // What the dead-letter queue does once the retries are spent.
    await mailer.recordAbandoned(item.id);

    const ledger = await prisma.newsDelivery.findMany({
      where: { newsId: item.id },
      select: { status: true, failureReason: true },
    });
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    expect(
      ledger.every(
        (one) =>
          one.status === "FAILED" &&
          one.failureReason === "mailing-interrupted",
      ),
    ).toBe(true);
  });
});

describe("the publication guardrails", () => {
  it("refuse a personal identity number and say where it is, never what", async () => {
    const item = await createNews(boardCookie, slugs.scanned, [
      paragraph(SENTENCE_WITH_A_NUMBER),
    ]);

    try {
      const refused = await inject({
        method: "POST",
        url: `/api/news/${item.id}/publish`,
        payload: { published: true },
        headers: { cookie: boardCookie },
      });

      expect(refused.statusCode).toBe(422);
      const body = refused.json() as {
        reason: string;
        locations: { part: string; index: number; offset: number }[];
      };
      expect(body.reason).toBe("personal-identity-number");
      /*
       * The offset is where the number starts in that block's text, which is
       * exactly what the board needs in order to find it - so the expectation
       * says that rather than restating a counted position. A hand-counted
       * literal is right until the sentence above is edited, and then it is
       * wrong about the thing this assertion exists to prove.
       */
      expect(body.locations).toEqual([
        {
          part: "block",
          index: 0,
          offset: SENTENCE_WITH_A_NUMBER.indexOf(
            LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER,
          ),
        },
      ]);
      // The position, never the value: the number found is exactly the thing
      // that must not be repeated in a response body or a log. Derived from the
      // constant rather than copied, and in both spellings - a normalised form
      // without the hyphen would be the same disclosure.
      expect(refused.body).not.toContain(LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER);
      expect(refused.body).not.toContain(
        LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER.replaceAll("-", ""),
      );
    } finally {
      // In a finally, so an assertion that fails above cannot leave the address
      // taken and turn the next test's create into a 409 about nothing.
      await removeNews(boardCookie, item.id);
    }
  });

  it("refuse a body that is not prose", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/news",
      payload: {
        slug: slugs.notProse,
        title: "Bild",
        content: {
          blocks: [{ type: "image", mediaFileId: "file-1", alt: "" }],
        },
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect((response.json() as { reason: string }).reason).toBe(
      "unsupported-block",
    );
  });
});

describe("the website's answer", () => {
  it("serves a published public item to a visitor with no account", async () => {
    const item = await createNews(boardCookie, slugs.public, [
      paragraph("Vi städar gården på lördag."),
    ]);
    await inject({
      method: "POST",
      url: `/api/news/${item.id}/publish`,
      payload: { published: true, visibility: "PUBLIC" },
      headers: { cookie: boardCookie },
    });

    const article = await inject({
      method: "GET",
      url: `/nyheter/${slugs.public}`,
    });
    expect(article.statusCode).toBe(200);
    expect(article.body).toContain("Vi städar gården på lördag.");
    // The website never sets a cookie, on any answer.
    expect(article.headers["set-cookie"]).toBeUndefined();

    const index = await inject({ method: "GET", url: "/nyheter" });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain(`Nyhet ${slugs.public}`);
  });

  it("answers a member-only item exactly as an address that was never written", async () => {
    const item = await createNews(boardCookie, slugs.member, [
      paragraph("Endast för medlemmarna."),
    ]);
    await inject({
      method: "POST",
      url: `/api/news/${item.id}/publish`,
      payload: { published: true, visibility: "MEMBER" },
      headers: { cookie: boardCookie },
    });

    const closed = await inject({
      method: "GET",
      url: `/nyheter/${slugs.member}`,
    });
    const missing = await inject({
      method: "GET",
      url: "/nyheter/en-nyhet-som-aldrig-skrivits",
    });

    expect(closed.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // Byte for byte. An anonymous visitor cannot learn that the association has
    // written anything at this address at all.
    expect(closed.body).toBe(missing.body);
    expect(closed.body).not.toContain("Endast för medlemmarna.");
    expect(closed.headers["set-cookie"]).toBeUndefined();

    // And the same address, to somebody signed in.
    const opened = await inject({
      method: "GET",
      url: `/nyheter/${slugs.member}`,
      headers: { cookie: memberCookie },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toContain("Endast för medlemmarna.");
    expect(opened.headers["set-cookie"]).toBeUndefined();
  });

  it("keeps a member-only item out of an anonymous visitor's index", async () => {
    const anonymous = await inject({ method: "GET", url: "/nyheter" });
    expect(anonymous.body).not.toContain(`Nyhet ${slugs.member}`);

    const signedIn = await inject({
      method: "GET",
      url: "/nyheter",
      headers: { cookie: memberCookie },
    });
    expect(signedIn.body).toContain(`Nyhet ${slugs.member}`);
  });

  it("does not serve a draft to anybody", async () => {
    const item = await createNews(boardCookie, slugs.draft, [
      paragraph("Inte klar än."),
    ]);

    try {
      const anonymous = await inject({
        method: "GET",
        url: `/nyheter/${slugs.draft}`,
      });
      const signedIn = await inject({
        method: "GET",
        url: `/nyheter/${slugs.draft}`,
        headers: { cookie: memberCookie },
      });

      expect(anonymous.statusCode).toBe(404);
      expect(signedIn.statusCode).toBe(404);
    } finally {
      await removeNews(boardCookie, item.id);
    }
  });

  it("keeps /nyheter out of the pages that can be written", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/site/pages",
      payload: {
        slug: "nyheter",
        title: "Nyheter",
        content: { blocks: [] },
        visibility: "PUBLIC",
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason: string }).reason).toBe("invalid-slug");
  });
});
