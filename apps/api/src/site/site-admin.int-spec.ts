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
import { registerMultipart } from "../http/multipart";
import { pngBytes } from "../media/testing/image-fixtures";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * The board's own screen for the association's website, over HTTP.
 *
 * The unit tests pin the guardrails as rules. What only this suite can show is
 * that they are the rules the routes actually run, that the capability is the
 * gate, and that a page written here is then answered by the public website
 * exactly as the website promises: a member-only page indistinguishable from
 * one that was never written, and no cookie on any of it.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const boardMember = {
  personId: `site-admin-board-${suffix}`,
  email: `site-admin-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `site-admin-resident-${suffix}`,
  email: `site-admin-resident-${suffix}@exempel.se`,
};
const actors = [boardMember, resident];
const personIds = actors.map((actor) => actor.personId);

const addressId = `site-admin-address-${suffix}`;
const apartmentId = `site-admin-apartment-${suffix}`;

/**
 * Every slug this suite claims, so the cleanup can find them again.
 *
 * One per test that actually writes a page, and never one shared between two.
 * A slug is unique in the database, so two tests sharing one are coupled
 * through it: the first to leave its page behind makes the second's create
 * answer 409, and the second then fails somewhere else entirely with a refusal
 * about a page id it never had. `spare` is only ever used by the tests whose
 * whole point is that the create is refused, so nothing is written under it.
 */
const slugs = {
  public: `site-admin-public-${suffix}`,
  member: `site-admin-member-${suffix}`,
  picture: `site-admin-picture-${suffix}`,
  scan: `site-admin-scan-${suffix}`,
  missingImage: `site-admin-missing-image-${suffix}`,
  internalImage: `site-admin-internal-image-${suffix}`,
  spare: `site-admin-spare-${suffix}`,
};

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.14.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.14.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object | Buffer;
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

interface PageBody {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  visibility: "PUBLIC" | "MEMBER";
  content: { blocks: unknown[] };
}

function paragraph(text: string) {
  return { type: "paragraph", runs: [{ text }] };
}

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

/** A sentence a board member might paste, with the number inside it. */
const SENTENCE_WITH_A_NUMBER = `Kontakta Anna, ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}.`;

async function createPage(
  cookie: string,
  slug: string,
  blocks: unknown[] = [paragraph("Hej.")],
  visibility: "PUBLIC" | "MEMBER" = "PUBLIC",
) {
  return inject({
    method: "POST",
    url: "/api/site/pages",
    payload: { slug, title: "Om foreningen", content: { blocks }, visibility },
    headers: { cookie },
  });
}

/**
 * The same, for a test that needs the page rather than the answer.
 *
 * It insists on the 201. Reading an id out of a refusal gives `undefined`, and
 * a request to /api/site/pages/undefined/publish is answered - correctly - with
 * "there is no such page", which then reads as a broken publish route rather
 * than as a create that never happened.
 */
async function newPage(
  cookie: string,
  slug: string,
  blocks: unknown[] = [paragraph("Hej.")],
  visibility: "PUBLIC" | "MEMBER" = "PUBLIC",
): Promise<PageBody> {
  const response = await createPage(cookie, slug, blocks, visibility);
  expect(response.statusCode, `POST /api/site/pages ${slug}`).toBe(201);
  return response.json() as PageBody;
}

async function removePage(id: string): Promise<void> {
  await inject({
    method: "DELETE",
    url: `/api/site/pages/${id}`,
    headers: { cookie: boardCookie },
  });
}

function multipart(
  fields: Readonly<Record<string, string>>,
  bytes: Buffer,
  fileName: string,
  contentType: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----openbrfSiteImageBoundary";
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`,
        "utf8",
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      "utf8",
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  );

  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

let boardCookie: string;
let residentCookie: string;

beforeAll(async () => {
  const env: Env = { ...baseEnv, OPENBRF_STORAGE_DRIVER: "local" };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await registerMultipart(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);

  await prisma.person.createMany({
    data: [
      { id: boardMember.personId, firstName: "Bo", lastName: `Sida${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Sida${suffix}` },
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
      street: `Sidgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });
  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2026-01-01"),
    },
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
  residentCookie = await signIn(resident.email);
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
      "The site admin suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        () =>
          prisma.page.deleteMany({
            where: { slug: { in: Object.values(slugs) } },
          }),
        // The audit log is append-only and its entries stay, like every other
        // suite's: the record of what was published is not test litter.
        () =>
          prisma.mediaFile.deleteMany({
            where: { uploadedByPersonId: { in: personIds } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () => prisma.apartment.deleteMany({ where: { id: apartmentId } }),
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

describe("who may write the association's website", () => {
  it("is whoever holds site:manage, and nobody else", async () => {
    const refused = await createPage(residentCookie, slugs.spare);
    expect(refused.statusCode).toBe(403);

    const listed = await inject({
      method: "GET",
      url: "/api/site/pages",
      headers: { cookie: residentCookie },
    });
    expect(listed.statusCode).toBe(403);
  });

  it("is nobody at all without a session", async () => {
    const response = await inject({ method: "GET", url: "/api/site/pages" });
    expect(response.statusCode).toBe(401);
  });
});

describe("writing a page", () => {
  it("creates it unpublished, so nothing is readable before it is meant to be", async () => {
    const created = await createPage(boardCookie, slugs.public);
    expect(created.statusCode).toBe(201);

    const page = created.json() as PageBody;
    expect(page.published).toBe(false);

    // The website answers exactly as it does for an address with nothing
    // behind it.
    const visitor = await inject({ method: "GET", url: `/${slugs.public}` });
    expect(visitor.statusCode).toBe(404);
  });

  it("refuses an address the instance already serves", async () => {
    const response = await createPage(boardCookie, "api");

    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason: string }).reason).toBe("invalid-slug");
  });

  it("refuses an address another page has", async () => {
    const response = await createPage(boardCookie, slugs.public);

    expect(response.statusCode).toBe(409);
    expect((response.json() as { reason: string }).reason).toBe("slug-taken");
  });

  it("refuses a link this platform will not publish", async () => {
    const response = await createPage(boardCookie, slugs.spare, [
      {
        type: "paragraph",
        runs: [{ text: "Klicka", link: "javascript:steal()" }],
      },
    ]);

    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason: string }).reason).toBe("invalid-body");
  });

  it("refuses a block type no renderer knows", async () => {
    const response = await createPage(boardCookie, slugs.spare, [
      { type: "embed", src: "https://tracker.invalid/pixel" },
    ]);

    expect(response.statusCode).toBe(400);
  });

  it("refuses a form carrying a field no block type declares", async () => {
    // The route's own answer, not only the schema's: a field this platform has
    // no rendering for is named back as an invalid body rather than dropped on
    // the way in. What a form asks for is fixed here, so a page cannot be the
    // place it is changed.
    const response = await createPage(boardCookie, slugs.spare, [
      {
        type: "contactForm",
        fields: ["personalIdentityNumber"],
        action: "https://tracker.invalid",
      },
    ]);

    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason: string }).reason).toBe("invalid-body");
  });
});

describe("publishing a page", () => {
  it("refuses a personal identity number and says where it is", async () => {
    const page = await newPage(boardCookie, slugs.scan, [
      paragraph(SENTENCE_WITH_A_NUMBER),
    ]);

    try {
      const refused = await inject({
        method: "POST",
        url: `/api/site/pages/${page.id}/publish`,
        payload: { published: true },
        headers: { cookie: boardCookie },
      });

      expect(refused.statusCode).toBe(422);
      const body = refused.json() as {
        reason: string;
        locations: { part: string; index: number; offset?: number }[];
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
      // that must not be repeated in a response body or a log.
      expect(refused.body).not.toContain("19811218");
    } finally {
      await removePage(page.id);
    }
  });

  it("serves the page and records the publication in the audit log", async () => {
    const listed = (
      await inject({
        method: "GET",
        url: "/api/site/pages",
        headers: { cookie: boardCookie },
      })
    ).json() as PageBody[];
    const page = listed.find((one) => one.slug === slugs.public);
    expect(page).toBeDefined();

    const published = await inject({
      method: "POST",
      url: `/api/site/pages/${page?.id ?? ""}/publish`,
      payload: { published: true },
      headers: { cookie: boardCookie },
    });
    expect(published.statusCode).toBe(201);

    const visitor = await inject({ method: "GET", url: `/${slugs.public}` });
    expect(visitor.statusCode).toBe(200);
    expect(visitor.body).toContain("Hej.");
    // The website never sets a cookie, on any answer.
    expect(visitor.headers["set-cookie"]).toBeUndefined();

    const entries = await prisma.auditLogEntry.findMany({
      where: { targetKind: "page", targetId: page?.id },
      select: { action: true, actorPersonId: true },
    });
    expect(entries).toEqual([
      { action: "PAGE_PUBLISHED", actorPersonId: boardMember.personId },
    ]);
  });

  it("answers a member-only page exactly as one that does not exist", async () => {
    const page = await newPage(
      boardCookie,
      slugs.member,
      [paragraph("Endast for medlemmar.")],
      "MEMBER",
    );

    await inject({
      method: "POST",
      url: `/api/site/pages/${page.id}/publish`,
      payload: { published: true },
      headers: { cookie: boardCookie },
    });

    const [probe, nothing] = await Promise.all([
      inject({ method: "GET", url: `/${slugs.member}` }),
      inject({ method: "GET", url: `/${slugs.member}-finns-inte` }),
    ]);

    expect(probe.statusCode).toBe(404);
    // Byte for byte. The refusal is the whole of the member-only guarantee: an
    // anonymous visitor must not be able to tell the two apart.
    expect(probe.body).toBe(nothing.body);
    expect(probe.headers["set-cookie"]).toBeUndefined();

    const member = await inject({
      method: "GET",
      url: `/${slugs.member}`,
      headers: { cookie: residentCookie },
    });
    expect(member.statusCode).toBe(200);
    expect(member.body).toContain("Endast for medlemmar.");
  });

  it("records a change of visibility with both ends of it", async () => {
    const listed = (
      await inject({
        method: "GET",
        url: "/api/site/pages",
        headers: { cookie: boardCookie },
      })
    ).json() as PageBody[];
    const page = listed.find((one) => one.slug === slugs.member);

    const changed = await inject({
      method: "POST",
      url: `/api/site/pages/${page?.id ?? ""}/visibility`,
      payload: { visibility: "PUBLIC" },
      headers: { cookie: boardCookie },
    });
    expect(changed.statusCode).toBe(201);

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        targetKind: "page",
        targetId: page?.id,
        action: "PAGE_VISIBILITY_CHANGED",
      },
      select: { context: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.context).toMatchObject({ from: "MEMBER", to: "PUBLIC" });

    const visitor = await inject({ method: "GET", url: `/${slugs.member}` });
    expect(visitor.statusCode).toBe(200);
  });
});

describe("a picture on a page", () => {
  it("is refused on a published page until the consents are confirmed", async () => {
    const upload = multipart(
      { showsIdentifiablePersons: "true" },
      pngBytes(64, 48),
      "sommarfest.png",
      "image/png",
    );
    const stored = await inject({
      method: "POST",
      url: "/api/site/images",
      payload: upload.payload,
      headers: { ...upload.headers, cookie: boardCookie },
    });
    expect(stored.statusCode).toBe(201);
    const file = stored.json() as { id: string; url: string };
    expect(file.url).toBe(`/api/media/${file.id}`);

    const page = await newPage(boardCookie, slugs.picture, [
      paragraph("Sommarfesten."),
      { type: "image", mediaFileId: file.id, alt: "Garden" },
    ]);

    const refused = await inject({
      method: "POST",
      url: `/api/site/pages/${page.id}/publish`,
      payload: { published: true },
      headers: { cookie: boardCookie },
    });
    expect(refused.statusCode).toBe(422);
    expect((refused.json() as { reason: string }).reason).toBe(
      "photo-consent-required",
    );

    const confirmed = await inject({
      method: "POST",
      url: `/api/site/pages/${page.id}/publish`,
      payload: { published: true, photoConsentConfirmed: true },
      headers: { cookie: boardCookie },
    });
    expect(confirmed.statusCode).toBe(201);

    const visitor = await inject({ method: "GET", url: `/${slugs.picture}` });
    expect(visitor.statusCode).toBe(200);
    // The picture is fetched from this instance's own media route, and from
    // nowhere else.
    expect(visitor.body).toContain(`src="/api/media/${file.id}"`);
  });

  it("is refused when the instance does not hold the file", async () => {
    const page = await newPage(boardCookie, slugs.missingImage, [
      { type: "image", mediaFileId: "no-such-file", alt: "" },
    ]);

    try {
      const refused = await inject({
        method: "POST",
        url: `/api/site/pages/${page.id}/publish`,
        payload: { published: true },
        headers: { cookie: boardCookie },
      });

      // Unprocessable and not "not found": the endpoint and the page both
      // exist, and what cannot be processed is a body naming a file this
      // instance does not have. A 404 here would read as "no such page".
      expect(refused.statusCode).toBe(422);
      expect((refused.json() as { reason: string }).reason).toBe(
        "image-not-found",
      );
    } finally {
      await removePage(page.id);
    }
  });

  it("is refused when the file is not served publicly", async () => {
    /*
     * Written straight into the media table, because the website's own upload
     * route stores public files and nothing else - which is the point of it.
     * A page can still name a file uploaded elsewhere, and a published page
     * with a picture no visitor can fetch is a broken page, so the refusal is
     * asserted over HTTP rather than only against the rule.
     */
    const file = await prisma.mediaFile.create({
      data: {
        storageKey: `site-admin-internal-${suffix}`,
        contentType: "image/png",
        byteSize: 128,
        checksum: "0".repeat(64),
        fileName: "internt.png",
        visibility: "INTERNAL",
        showsIdentifiablePersons: false,
        uploadedByPersonId: boardMember.personId,
      },
      select: { id: true },
    });

    const page = await newPage(boardCookie, slugs.internalImage, [
      { type: "image", mediaFileId: file.id, alt: "" },
    ]);

    try {
      const refused = await inject({
        method: "POST",
        url: `/api/site/pages/${page.id}/publish`,
        payload: { published: true },
        headers: { cookie: boardCookie },
      });

      expect(refused.statusCode).toBe(422);
      expect((refused.json() as { reason: string }).reason).toBe(
        "image-not-public",
      );
    } finally {
      await removePage(page.id);
    }
  });
});

describe("the order the pages sit in", () => {
  it("is written from the ids the board sent", async () => {
    const listed = (
      await inject({
        method: "GET",
        url: "/api/site/pages",
        headers: { cookie: boardCookie },
      })
    ).json() as PageBody[];

    // This suite's own pages, reversed. Every other page on the instance keeps
    // whatever order it had, which is why only these ids are sent.
    const mine = listed
      .filter((one) => one.slug.includes(suffix))
      .map((one) => one.id);
    expect(mine.length).toBeGreaterThan(1);

    const response = await inject({
      method: "POST",
      url: "/api/site/pages/order",
      payload: { ids: [...mine].reverse() },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    const after = (response.json() as PageBody[])
      .filter((one) => one.slug.includes(suffix))
      .map((one) => one.id);
    expect(after).toEqual([...mine].reverse());
  });
});

describe("the preview", () => {
  it("is the website's own renderer, and writes nothing", async () => {
    const before = await prisma.page.count({
      where: { slug: { contains: suffix } },
    });

    const response = await inject({
      method: "POST",
      url: "/api/site/pages/preview",
      payload: {
        title: "Ett utkast",
        content: {
          blocks: [
            { type: "heading", level: 2, runs: [{ text: "Rubrik" }] },
            paragraph("Brodtext."),
          ],
        },
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    const { html } = response.json() as { html: string };
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h2>Rubrik</h2>");
    expect(html).toContain("<p>Brodtext.</p>");
    // The one property the preview shares with every page the website serves.
    expect(html).not.toContain("<script");

    expect(
      await prisma.page.count({ where: { slug: { contains: suffix } } }),
    ).toBe(before);
  });

  it("refuses a preview to somebody who may not write the website", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/site/pages/preview",
      payload: { title: "Ett utkast", content: { blocks: [] } },
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(403);
  });
});
