import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * The broker information page, through the real routing, guard and filter.
 *
 * A housing cooperative answers a broker out of what its board has recorded and
 * out of nothing else. That sentence is the feature, and three things have to
 * be true for it to hold: the page serves the recorded facts, it omits every
 * fact nobody recorded, and the code that renders it has no way to reach the
 * statutory registers at all. The last one is asserted on the source rather
 * than on a rendered page, because a rendering test can only show that today's
 * facts carry nothing personal - the import boundary is what shows tomorrow's
 * cannot.
 *
 * The page also exists before the board has recorded anything, and that is
 * deliberate rather than incidental: an address that starts answering only once
 * somebody saves a form is an address a broker was told did not exist, and they
 * have no reason to try it twice.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const ORGANIZATION_NUMBER = "769600-0000";
const ASSOCIATION_NAME = "Brf Maklarprovet";

const boardMember = {
  personId: `broker-board-${suffix}`,
  email: `broker-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `broker-resident-${suffix}`,
  email: `broker-resident-${suffix}@exempel.se`,
};
const personIds = [boardMember.personId, resident.personId];

const addressId = `broker-address-${suffix}`;
const firstApartmentId = `broker-apartment-a-${suffix}`;
const secondApartmentId = `broker-apartment-b-${suffix}`;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.15.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.15.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT";
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
        // English, deliberately. The broker page answers in the association's
        // own language whatever the visitor asks for, and a suite that asked in
        // Swedish could not tell the two apart.
        "accept-language": "en-GB,en;q=0.9",
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

function saveFacts(cookie: string, facts: object) {
  return inject({
    method: "PUT",
    url: "/api/site/facts",
    payload: facts,
    headers: { cookie },
  });
}

/** Every fact back to unrecorded, so one test cannot decide another's page. */
const NOTHING_RECORDED = {
  propertyDesignation: null,
  buildYear: null,
  landLeasehold: null,
  landLeaseholdNote: null,
  feePolicy: null,
  feeIncludes: null,
  transferFeePolicy: null,
  pledgeFeePolicy: null,
  legalPersonOwners: null,
  legalPersonOwnersNote: null,
  parking: null,
  storage: null,
  renovations: null,
};

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

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: ASSOCIATION_NAME,
      organizationNumber: ORGANIZATION_NUMBER,
      // Swedish, so the page's own language can be told from the visitor's.
      defaultLocale: "sv",
      setupCompletedAt: new Date(),
    },
    update: {
      name: ASSOCIATION_NAME,
      organizationNumber: ORGANIZATION_NUMBER,
      defaultLocale: "sv",
      setupCompletedAt: new Date(),
    },
  });

  await prisma.person.createMany({
    data: [
      { id: boardMember.personId, firstName: "Bo", lastName: `Makl${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Makl${suffix}` },
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
      street: `Maklargatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: [
          { id: firstApartmentId, number: "1001", floor: 0 },
          { id: secondApartmentId, number: "1002", floor: 0 },
        ],
      },
    },
  });
  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId: firstApartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2026-01-01"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [boardMember, resident]) {
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

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      // The facts row is the instance's own single row, so it is emptied rather
      // than deleted: another suite may have been looking at it.
      await prisma.associationFacts
        .updateMany({ where: { id: 1 }, data: NOTHING_RECORDED })
        .catch(() => undefined);
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.apartment.deleteMany({
        where: { id: { in: [firstApartmentId, secondApartmentId] } },
      });
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

describe("the page an association has before it has recorded anything", () => {
  it("answers with its name and its organisation number", async () => {
    await saveFacts(boardCookie, NOTHING_RECORDED);

    const response = await inject({ method: "GET", url: "/maklarinfo" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(ASSOCIATION_NAME);
    expect(response.body).toContain(ORGANIZATION_NUMBER);
  });

  it("raises none of the questions the board has not answered", async () => {
    await saveFacts(boardCookie, NOTHING_RECORDED);

    const response = await inject({ method: "GET", url: "/maklarinfo" });

    // No label, no dash, no "not recorded": the person reading this page has no
    // way to fill the gap in, so naming it is worse than leaving it out.
    for (const label of [
      "Fastighetsbeteckning",
      "Byggår",
      "Avgiften",
      "Överlåtelseavgift",
      "Pantsättningsavgift",
    ]) {
      expect(response.body, label).not.toContain(label);
    }
  });

  it("counts the apartments rather than listing them", async () => {
    // Against the live count rather than against this suite's two: the local
    // database is shared, and a hard number would make this test about which
    // other suite ran first.
    const total = await prisma.apartment.count();
    expect(total).toBeGreaterThanOrEqual(2);

    const response = await inject({ method: "GET", url: "/maklarinfo" });

    expect(response.body).toContain("Antal lägenheter");
    expect(response.body).toContain(`<dd><p>${String(total)}</p></dd>`);
    // The count is the whole of what this page takes from the register's side
    // of the line. An apartment number on it would be the line crossed.
    expect(response.body).not.toContain("1001");
    expect(response.body).not.toContain("1002");
  });

  it("answers at the English address with the same document", async () => {
    const swedish = await inject({ method: "GET", url: "/maklarinfo" });
    const english = await inject({ method: "GET", url: "/broker" });

    expect(english.statusCode).toBe(200);
    expect(english.body).toBe(swedish.body);
  });

  it("cannot be claimed by a page written at either address", async () => {
    for (const slug of ["maklarinfo", "broker"]) {
      const refused = await inject({
        method: "POST",
        url: "/api/site/pages",
        payload: {
          slug,
          title: "Egen sida",
          content: { blocks: [] },
          visibility: "PUBLIC",
        },
        headers: { cookie: boardCookie },
      });
      expect(refused.statusCode, slug).toBe(400);
      expect(refused.json(), slug).toMatchObject({ reason: "invalid-slug" });
    }
  });
});

describe("the facts the board records", () => {
  it("are on the page, and are the whole of what is on it", async () => {
    const saved = await saveFacts(boardCookie, {
      ...NOTHING_RECORDED,
      propertyDesignation: "Talgoxen 4",
      buildYear: 1948,
      landLeasehold: false,
      feeIncludes: "Värme, vatten och bredband.",
      transferFeePolicy: "2,5 % av prisbasbeloppet, betalas av köparen.",
      legalPersonOwners: false,
      renovations: "Stammar 2019\nFasad 2023",
    });
    expect(saved.statusCode).toBe(200);

    const response = await inject({ method: "GET", url: "/maklarinfo" });

    expect(response.body).toContain("Talgoxen 4");
    expect(response.body).toContain("1948");
    expect(response.body).toContain("Föreningen äger marken");
    expect(response.body).toContain("Värme, vatten och bredband.");
    expect(response.body).toContain("2,5 % av prisbasbeloppet");
    expect(response.body).toContain("Godkänns inte");
    // The line breaks the board typed are the only structure the text has.
    expect(response.body).toContain("<p>Stammar 2019</p>");
    expect(response.body).toContain("<p>Fasad 2023</p>");
    // Still nothing about a fact left unanswered.
    expect(response.body).not.toContain("Villkor för tomträtten");
  });

  it("come off the page again when the board clears them", async () => {
    await saveFacts(boardCookie, { parking: "Tolv platser i garaget." });
    expect(
      (await inject({ method: "GET", url: "/maklarinfo" })).body,
    ).toContain("Tolv platser i garaget.");

    await saveFacts(boardCookie, { parking: "" });

    const response = await inject({ method: "GET", url: "/maklarinfo" });
    expect(response.body).not.toContain("Tolv platser i garaget.");
    expect(response.body).not.toContain("Parkering");
  });

  it("are written in the association's own language, not the visitor's", async () => {
    // The visitor asked in English; the association keeps its site in Swedish
    // and its facts are stored as the board wrote them. A Swedish answer under
    // an English question would be a document whose lang attribute is wrong
    // about half of it.
    const response = await inject({
      method: "GET",
      url: "/maklarinfo",
      headers: { "accept-language": "en-GB,en;q=0.9" },
    });

    expect(response.body).toContain('<html lang="sv">');
    expect(response.body).toContain("Mäklarinformation");
    expect(response.body).not.toContain("Broker information");
  });
});

describe("who may record them", () => {
  it("is whoever holds site:manage, and nobody else", async () => {
    const refused = await saveFacts(residentCookie, {
      propertyDesignation: "Talgoxen 4",
    });
    expect(refused.statusCode).toBe(403);

    const read = await inject({
      method: "GET",
      url: "/api/site/facts",
      headers: { cookie: residentCookie },
    });
    expect(read.statusCode).toBe(403);
  });

  it("is nobody at all without a session", async () => {
    // There is no public read of the facts and there must not be one: the only
    // way they leave this instance is as the rendered page.
    const anonymous = await inject({ method: "GET", url: "/api/site/facts" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("is refused a personal identity number, as a page would be", async () => {
    const refused = await saveFacts(boardCookie, {
      renovations: "Stammar 2019, fråga 19811218-9876.",
    });

    expect(refused.statusCode).toBe(422);
    const body = refused.json() as {
      reason: string;
      locations: { field: string; offset: number }[];
    };
    expect(body.reason).toBe("personal-identity-number");
    expect(body.locations[0]?.field).toBe("renovations");
    // The refusal says where, never what. The value is the disclosure.
    expect(refused.body).not.toContain("9876");

    const page = await inject({ method: "GET", url: "/maklarinfo" });
    expect(page.body).not.toContain("9876");
  });
});

describe("what the page promises whoever reads it", () => {
  it("sets no cookie and runs no script", async () => {
    const response = await inject({ method: "GET", url: "/maklarinfo" });

    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(response.body.includes("<script")).toBe(false);
    expect(/\son[a-z]+=/i.test(response.body)).toBe(false);
  });

  it("puts no personal identity number on the page it serves", async () => {
    const response = await inject({ method: "GET", url: "/maklarinfo" });

    // The shape rather than a value, so the assertion fails for any personal
    // identity number and not only one this suite wrote. The organisation
    // number is lawful here, is printed on the page on purpose, and has the
    // same shape, so it is removed first.
    const body = response.body.replaceAll(ORGANIZATION_NUMBER, "");
    expect(/\b(?:19|20)?\d{6}[-+]?\d{4}\b/.test(body)).toBe(false);
  });
});

describe("the boundary the page rests on", () => {
  it("gives the broker rendering path no import of the registers", () => {
    /*
     * site-boundary.spec.ts asserts this over the whole directory, which is the
     * right shape for the rule and the wrong shape for this page: it holds only
     * while every file that renders the page happens to live in src/site. This
     * names the files the broker route actually runs through, so moving one of
     * them out of the directory fails here instead of quietly leaving the rule
     * asserted over a set that no longer contains it.
     *
     * A broker asks questions the registers could answer - who owns which
     * apartment, what the share capital is, what a lien note says - and the
     * reason this page cannot answer them is that there is no path from this
     * code to the data, not that nobody has written the query yet.
     */
    const forbidden = ["registers", "address-book", "crypto"];
    const path = (name: string): string =>
      join(process.cwd(), "src", "site", name);

    const brokerPath = [
      "site-broker.tsx",
      "site-renderer.service.ts",
      "site.controller.ts",
      "association-facts.service.ts",
      "association-facts.controller.ts",
      "site-html.tsx",
    ];

    const offenders: string[] = [];
    for (const name of brokerPath) {
      const source = readFileSync(path(name), "utf8");
      for (const module of forbidden) {
        if (
          source.includes(`"../${module}/`) ||
          source.includes(`'../${module}/`)
        ) {
          offenders.push(`${name} -> ${module}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
