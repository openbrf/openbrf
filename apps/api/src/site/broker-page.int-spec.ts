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
import type { AssociationFactsInput } from "./association-facts.service";
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

/**
 * The association row is the most shared state in the database.
 *
 * One instance serves one association and a check constraint pins its row to
 * id 1, so every suite in a run reads the same one. What this suite needs from
 * it is small: a name and an organisation number to find on the page, a known
 * default language, and a completed setup so the route answers at all. It
 * therefore takes the name and the number as it finds them instead of writing
 * its own, writes only the fields it cannot work without, and puts every one of
 * them back afterwards. An earlier version renamed the association and walked
 * away, which failed site.int-spec.ts's front page two files later in the same
 * run - a suite that passes on its own and fails in company.
 */
const ASSOCIATION_COLUMNS = {
  name: true,
  organizationNumber: true,
  defaultLocale: true,
  setupCompletedAt: true,
} as const;

type AssociationSlice = {
  name: string;
  organizationNumber: string | null;
  defaultLocale: string;
  setupCompletedAt: Date | null;
};

/**
 * The name a fresh instance would carry anyway.
 *
 * Only reached when this suite is the first thing in a run to need an
 * association at all, in which case it creates the row and deletes it again -
 * so this name never outlives the suite. It matches the shared fixture's so
 * that even a failed teardown leaves the database in the state the other
 * suites expect rather than in one of this suite's invention.
 */
const FALLBACK_NAME = "Brf Eksemplet";

/** The association's own, and public: it is printed in the annual report. */
const FALLBACK_ORGANIZATION_NUMBER = "769600-0000";

/** Read off the row in beforeAll rather than written into it. */
let associationName: string;
let organizationNumber: string;

/** What was there before this suite touched anything, and how to put it back. */
let associationBefore: AssociationSlice | null = null;
let associationCreated = false;
let factsBefore: Record<string, unknown> | null = null;
let factsCreated = false;

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

/**
 * Every fact back to unrecorded, so one test cannot decide another's page.
 *
 * Typed against the service's own input shape and required rather than partial,
 * so a fact added later fails to compile here until it is added to the reset -
 * which is also the list the capture and the restore below are derived from.
 */
const NOTHING_RECORDED: Required<AssociationFactsInput> = {
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

/**
 * The fact columns, as a select.
 *
 * Derived from the reset above rather than written out a second time, so a
 * fact added later is captured and restored without anybody remembering to
 * extend a second list.
 */
const FACT_COLUMNS = Object.fromEntries(
  Object.keys(NOTHING_RECORDED).map((column) => [column, true]),
);

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

  associationBefore = await prisma.association.findUnique({
    where: { id: 1 },
    select: ASSOCIATION_COLUMNS,
  });

  if (associationBefore === null) {
    // Nothing to preserve: this suite is the first thing in the run to need an
    // association, so it makes one and removes it again below.
    associationCreated = true;
    await prisma.association.create({
      data: {
        id: 1,
        name: FALLBACK_NAME,
        organizationNumber: FALLBACK_ORGANIZATION_NUMBER,
        defaultLocale: "sv",
        setupCompletedAt: new Date(),
      },
    });
  } else {
    await prisma.association.update({
      where: { id: 1 },
      data: {
        /*
         * Never the name. The suite asserts on whatever the association is
         * called, so it has no use for one of its own - and writing one is
         * precisely what leaked out of this file and into a later suite.
         *
         * The language is the one field it cannot take as it finds it: every
         * assertion below reads a Swedish label, and the point of one of them
         * is that the page ignores what the visitor asked for. The other two
         * are filled in only when they are empty, because a page carrying no
         * organisation number, and an instance that still reads as unclaimed,
         * would each leave an assertion below with nothing to check.
         */
        defaultLocale: "sv",
        organizationNumber:
          associationBefore.organizationNumber ?? FALLBACK_ORGANIZATION_NUMBER,
        setupCompletedAt: associationBefore.setupCompletedAt ?? new Date(),
      },
    });
  }

  const association = await prisma.association.findUniqueOrThrow({
    where: { id: 1 },
    select: ASSOCIATION_COLUMNS,
  });
  associationName = association.name;
  organizationNumber =
    association.organizationNumber ?? FALLBACK_ORGANIZATION_NUMBER;

  // The facts row is a singleton too, and this suite is about writing it.
  factsBefore = await prisma.associationFacts.findUnique({
    where: { id: 1 },
    select: FACT_COLUMNS,
  });
  factsCreated = factsBefore === null;

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

/**
 * Runs every step, whatever any one of them does.
 *
 * A sequence of awaits stops at the first rejection, so one failing delete
 * leaves everything after it in the database - and what this suite leaves
 * behind is read by other suites rather than by this one, which is how the
 * failure ends up being reported against somebody else's test.
 */
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
      "The broker page suite could not put the instance back as it found it.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        // The two singletons first: they are what a later suite reads.
        () =>
          factsCreated
            ? prisma.associationFacts.deleteMany({ where: { id: 1 } })
            : prisma.associationFacts.update({
                where: { id: 1 },
                data: factsBefore ?? NOTHING_RECORDED,
              }),
        () =>
          associationCreated || associationBefore === null
            ? prisma.association.deleteMany({ where: { id: 1 } })
            : prisma.association.update({
                where: { id: 1 },
                // Field for field as it was found, rather than as this suite
                // would like it: the name the fixture chose stays the name the
                // next suite reads.
                data: associationBefore,
              }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.apartment.deleteMany({
            where: { id: { in: [firstApartmentId, secondApartmentId] } },
          }),
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

describe("the page an association has before it has recorded anything", () => {
  it("answers with its name and its organisation number", async () => {
    await saveFacts(boardCookie, NOTHING_RECORDED);

    const response = await inject({ method: "GET", url: "/maklarinfo" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(associationName);
    expect(response.body).toContain(organizationNumber);
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
    const body = response.body.replaceAll(organizationNumber, "");
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
