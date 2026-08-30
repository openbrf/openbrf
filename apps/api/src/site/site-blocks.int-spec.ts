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
 * The four insertable data blocks, against a real database, through the real
 * routing.
 *
 * The unit tests hold what each block renders when it is handed a list; this
 * suite holds who gets which list, which is the part no rendering test can
 * show. Every assertion here is a promise about disclosure:
 *
 *   A document list on a page anybody can open lists the public shelf to a
 *   visitor with no account, the members' shelf as well to a member, and the
 *   board's shelf to nobody at all. A resident who is not a member gets the
 *   public shelf, because the archive's audiences are not the same question as
 *   "is this person signed in" - the page they are reading is, and the two must
 *   not be confused.
 *
 *   A board roster names the people who have given a publication consent for
 *   exactly that, and nobody else. Not the board member who has never been
 *   asked, and not the one carrying protected personal data whatever they said.
 *
 * The same page is fetched as four different readers, so every one of these is
 * an assertion about one stored body rendered against four sessions - which is
 * the shape the whole design rests on: the page does not know who is reading
 * it.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const member = {
  personId: `blocks-member-${suffix}`,
  email: `blocks-member-${suffix}@exempel.se`,
};
const resident = {
  personId: `blocks-resident-${suffix}`,
  email: `blocks-resident-${suffix}@exempel.se`,
};
const boardMember = {
  personId: `blocks-board-${suffix}`,
  email: `blocks-board-${suffix}@exempel.se`,
};
/** On the board, consented, and the one name the roster may publish. */
const CONSENTED_SURNAME = `Consented${suffix}`;
/** On the board and never asked. */
const silent = { personId: `blocks-silent-${suffix}` };
const SILENT_SURNAME = `Silent${suffix}`;
/** On the board, consented, and carrying protected personal data. */
const protectedPerson = { personId: `blocks-protected-${suffix}` };
const PROTECTED_SURNAME = `Protected${suffix}`;

const personIds = [
  member.personId,
  resident.personId,
  boardMember.personId,
  silent.personId,
  protectedPerson.personId,
];

const addressId = `blocks-address-${suffix}`;
const apartmentId = `blocks-apartment-${suffix}`;
const pageSlug = `blocks-${suffix}`;

const PUBLIC_DOCUMENT = `Stadgar ${suffix}`;
const MEMBER_DOCUMENT = `Protokoll ${suffix}`;
const BOARD_DOCUMENT = `Styrelsens underlag ${suffix}`;
const BINDER = `Handlingar ${suffix}`;
const FAQ_QUESTION = `Var finns tvättstugan ${suffix}?`;
const FAQ_ANSWER = `I källaren ${suffix}.`;

const mediaFileIds = [0, 1, 2].map((at) => `blocks-file-${at}-${suffix}`);

/**
 * A distinct forwarded address per request, inside this suite's own block.
 *
 * The auth rate limiter buckets by forwarded address, so a repeat would make
 * one suite's requests count against another's budget. 10.24.0.0/16 is this
 * suite's; the other integration suites each hold their own second octet.
 */
let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return `10.24.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
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

/** The page, as one reader gets it. No cookie at all is a visitor. */
async function pageAs(cookie?: string): Promise<string> {
  const response = await inject({
    method: "GET",
    url: `/${pageSlug}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  expect(response.statusCode).toBe(200);
  return response.body;
}

/**
 * A document in the archive, with its file.
 *
 * Written straight to the database rather than uploaded, because what this
 * suite is about is who the archive lists a document to - the upload path and
 * the transaction that keeps a document's audience and its file's visibility in
 * step are held by the archive's own suite. The visibility is set here to what
 * the archive would have set, so the two records agree exactly as they would.
 */
async function fileDocument(input: {
  mediaFileId: string;
  title: string;
  audience: "PUBLIC" | "MEMBER" | "BOARD";
  visibility: "PUBLIC" | "MEMBER" | "INTERNAL";
  requiredCapability: string | null;
}): Promise<void> {
  await prisma.mediaFile.create({
    data: {
      id: input.mediaFileId,
      storageKey: `documents/${input.mediaFileId}.pdf`,
      contentType: "application/pdf",
      byteSize: 1024,
      checksum: input.mediaFileId,
      fileName: `${input.mediaFileId}.pdf`,
      visibility: input.visibility,
      requiredCapability: input.requiredCapability,
      document: {
        create: {
          title: input.title,
          category: BINDER,
          audience: input.audience,
        },
      },
    },
  });
}

let memberCookie: string;
let residentCookie: string;
let boardCookie: string;

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
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  await prisma.person.createMany({
    data: [
      { id: member.personId, firstName: "Maja", lastName: `Block${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Block${suffix}` },
      {
        id: boardMember.personId,
        firstName: "Bo",
        lastName: CONSENTED_SURNAME,
      },
      { id: silent.personId, firstName: "Sten", lastName: SILENT_SURNAME },
      {
        id: protectedPerson.personId,
        firstName: "Pia",
        lastName: PROTECTED_SURNAME,
        protectedPersonalData: true,
      },
    ],
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Blockgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: member.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
      // A resident who is not a member. The distinction the archive draws and
      // the one this suite exists to hold the website to.
      {
        personId: resident.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2026-01-01"),
      },
    ],
  });

  await prisma.boardPosition.createMany({
    data: [
      {
        personId: boardMember.personId,
        position: "CHAIR",
        electedOn: new Date("2026-01-01"),
      },
      {
        personId: silent.personId,
        position: "BOARD_MEMBER",
        electedOn: new Date("2026-01-01"),
      },
      {
        personId: protectedPerson.personId,
        position: "BOARD_MEMBER",
        electedOn: new Date("2026-01-01"),
      },
    ],
  });
  await prisma.publicationConsent.createMany({
    data: [
      {
        personId: boardMember.personId,
        scope: "BOARD_ROSTER",
        grantedAt: new Date("2026-01-02"),
      },
      // Consented, and still not published: protected personal data is not a
      // decision the person carries.
      {
        personId: protectedPerson.personId,
        scope: "BOARD_ROSTER",
        grantedAt: new Date("2026-01-02"),
      },
      // A consent for another scope on the person who has not given this one.
      // Agreeing to a photograph is not agreeing to the roster.
      {
        personId: silent.personId,
        scope: "PHOTO",
        grantedAt: new Date("2026-01-02"),
      },
    ],
  });

  await fileDocument({
    mediaFileId: mediaFileIds[0] ?? "",
    title: PUBLIC_DOCUMENT,
    audience: "PUBLIC",
    visibility: "PUBLIC",
    requiredCapability: null,
  });
  await fileDocument({
    mediaFileId: mediaFileIds[1] ?? "",
    title: MEMBER_DOCUMENT,
    audience: "MEMBER",
    visibility: "MEMBER",
    requiredCapability: "documents:manage",
  });
  await fileDocument({
    mediaFileId: mediaFileIds[2] ?? "",
    title: BOARD_DOCUMENT,
    audience: "BOARD",
    visibility: "INTERNAL",
    requiredCapability: "documents:manage",
  });

  await prisma.associationFacts.upsert({
    where: { id: 1 },
    create: { id: 1, buildYear: 1948 },
    update: { buildYear: 1948 },
  });

  // One page carrying all four blocks, public, so every reader below is
  // rendering the same stored body.
  await prisma.page.create({
    data: {
      slug: pageSlug,
      title: "Om föreningen",
      content: {
        version: 1,
        blocks: [
          { type: "documentList" },
          { type: "boardRoster" },
          { type: "associationFacts" },
          {
            type: "faq",
            items: [{ question: FAQ_QUESTION, answer: [{ text: FAQ_ANSWER }] }],
          },
        ],
      },
      visibility: "PUBLIC",
      published: true,
      publishedAt: new Date(),
      sortOrder: 900,
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [member, resident, boardMember]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  memberCookie = await signIn(member.email);
  residentCookie = await signIn(resident.email);
  boardCookie = await signIn(boardMember.email);
}, 180_000);

/**
 * Runs every cleanup step, then reports whichever of them failed.
 *
 * One step must not be able to stop the next: this database is shared with the
 * other integration suites, so a row this one leaves behind turns up later as a
 * stranger in a suite that scans the person table.
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
      "The site blocks suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        () => prisma.page.deleteMany({ where: { slug: pageSlug } }),
        // The document rows go with their files, by the cascade on the
        // reference.
        () =>
          prisma.mediaFile.deleteMany({ where: { id: { in: mediaFileIds } } }),
        () =>
          prisma.publicationConsent.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.boardPosition.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () => prisma.residency.deleteMany({ where: { apartmentId } }),
        () => prisma.apartment.deleteMany({ where: { id: apartmentId } }),
        () => prisma.address.deleteMany({ where: { id: addressId } }),
        () =>
          prisma.user.deleteMany({ where: { personId: { in: personIds } } }),
        () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("a document list on a page anybody can open", () => {
  it("lists the public shelf to a visitor with no account", async () => {
    const html = await pageAs();

    expect(html).toContain(PUBLIC_DOCUMENT);
    expect(html).not.toContain(MEMBER_DOCUMENT);
    expect(html).not.toContain(BOARD_DOCUMENT);
  });

  it("lists the members' shelf as well to a member", async () => {
    const html = await pageAs(memberCookie);

    expect(html).toContain(PUBLIC_DOCUMENT);
    expect(html).toContain(MEMBER_DOCUMENT);
    expect(html).not.toContain(BOARD_DOCUMENT);
  });

  it("gives a resident who is not a member the public shelf only", async () => {
    /*
     * The sharp case. This person holds a session, so a page kept for the
     * members opens for them - that is the website's own rule and it is
     * deliberate. The archive's rule is narrower, and it is the archive's to
     * make: the minutes and the annual report are the members'.
     */
    const html = await pageAs(residentCookie);

    expect(html).toContain(PUBLIC_DOCUMENT);
    expect(html).not.toContain(MEMBER_DOCUMENT);
    expect(html).not.toContain(BOARD_DOCUMENT);
  });

  it("never lists the board's own shelf, not even to the board", async () => {
    /*
     * This reader holds documents:manage and reads all three shelves in the
     * archive. The website is the one surface with no capability check at all,
     * so a board document is never named on it: the link would be one nobody
     * reading the page could follow, and a hint about what the board holds.
     */
    const html = await pageAs(boardCookie);

    expect(html).toContain(PUBLIC_DOCUMENT);
    expect(html).toContain(MEMBER_DOCUMENT);
    expect(html).not.toContain(BOARD_DOCUMENT);
  });
});

describe("a board roster on a page anybody can open", () => {
  it("names the board member who has given a publication consent", async () => {
    const html = await pageAs();

    expect(html).toContain(CONSENTED_SURNAME);
    expect(html).toContain("Ordförande");
  });

  it("leaves out the board member nobody has asked", async () => {
    expect(await pageAs()).not.toContain(SILENT_SURNAME);
  });

  it("leaves out a board member with protected personal data", async () => {
    // Consented, and still absent. Publication is what protection exists to
    // prevent, so the association carries the rule.
    expect(await pageAs()).not.toContain(PROTECTED_SURNAME);
  });

  it("publishes the same roster to a member as to a visitor", async () => {
    // A roster is a publication and not a shelf: a session buys a member-only
    // page, never another person's consent.
    const forMember = await pageAs(memberCookie);

    expect(forMember).toContain(CONSENTED_SURNAME);
    expect(forMember).not.toContain(SILENT_SURNAME);
    expect(forMember).not.toContain(PROTECTED_SURNAME);
  });
});

describe("the association facts and the questions on the same page", () => {
  it("carries the recorded facts, from the same rows the broker page uses", async () => {
    const [page, broker] = await Promise.all([pageAs(), brokerPage()]);

    expect(page).toContain("1948");
    expect(broker).toContain("1948");
  });

  it("carries the board's own questions and answers", async () => {
    const html = await pageAs();

    expect(html).toContain(FAQ_QUESTION);
    expect(html).toContain(FAQ_ANSWER);
  });
});

async function brokerPage(): Promise<string> {
  const response = await inject({ method: "GET", url: "/maklarinfo" });
  expect(response.statusCode).toBe(200);
  return response.body;
}
