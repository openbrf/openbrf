import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * The site menu, from the board's screen to the visitor's browser.
 *
 * The unit tests pin the rules; what only this suite can show is that they are
 * the rules the routes run and the rules the rendered page obeys. The one that
 * matters most is a promise to somebody with no account: the navigation on the
 * association's website names only what they could open, so it cannot become
 * the thing that tells them a member-only page is there - the same guarantee
 * the byte-identical not-found document makes, extended to the chrome that
 * would otherwise list every address the cooperative has.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const boardMember = {
  personId: `site-menu-board-${suffix}`,
  email: `site-menu-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `site-menu-resident-${suffix}`,
  email: `site-menu-resident-${suffix}@exempel.se`,
};
const actors = [boardMember, resident];
const personIds = actors.map((actor) => actor.personId);

const addressId = `site-menu-address-${suffix}`;
const apartmentId = `site-menu-apartment-${suffix}`;

const slugs = {
  home: `site-menu-home-${suffix}`,
  member: `site-menu-member-${suffix}`,
  draft: `site-menu-draft-${suffix}`,
  child: `site-menu-child-${suffix}`,
};

const titles = {
  home: `Framsidan ${suffix}`,
  member: `Endast medlemmar ${suffix}`,
  draft: `Utkastet ${suffix}`,
  child: `Stadgarna ${suffix}`,
};

const pageIds = {
  home: `site-menu-page-home-${suffix}`,
  member: `site-menu-page-member-${suffix}`,
  draft: `site-menu-page-draft-${suffix}`,
  child: `site-menu-page-child-${suffix}`,
};

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.15.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.15.${String(subnet)}.${String(host + 1)}`;
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
        // Fixed, so two responses compared for equality were rendered in the
        // same language and differ only where the test says they do.
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

interface MenuItemBody {
  id: string;
  label: string;
  kind: "PAGE" | "GENERATED" | "EXTERNAL";
  parentId: string | null;
  sortOrder: number;
  pageId: string | null;
  generatedKey: string | null;
  url: string | null;
}

/** Every entry this suite wrote, so the cleanup can find them again. */
const written: string[] = [];

async function addEntry(
  cookie: string,
  payload: object,
): Promise<MenuItemBody> {
  const response = await inject({
    method: "POST",
    url: "/api/site/menu",
    payload,
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = JSON.parse(response.body) as MenuItemBody;
  written.push(body.id);
  return body;
}

/** Empties the menu, so each test arranges the one it is about. */
async function clearMenu(): Promise<void> {
  await prisma.menuItem.deleteMany({ where: { id: { in: written } } });
  written.length = 0;
}

let boardCookie: string;
let residentCookie: string;

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

  // A claimed instance: the root redirects an unclaimed one to the wizard.
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
      { id: boardMember.personId, firstName: "Bo", lastName: `Meny${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Meny${suffix}` },
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
      street: `Menygatan ${suffix}`,
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

  await prisma.page.createMany({
    data: [
      {
        id: pageIds.home,
        slug: slugs.home,
        title: titles.home,
        content: {
          version: 1,
          blocks: [{ type: "paragraph", runs: [{ text: "Välkommen." }] }],
        },
        visibility: "PUBLIC",
        published: true,
        publishedAt: new Date(),
        sortOrder: 0,
      },
      {
        id: pageIds.member,
        slug: slugs.member,
        title: titles.member,
        content: {
          version: 1,
          blocks: [
            { type: "paragraph", runs: [{ text: "Endast medlemmar." }] },
          ],
        },
        visibility: "MEMBER",
        published: true,
        publishedAt: new Date(),
        sortOrder: 1,
      },
      {
        id: pageIds.draft,
        slug: slugs.draft,
        title: titles.draft,
        content: { version: 1, blocks: [] },
        visibility: "PUBLIC",
        published: false,
        sortOrder: 2,
      },
      {
        id: pageIds.child,
        slug: slugs.child,
        title: titles.child,
        content: {
          version: 1,
          blocks: [{ type: "paragraph", runs: [{ text: "Stadgarna." }] }],
        },
        visibility: "PUBLIC",
        published: true,
        publishedAt: new Date(),
        sortOrder: 3,
      },
    ],
  });

  boardCookie = await signIn(boardMember.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

/*
 * Each test arranges the menu it is about, so each test hands it back - here
 * rather than at the end of the test body, because a test that fails leaves
 * its entries behind and the tests after it then read a menu they did not
 * arrange. One broken rule would be reported as several.
 */
afterEach(async () => {
  await clearMenu();
});

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await clearMenu();
      await prisma.page.deleteMany({
        where: { id: { in: Object.values(pageIds) } },
      });
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.account.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await app?.close();
  }
});

describe("who may arrange the menu", () => {
  it("is whoever holds site:manage, and nobody else", async () => {
    const listed = await inject({
      method: "GET",
      url: "/api/site/menu",
      headers: { cookie: residentCookie },
    });
    expect(listed.statusCode).toBe(403);

    const added = await inject({
      method: "POST",
      url: "/api/site/menu",
      payload: { kind: "PAGE", pageId: pageIds.home },
      headers: { cookie: residentCookie },
    });
    expect(added.statusCode).toBe(403);
  });

  it("needs a session at all", async () => {
    const response = await inject({ method: "GET", url: "/api/site/menu" });
    expect(response.statusCode).toBe(401);
  });
});

describe("arranging the menu", () => {
  it("names an entry after the page unless the board says otherwise", async () => {
    const entry = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.home,
    });

    expect(entry.label).toBe(titles.home);
    expect(entry.parentId).toBeNull();
  });

  it("refuses a third level", async () => {
    const top = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.home,
    });
    const second = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.member,
      parentId: top.id,
    });

    const refused = await inject({
      method: "POST",
      url: "/api/site/menu",
      payload: {
        kind: "PAGE",
        pageId: pageIds.draft,
        parentId: second.id,
      },
      headers: { cookie: boardCookie },
    });

    expect(refused.statusCode).toBe(422);
    expect(JSON.parse(refused.body)).toMatchObject({
      reason: "nesting-too-deep",
    });
  });

  it("refuses an address that is not https", async () => {
    const refused = await inject({
      method: "POST",
      url: "/api/site/menu",
      payload: {
        kind: "EXTERNAL",
        label: "Osäker",
        url: "http://exempel.invalid",
      },
      headers: { cookie: boardCookie },
    });

    expect(refused.statusCode).toBe(422);
    expect(JSON.parse(refused.body)).toMatchObject({ reason: "invalid-url" });
  });

  it("puts one level in the order it is told, and reads it back so", async () => {
    const first = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.home,
    });
    const second = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.member,
    });

    const reordered = await inject({
      method: "POST",
      url: "/api/site/menu/order",
      payload: { parentId: null, ids: [second.id, first.id] },
      headers: { cookie: boardCookie },
    });
    expect(reordered.statusCode).toBe(201);

    const listed = await inject({
      method: "GET",
      url: "/api/site/menu",
      headers: { cookie: boardCookie },
    });
    const menu = (JSON.parse(listed.body) as MenuItemBody[]).filter((entry) =>
      written.includes(entry.id),
    );
    expect(menu.map((entry) => entry.id)).toEqual([second.id, first.id]);
  });

  it("takes an entry's children away with it", async () => {
    const top = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.home,
    });
    const child = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.member,
      parentId: top.id,
    });

    const removed = await inject({
      method: "DELETE",
      url: `/api/site/menu/${top.id}`,
      headers: { cookie: boardCookie },
    });
    expect(removed.statusCode).toBe(200);

    expect(await prisma.menuItem.count({ where: { id: child.id } })).toBe(0);
  });

  it("takes an entry away with the page it points at", async () => {
    // The cascade is the database's, and it is what keeps the menu from ever
    // naming an address that answers with the not-found document.
    const spareId = `site-menu-spare-${suffix}`;
    await prisma.page.create({
      data: {
        id: spareId,
        slug: `site-menu-spare-${suffix}`,
        title: "Tillfällig",
        content: { version: 1, blocks: [] },
        visibility: "PUBLIC",
        published: true,
        sortOrder: 9,
      },
    });
    const entry = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: spareId,
    });

    await prisma.page.delete({ where: { id: spareId } });

    expect(await prisma.menuItem.count({ where: { id: entry.id } })).toBe(0);
  });
});

describe("the menu a visitor is served", () => {
  it("names only what they could open", async () => {
    await addEntry(boardCookie, { kind: "PAGE", pageId: pageIds.home });
    await addEntry(boardCookie, { kind: "PAGE", pageId: pageIds.member });
    await addEntry(boardCookie, { kind: "PAGE", pageId: pageIds.draft });

    const anonymous = await inject({
      method: "GET",
      url: `/${slugs.home}`,
    });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.body).toContain(`href="/${slugs.home}"`);
    // The two that matter. An anonymous visitor learns nothing about the
    // member-only page, and a draft is not on anybody's website.
    expect(anonymous.body).not.toContain(slugs.member);
    expect(anonymous.body).not.toContain(titles.member);
    expect(anonymous.body).not.toContain(slugs.draft);

    const member = await inject({
      method: "GET",
      url: `/${slugs.home}`,
      headers: { cookie: residentCookie },
    });
    expect(member.statusCode).toBe(200);
    expect(member.body).toContain(`href="/${slugs.member}"`);
    expect(member.body).toContain(titles.member);
    expect(member.body).not.toContain(slugs.draft);
  });

  it("hangs a second level under its parent, in the served document", async () => {
    /*
     * The one shape no other test here reaches: a rendered dropdown. The unit
     * tests prove the read model returns children and the renderer prints
     * them; this is the only place the two meet over a real menu, and without
     * it a second level that never arrived would look exactly like one the
     * stylesheet had merely folded away.
     */
    const parent = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.home,
    });
    await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.child,
      parentId: parent.id,
    });

    const response = await inject({ method: "GET", url: `/${slugs.home}` });

    expect(response.statusCode).toBe(200);
    // The group, the nested list and the entry itself. The dropdown is closed
    // by the stylesheet rather than by leaving the entry out, which is what
    // lets focus open it without a script.
    expect(response.body).toContain('class="site-nav-group"');
    expect(response.body).toContain('<ul class="site-nav-children">');
    expect(response.body).toContain(`href="/${slugs.child}"`);
    expect(response.body).toContain(titles.child);
  });

  it("leaves out a generated page whose feature this instance has not got", async () => {
    await addEntry(boardCookie, {
      kind: "GENERATED",
      label: `Mäklarinfo ${suffix}`,
      generatedKey: "broker",
    });

    const response = await inject({ method: "GET", url: `/${slugs.home}` });
    expect(response.body).not.toContain(`Mäklarinfo ${suffix}`);
  });

  it("offers the news index, which this instance serves", async () => {
    const label = `Nyheter ${suffix}`;
    await addEntry(boardCookie, {
      kind: "GENERATED",
      label,
      generatedKey: "news",
    });

    const response = await inject({ method: "GET", url: `/${slugs.home}` });
    expect(response.body).toContain(label);
    expect(response.body).toContain('href="/nyheter"');
  });

  it("offers the account request form only while the board takes requests", async () => {
    const association = await prisma.association.findUnique({
      where: { id: 1 },
      select: { selfSignupEnabled: true },
    });
    const label = `Ansök om konto ${suffix}`;

    try {
      await addEntry(boardCookie, {
        kind: "GENERATED",
        label,
        generatedKey: "requestAccount",
      });

      await prisma.association.update({
        where: { id: 1 },
        data: { selfSignupEnabled: false },
      });
      const closed = await inject({ method: "GET", url: `/${slugs.home}` });
      expect(closed.body).not.toContain(label);

      await prisma.association.update({
        where: { id: 1 },
        data: { selfSignupEnabled: true },
      });
      const open = await inject({ method: "GET", url: `/${slugs.home}` });
      expect(open.body).toContain(label);
      expect(open.body).toContain('href="/app/request-account"');

      // Somebody already signed in is sent away from that screen, so the entry
      // would be a link that bounces whoever followed it.
      const signedIn = await inject({
        method: "GET",
        url: `/${slugs.home}`,
        headers: { cookie: residentCookie },
      });
      expect(signedIn.body).not.toContain(label);
    } finally {
      await prisma.association.update({
        where: { id: 1 },
        data: {
          selfSignupEnabled: association?.selfSignupEnabled ?? false,
        },
      });
    }
  });

  it("carries an external entry as a text anchor and nothing else", async () => {
    const label = `Boverket ${suffix}`;
    await addEntry(boardCookie, {
      kind: "EXTERNAL",
      label,
      url: "https://boverket.invalid/bostadsratt",
    });

    const response = await inject({ method: "GET", url: `/${slugs.home}` });

    expect(response.body).toContain(
      '<a href="https://boverket.invalid/bostadsratt" rel="noopener noreferrer">',
    );
    // A navigation the reader chooses to follow, never a subresource: nothing
    // is fetched from the other host while the page is being read.
    expect(/src="https?:/i.test(response.body)).toBe(false);
    expect(/<link[^>]+https?:/i.test(response.body)).toBe(false);
    expect(response.body.includes("<script")).toBe(false);
  });
});

describe("the front page the menu names", () => {
  it("is its first page entry, whatever order the pages sit in", async () => {
    const entry = await addEntry(boardCookie, {
      kind: "PAGE",
      pageId: pageIds.home,
    });
    /*
     * Put first outright. A new entry goes to the end of its level, and the
     * database this suite runs against may already hold a menu - the one the
     * menu migration backfilled from whatever pages were there, and whatever
     * a run that did not finish left behind. What is under test is which entry
     * the root follows, not which entries exist, so the entry is moved below
     * whatever the top level holds now rather than to a position assumed to be
     * nobody's: a fixed one is only free until a second suite wants it too.
     */
    const lowest = await prisma.menuItem.aggregate({
      where: { parentId: null },
      _min: { sortOrder: true },
    });
    await prisma.menuItem.update({
      where: { id: entry.id },
      data: { sortOrder: (lowest._min.sortOrder ?? 0) - 1 },
    });

    const root = await inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain(titles.home);
  });
});

describe("what a page nobody may read looks like, with a menu on the site", () => {
  it("is still byte-identical to a page that was never written", async () => {
    await addEntry(boardCookie, { kind: "PAGE", pageId: pageIds.home });
    await addEntry(boardCookie, { kind: "PAGE", pageId: pageIds.member });

    const closed = await inject({ method: "GET", url: `/${slugs.member}` });
    const missing = await inject({
      method: "GET",
      url: `/en-sida-som-aldrig-skrivits-${suffix}`,
    });

    expect(closed.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // The whole guarantee, and the menu is the part of the chrome that could
    // most easily have broken it: the refusal is one document for everybody.
    expect(closed.body).toBe(missing.body);
    expect(closed.body).not.toContain(titles.member);

    // And the same for a visitor who does carry a session: the not-found
    // document does not change with who asked for it.
    const asMember = await inject({
      method: "GET",
      url: `/en-sida-som-aldrig-skrivits-${suffix}`,
      headers: { cookie: residentCookie },
    });
    expect(asMember.body).toBe(missing.body);
    expect(asMember.headers["set-cookie"]).toBeUndefined();
  });
});
