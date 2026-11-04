import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { registerMultipart } from "../http/multipart";
import { pngBytes } from "../media/testing/image-fixtures";
import { waitFor } from "../testing/advisory-locks";
import { backendPid, waitersBehind } from "../testing/lock-waiters";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { IssueTypeService } from "./issue-type.service";
import { IssueService, MAX_PHOTOS_PER_ISSUE } from "./issue.service";

/**
 * Issues over HTTP, against a real database.
 *
 * Four properties can only be shown here, and each one is a promise the module
 * makes rather than a convenience.
 *
 * The reporter filter is enforced by the server. A resident is offered the
 * types residents may report and nothing else, and posting the identifier of
 * an internal type
 * they were never shown is answered as if that type did not exist - so the
 * catalogue cannot be enumerated one guess at a time.
 *
 * The public form is a toggle, not a hidden control. With it off the public is
 * refused at the service, which is what makes "the form does not
 * exist" true rather than merely rendered.
 *
 * A reporter reads their own reports and nobody else's, and a photograph can
 * only be hung on one's own.
 *
 * And the property manager's promise (decision 11): the queue, their own
 * account, and NOTHING else - not the address book, not either statutory
 * register, not the instance settings, not even the board's screen for the
 * type catalogue - only the types and statuses an issue is moved between.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let types: IssueTypeService;
let encryption: FieldEncryptionService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

const board = {
  personId: `is-board-${suffix}`,
  email: `is-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `is-resident-${suffix}`,
  email: `is-resident-${suffix}@exempel.se`,
};
const manager = {
  personId: `is-manager-${suffix}`,
  email: `is-manager-${suffix}@exempel.se`,
};
/** Lives in the house and reported nothing: the photos are not theirs. */
const neighbour = {
  personId: `is-neighbour-${suffix}`,
  email: `is-neighbour-${suffix}@exempel.se`,
};
const personIds = [
  board.personId,
  resident.personId,
  manager.personId,
  neighbour.personId,
];

const addressId = `is-address-${suffix}`;
const ownApartmentId = `is-apartment-own-${suffix}`;
const otherApartmentId = `is-apartment-other-${suffix}`;

/**
 * The type the catalogue test creates through the API.
 *
 * Its id is the server's, so afterAll cannot clean it up by id. The name
 * carries the run's suffix instead, and afterAll sweeps on that: an assertion
 * that fails before the delete at the end of that test would otherwise leave an
 * active MEMBER type behind, and the next run's reportable-list assertions
 * compare the whole array.
 */
const laundryTypeName = `is-type-laundry-${suffix}`;

const typeIds = {
  nonMember: `is-type-non-member-${suffix}`,
  member: `is-type-member-${suffix}`,
  boardInternal: `is-type-board-${suffix}`,
};

/** The member type and the ids of its default statuses. */
let memberType: IssueTypeFixture;

/** Well under any configured limit, and enough for a header to be read. */
const MAX_UPLOAD_BYTES = 4096;

let associationCreatedHere = false;
let previousPublicReporting = true;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object | Buffer;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        // 10.57.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.57.${String(subnet)}.${String(host + 1)}`,
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

/** A multipart body carrying one file, built by hand so no client is assumed. */
function multipart(bytes: Buffer, fileName: string, contentType: string) {
  const boundary = "----openbrfIssueBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
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

async function setPublicReporting(enabled: boolean): Promise<void> {
  await prisma.association.update({
    where: { id: 1 },
    data: { issueReportingPublic: enabled },
  });
}

interface ReportableType {
  id: string;
  name: string;
  reporters: string[];
}

interface QueuedRow {
  id: string;
  reporter: { kind: string };
  apartment: { id: string; number: string; address: string } | null;
  aboutApartment: boolean;
  location: string | null;
}

interface QueuedStatusRow {
  id: string;
  meaning: string;
  status: { id: string; label: string };
  waitingReason: string | null;
  outcome: string | null;
  closedAt: string | null;
  reporter: { kind: string };
}

/** Moves an issue as the property manager, who handles issues. */
async function moveIssue(
  id: string,
  payload: object,
): Promise<Awaited<ReturnType<typeof inject>>> {
  return inject({
    method: "POST",
    url: `/api/issue-queue/${id}/status`,
    payload,
    headers: { cookie: managerCookie },
  });
}

async function reportableTypes(cookie: string): Promise<ReportableType[]> {
  const response = await inject({
    method: "GET",
    url: "/api/issues/types",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<ReportableType[]>();
}

async function report(
  cookie: string,
  payload: object,
): Promise<{ statusCode: number; id?: string; reason?: string }> {
  const response = await inject({
    method: "POST",
    url: "/api/issues",
    payload,
    headers: { cookie },
  });
  const body = response.json<{ id?: string; reason?: string }>();
  return { statusCode: response.statusCode, ...body };
}

let boardCookie = "";
let residentCookie = "";
let managerCookie = "";
let neighbourCookie = "";

beforeAll(async () => {
  const env: Env = { ...baseEnv, OPENBRF_MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES };

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
  types = app.get(IssueTypeService);
  encryption = app.get(FieldEncryptionService);

  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { issueReportingPublic: true },
  });
  associationCreatedHere = existing === null;
  previousPublicReporting = existing?.issueReportingPublic ?? true;
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });

  const address = await prisma.address.create({
    data: {
      id: addressId,
      street: "Felgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: ownApartmentId, addressId: address.id, number: "1401", floor: 4 },
      { id: otherApartmentId, addressId: address.id, number: "1402", floor: 4 },
    ],
  });

  for (const person of [
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...resident, firstName: "Rune", lastName: "Boende" },
    { ...manager, firstName: "Frida", lastName: "Forvaltare" },
    { ...neighbour, firstName: "Nils", lastName: "Granne" },
  ]) {
    const email = await encryption.encrypt("person.email", person.email);
    await prisma.person.create({
      data: {
        id: person.personId,
        firstName: person.firstName,
        lastName: person.lastName,
        emailCipher: email.cipher,
        emailIndex: email.index,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: `${person.firstName} ${person.lastName}`,
      password: PASSWORD,
    });
  }

  // The board member lives in the house, which is the ordinary case: they see
  // the member types AND the internal ones.
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: board.personId,
        apartmentId: otherApartmentId,
        role: "MEMBER",
        movedInOn: new Date("2024-01-01"),
      },
      {
        personId: resident.personId,
        apartmentId: ownApartmentId,
        role: "MEMBER",
        movedInOn: new Date("2024-01-01"),
      },
      {
        personId: neighbour.personId,
        apartmentId: otherApartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2024-01-01"),
      },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  await createIssueTypeFixture(prisma, {
    id: typeIds.nonMember,
    name: "Skadegorelse pa fasaden",
    reporters: ["PUBLIC"],
    sortOrder: 1,
  });
  memberType = await createIssueTypeFixture(prisma, {
    id: typeIds.member,
    name: "Fel i lagenheten",
    reporters: ["RESIDENTS"],
    sortOrder: 2,
  });
  await createIssueTypeFixture(prisma, {
    id: typeIds.boardInternal,
    name: "Internt: besiktning",
    reporters: ["HANDLERS"],
    sortOrder: 3,
  });

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
  managerCookie = await signIn(manager.email);
  neighbourCookie = await signIn(neighbour.email);
}, 180_000);

afterAll(async () => {
  await prisma.issuePhoto.deleteMany({
    where: { issue: { typeId: { in: Object.values(typeIds) } } },
  });
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
  });
  await prisma.mediaFile.deleteMany({
    where: { uploadedByPersonId: { in: personIds } },
  });
  await prisma.issueType.deleteMany({
    where: {
      OR: [
        { id: { in: Object.values(typeIds) } },
        // The catalogue test's type, whose id only the server knows.
        { name: { endsWith: suffix } },
      ],
    },
  });
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.systemRole.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({
    where: { id: { in: [ownApartmentId, otherApartmentId] } },
  });
  await prisma.address.deleteMany({ where: { id: addressId } });

  // Restored rather than left as this suite wanted it: the fixture the other
  // suites share depends on the association row it found.
  if (associationCreatedHere) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  } else {
    await setPublicReporting(previousPublicReporting);
  }

  await app.close();
});

describe("the reporter filter", () => {
  it("offers a resident the residents' types and nothing else", async () => {
    const offered = await reportableTypes(residentCookie);

    expect(offered.map((type) => type.id)).toEqual([typeIds.member]);
  });

  it("offers whoever handles issues the internal types as well", async () => {
    const offered = await reportableTypes(boardCookie);

    expect(offered.map((type) => type.id)).toEqual([
      typeIds.member,
      typeIds.boardInternal,
    ]);
  });

  it("offers a caller with no session the public types only", async () => {
    await setPublicReporting(true);

    const offered = await types.listReportable(null);

    expect(offered.map((type) => type.id)).toEqual([typeIds.nonMember]);
  });

  it("refuses an internal type as if it did not exist", async () => {
    const refused = await report(residentCookie, {
      typeId: typeIds.boardInternal,
      description: "Guessing at the board's own categories.",
    });

    expect(refused.statusCode).toBe(404);
    expect(refused.reason).toBe("type-not-found");
  });

  it("refuses a public type from a resident the same way", async () => {
    const refused = await report(residentCookie, {
      typeId: typeIds.nonMember,
      description: "The public form's category, from inside.",
    });

    expect(refused.statusCode).toBe(404);
    expect(refused.reason).toBe("type-not-found");
  });
});

describe("the public form toggle", () => {
  it("refuses the anonymous audience while it is off", async () => {
    await setPublicReporting(false);

    await expect(types.listReportable(null)).rejects.toMatchObject({
      reason: "public-reporting-disabled",
    });
    // A signed-in reporter is unaffected: the toggle decides whether the
    // website carries a form, not whether the module works.
    await expect(reportableTypes(residentCookie)).resolves.toHaveLength(1);
  });

  it("is read with association:read and written with association:manage", async () => {
    await setPublicReporting(true);

    const read = await inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: boardCookie },
    });
    expect(read.statusCode).toBe(200);
    expect(
      read.json<{ issueReporting: { publicFormEnabled: boolean } }>()
        .issueReporting.publicFormEnabled,
    ).toBe(true);

    // The board reads it and an administrator changes it: a board seat alone
    // does not reconfigure the instance.
    const refused = await inject({
      method: "PUT",
      url: "/api/settings/issue-reporting",
      payload: { publicFormEnabled: false },
      headers: { cookie: boardCookie },
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe("reporting", () => {
  it("files a report against one's own apartment", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      apartmentId: ownApartmentId,
      location: "Badrummet",
      description: "Det droppar fran taket under grannens badrum.",
    });

    expect(filed.statusCode).toBe(201);
    expect(filed.id).toBeTruthy();

    const mine = await inject({
      method: "GET",
      url: "/api/issues/mine",
      headers: { cookie: residentCookie },
    });
    expect(mine.statusCode).toBe(200);
    const rows =
      mine.json<{ id: string; meaning: string; typeName: string }[]>();
    expect(rows.some((row) => row.id === filed.id)).toBe(true);
    expect(rows[0]?.meaning).toBe("NEW");
  });

  it("refuses an apartment the reporter does not live in", async () => {
    const refused = await report(residentCookie, {
      typeId: typeIds.member,
      apartmentId: otherApartmentId,
      description: "Someone else's home.",
    });

    // The same answer as an apartment that is not in the register: otherwise
    // this endpoint enumerates the building one identifier at a time.
    expect(refused.statusCode).toBe(404);
    expect(refused.reason).toBe("apartment-not-found");
  });

  it("shows a reporter their own reports and nobody else's", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Bara min egen.",
    });
    expect(filed.statusCode).toBe(201);

    const theirs = await inject({
      method: "GET",
      url: "/api/issues/mine",
      headers: { cookie: boardCookie },
    });
    const rows = theirs.json<{ id: string }[]>();

    expect(rows.some((row) => row.id === filed.id)).toBe(false);
  });

  it("keeps the description exactly as it was written", async () => {
    // An issue MAY legitimately carry a personnummer-shaped string: a resident
    // quoting a contractor's reference, say. The form warns about sensitive
    // detail; nothing here scans, rewrites or refuses it, because refusing
    // would turn away the reports the module exists for.
    const description = "Hantverkaren uppgav referens 19800101-0000.";
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description,
    });
    expect(filed.statusCode).toBe(201);

    const stored = await prisma.issue.findUniqueOrThrow({
      where: { id: filed.id ?? "" },
      select: { description: true },
    });
    expect(stored.description).toBe(description);
  });
});

/**
 * A location that holds only blanks is stored as no location, by every way an
 * issue is filed. Stored as written, it would be a location nobody wrote, and a
 * handler's redaction or the purge would then record removing it.
 */
describe("a blank location", () => {
  const BLANK = " \t ";

  async function storedLocation(id: string | undefined): Promise<unknown> {
    const stored = await prisma.issue.findUniqueOrThrow({
      where: { id: id ?? "" },
      select: { location: true },
    });
    return stored.location;
  }

  it("is stored as none on a member's report", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      location: BLANK,
      description: "Elementet i hallen blir inte varmt.",
    });
    expect(filed.statusCode).toBe(201);

    expect(await storedLocation(filed.id)).toBeNull();
  });

  it("is stored as none on a report from the website", async () => {
    await setPublicReporting(true);

    // Called on the service: the website's form trims its fields before they
    // get here, and the service holds the rule for every caller.
    const filed = await app.get(IssueService).reportPublicly({
      typeId: typeIds.nonMember,
      location: BLANK,
      description: "Klotter pa soptunnorna vid grinden.",
      reporterName: null,
      reporterEmail: null,
    });

    expect(await storedLocation(filed.id)).toBeNull();
  });

  it("is stored as none on an issue a handler opens", async () => {
    const opened = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: typeIds.member,
        location: BLANK,
        description: "Hissen stannar mellan plan tre och fyra.",
      },
      headers: { cookie: managerCookie },
    });
    expect(opened.statusCode).toBe(201);

    expect(await storedLocation(opened.json<{ id: string }>().id)).toBeNull();
  });
});

describe("photographs", () => {
  it("hangs a photograph on one's own report and refuses somebody else's", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Trasig dorr till cykelrummet.",
    });
    expect(filed.statusCode).toBe(201);

    const body = multipart(pngBytes(24, 24), "dorr.png", "image/png");
    const attached = await inject({
      method: "POST",
      url: `/api/issues/${filed.id ?? ""}/photos`,
      payload: body.payload,
      headers: { ...body.headers, cookie: residentCookie },
    });

    expect(attached.statusCode).toBe(201);
    const photo = attached.json<{ url: string }>();
    // Served from this instance's own origin, whichever driver holds the bytes.
    expect(photo.url.startsWith("/api/media/")).toBe(true);

    const notTheirs = await inject({
      method: "POST",
      url: `/api/issues/${filed.id ?? ""}/photos`,
      payload: body.payload,
      headers: { ...body.headers, cookie: boardCookie },
    });
    expect(notTheirs.statusCode).toBe(404);

    const mine = await inject({
      method: "GET",
      url: "/api/issues/mine",
      headers: { cookie: residentCookie },
    });
    const row = mine
      .json<{ id: string; photos: unknown[] }[]>()
      .find((candidate) => candidate.id === filed.id);
    expect(row?.photos).toHaveLength(1);
  });

  it("holds the cap against uploads sent at once and keeps no refused file", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Fuktflack i taket, fotad fran alla hall.",
    });
    expect(filed.statusCode).toBe(201);
    const issueId = filed.id ?? "";
    const filesBefore = await prisma.mediaFile.count({
      where: { uploadedByPersonId: resident.personId },
    });

    // Two more than the cap, all at once, so most of them read the count
    // before any other has written its photo.
    const body = multipart(pngBytes(24, 24), "tak.png", "image/png");
    const responses = await Promise.all(
      Array.from({ length: MAX_PHOTOS_PER_ISSUE + 2 }, () =>
        inject({
          method: "POST",
          url: `/api/issues/${issueId}/photos`,
          payload: body.payload,
          headers: { ...body.headers, cookie: residentCookie },
        }),
      ),
    );

    const refused = responses.filter((response) => response.statusCode !== 201);
    expect(refused.map((response) => response.statusCode)).toEqual([409, 409]);
    for (const response of refused) {
      expect(response.json<{ reason: string }>().reason).toBe(
        "too-many-photos",
      );
    }
    const photos = await prisma.issuePhoto.findMany({
      where: { issueId },
      select: { sortOrder: true },
      orderBy: { sortOrder: "asc" },
    });
    expect(photos.map((photo) => photo.sortOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    // A late refusal comes after the bytes were stored, and takes them away.
    expect(
      await prisma.mediaFile.count({
        where: { uploadedByPersonId: resident.personId },
      }),
    ).toBe(filesBefore + MAX_PHOTOS_PER_ISSUE);
  });

  it("serves a photograph to its reporter and to whoever handles issues, and to nobody else", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Fuktflack i taket.",
    });
    const body = multipart(pngBytes(24, 24), "tak.png", "image/png");
    const attached = await inject({
      method: "POST",
      url: `/api/issues/${filed.id ?? ""}/photos`,
      payload: body.payload,
      headers: { ...body.headers, cookie: residentCookie },
    });
    const { url } = attached.json<{ url: string }>();
    const fileId = url.slice("/api/media/".length);

    const read = (cookie: string) =>
      inject({ method: "GET", url, headers: { cookie } });

    expect((await read(residentCookie)).statusCode).toBe(200);
    // A photograph of somebody's home, possibly of people in it: a neighbour
    // who came by its address reads nothing, and learns nothing either.
    expect((await read(neighbourCookie)).statusCode).toBe(404);

    expect((await read(managerCookie)).statusCode).toBe(200);
    const accesses = await prisma.auditLogEntry.count({
      where: {
        action: "MEDIA_ACCESSED",
        targetId: fileId,
        actorPersonId: manager.personId,
      },
    });
    expect(accesses).toBe(1);
  });
});

describe("the triage queue", () => {
  it("moves a report through the four meanings, with what each requires", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Hissen stannar mellan vaningarna.",
    });
    expect(filed.statusCode).toBe(201);

    const queue = await inject({
      method: "GET",
      url: "/api/issue-queue",
      headers: { cookie: managerCookie },
    });
    expect(queue.statusCode).toBe(200);
    const row = queue
      .json<QueuedStatusRow[]>()
      .find((candidate) => candidate.id === filed.id);
    // A new report enters the type's default NEW status.
    expect(row?.meaning).toBe("NEW");
    expect(row?.status).toEqual({
      id: memberType.statusIds.NEW,
      label: "Ny",
    });
    expect(row?.reporter.kind).toBe("resident");

    const steps = [
      { statusId: memberType.statusIds.IN_PROGRESS },
      { statusId: memberType.statusIds.WAITING, waitingReason: "PARTS" },
      { statusId: memberType.statusIds.DONE, outcome: "FIXED" },
    ];
    const answers: QueuedStatusRow[] = [];
    for (const payload of steps) {
      const moved = await moveIssue(filed.id ?? "", payload);
      expect(moved.statusCode).toBe(201);
      answers.push(moved.json<QueuedStatusRow>());
    }
    expect(
      answers.map((answer) => [
        answer.meaning,
        answer.status.id,
        answer.waitingReason,
        answer.outcome,
        answer.closedAt === null,
      ]),
    ).toEqual([
      ["IN_PROGRESS", memberType.statusIds.IN_PROGRESS, null, null, true],
      ["WAITING", memberType.statusIds.WAITING, "PARTS", null, true],
      ["DONE", memberType.statusIds.DONE, null, "FIXED", false],
    ]);

    // One entry for each move, naming who made it, the meanings and the
    // statuses either side, and what the move carried; never a label. The
    // property manager is outside the board, and acts on residents' reports.
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "ISSUE_STATUS_CHANGED", targetId: filed.id },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.map((entry) => entry.actorPersonId)).toEqual([
      manager.personId,
      manager.personId,
      manager.personId,
    ]);
    const ids = memberType.statusIds;
    expect(entries.map((entry) => entry.context)).toEqual([
      {
        from: "NEW",
        to: "IN_PROGRESS",
        fromStatusId: ids.NEW,
        toStatusId: ids.IN_PROGRESS,
      },
      {
        from: "IN_PROGRESS",
        to: "WAITING",
        fromStatusId: ids.IN_PROGRESS,
        toStatusId: ids.WAITING,
        waitingReason: "PARTS",
      },
      {
        from: "WAITING",
        to: "DONE",
        fromStatusId: ids.WAITING,
        toStatusId: ids.DONE,
        outcome: "FIXED",
      },
    ]);
    // The reporter's words and the board's labels stay out of the log.
    expect(JSON.stringify(entries)).not.toContain("Hissen");
    expect(JSON.stringify(entries)).not.toContain("Pågår");

    // The reporter is told the meaning, and never the board's label.
    const mine = await inject({
      method: "GET",
      url: "/api/issues/mine",
      headers: { cookie: residentCookie },
    });
    const own = mine
      .json<Record<string, unknown>[]>()
      .find((candidate) => candidate["id"] === filed.id);
    expect(own?.["meaning"]).toBe("DONE");
    expect(JSON.stringify(own)).not.toContain("Klar");
  });

  it("refuses a wait without a reason and a close without an outcome", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Fonstret i trapphuset gar inte att stanga.",
    });
    const id = filed.id ?? "";

    const cases: [object, number, string][] = [
      [
        { statusId: memberType.statusIds.WAITING },
        422,
        "waiting-reason-required",
      ],
      [{ statusId: memberType.statusIds.DONE }, 422, "outcome-required"],
      [
        { statusId: memberType.statusIds.IN_PROGRESS, outcome: "FIXED" },
        422,
        "status-detail-not-applicable",
      ],
      [
        {
          statusId: memberType.statusIds.DONE,
          waitingReason: "PARTS",
          outcome: "FIXED",
        },
        422,
        "status-detail-not-applicable",
      ],
      // Another type's status is no status of this issue's.
      [
        { statusId: `${typeIds.nonMember}-in_progress` },
        404,
        "status-not-found",
      ],
    ];
    for (const [payload, statusCode, reason] of cases) {
      const refused = await moveIssue(id, payload);
      expect(refused.statusCode, JSON.stringify(payload)).toBe(statusCode);
      expect(refused.json<{ reason: string }>().reason).toBe(reason);
    }

    // Merging writes DUPLICATE; a handler never chooses it.
    const duplicate = await moveIssue(id, {
      statusId: memberType.statusIds.DONE,
      outcome: "DUPLICATE",
    });
    expect(duplicate.statusCode).toBe(400);

    // Nothing above moved it or wrote an entry.
    const issue = await prisma.issue.findUniqueOrThrow({ where: { id } });
    expect(issue.statusId).toBe(memberType.statusIds.NEW);
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "ISSUE_STATUS_CHANGED", targetId: id },
      }),
    ).toBe(0);
  });

  it("keeps the closing date and the outcome on a move between two done statuses", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Brevlådan sitter löst.",
    });
    const id = filed.id ?? "";
    const added = await inject({
      method: "POST",
      url: `/api/issue-types/${typeIds.member}/statuses`,
      payload: { meaning: "DONE", label: `Avslutat ${suffix}` },
      headers: { cookie: boardCookie },
    });
    expect(added.statusCode).toBe(201);
    const archived = added
      .json<{ statuses: { id: string; label: string }[] }>()
      .statuses.find((status) => status.label === `Avslutat ${suffix}`);

    try {
      await moveIssue(id, {
        statusId: memberType.statusIds.DONE,
        outcome: "NO_FAULT",
      });
      const closed = await prisma.issue.findUniqueOrThrow({ where: { id } });

      const moved = await moveIssue(id, { statusId: archived?.id ?? "" });
      expect(moved.statusCode).toBe(201);
      const after = await prisma.issue.findUniqueOrThrow({ where: { id } });
      expect(after.statusId).toBe(archived?.id);
      expect(after.closedAt).toEqual(closed.closedAt);
      expect(after.outcome).toBe("NO_FAULT");

      // Reopening clears both.
      await moveIssue(id, { statusId: memberType.statusIds.IN_PROGRESS });
      const reopened = await prisma.issue.findUniqueOrThrow({ where: { id } });
      expect(reopened.closedAt).toBeNull();
      expect(reopened.outcome).toBeNull();
    } finally {
      await prisma.issue.update({
        where: { id },
        data: {
          statusId: memberType.statusIds.NEW,
          closedAt: null,
          outcome: null,
        },
      });
      await prisma.issueStatus.delete({ where: { id: archived?.id ?? "" } });
    }
  });

  it("records nothing for a request that names the status the report already has", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Dorren till cykelrummet hakar upp sig.",
    });

    const moved = await moveIssue(filed.id ?? "", {
      statusId: memberType.statusIds.NEW,
    });

    expect(moved.statusCode).toBe(201);
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "ISSUE_STATUS_CHANGED", targetId: filed.id },
      }),
    ).toBe(0);
  });

  it("withholds the name and the apartment of a reporter with protected personal data", async () => {
    // Filed against their own apartment, which is the only kind a signed-in
    // resident can file against: the apartment is where they live.
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      apartmentId: ownApartmentId,
      location: "Badrummet",
      description: "Rapport fran en skyddad person.",
    });
    expect(filed.statusCode).toBe(201);
    // And one about no apartment, which the mask must not turn into one.
    const unhoused = await report(residentCookie, {
      typeId: typeIds.member,
      location: "Gården",
      description: "Rapport utan lägenhet från en skyddad person.",
    });
    expect(unhoused.statusCode).toBe(201);

    // The control: the same row carries the apartment while the reporter is
    // not protected, so what follows is the masking and not a missing join.
    const before = await inject({
      method: "GET",
      url: "/api/issue-queue",
      headers: { cookie: managerCookie },
    });
    const unmasked = before
      .json<QueuedRow[]>()
      .find((candidate) => candidate.id === filed.id);
    expect(unmasked?.apartment?.id).toBe(ownApartmentId);
    expect(unmasked?.aboutApartment).toBe(true);

    await prisma.person.update({
      where: { id: resident.personId },
      data: { protectedPersonalData: true },
    });
    try {
      /*
       * Skyddade personuppgifter are masked in every view. The board's own
       * address book prints the name and the apartment because a statutory
       * register has to; a queue an external property manager reads has no
       * such reason, so neither is in the response. The board reads the same
       * row: the queue has one view.
       */
      const expectMasked = (row: QueuedRow | undefined): void => {
        // Not even the person's id: a handler who saw them unmasked earlier
        // could link this row to them by it.
        expect(row?.reporter).toEqual({ kind: "protected" });
        expect(row?.apartment).toBeNull();
        // That it is about an apartment stays, naming none: it is what tells
        // the handler's screen to offer the entry permission and no place.
        expect(row?.aboutApartment).toBe(true);
        const text = JSON.stringify(row);
        expect(text).not.toContain(resident.personId);
        expect(text).not.toContain("Rune");
        expect(text).not.toContain("Boende");
        expect(text).not.toContain(ownApartmentId);
        expect(text).not.toContain("1401");
        expect(text).not.toContain("Felgatan");
        // What they wrote themselves stays.
        expect(row?.location).toBe("Badrummet");
      };

      for (const cookie of [managerCookie, boardCookie]) {
        const queue = await inject({
          method: "GET",
          url: "/api/issue-queue",
          headers: { cookie },
        });
        expect(queue.statusCode).toBe(200);
        expectMasked(
          queue
            .json<QueuedRow[]>()
            .find((candidate) => candidate.id === filed.id),
        );
        const other = queue
          .json<QueuedRow[]>()
          .find((candidate) => candidate.id === unhoused.id);
        expect(other?.reporter).toEqual({ kind: "protected" });
        expect(other?.aboutApartment).toBe(false);
      }

      // The row a status change answers with is built the same way.
      const moved = await moveIssue(filed.id ?? "", {
        statusId: memberType.statusIds.IN_PROGRESS,
      });
      expect(moved.statusCode).toBe(201);
      expectMasked(moved.json<QueuedRow>());

      // The reporter's own list is theirs, and still names their apartment.
      const mine = await inject({
        method: "GET",
        url: "/api/issues/mine",
        headers: { cookie: residentCookie },
      });
      expect(
        mine
          .json<{ id: string; apartment: { id: string } | null }[]>()
          .find((candidate) => candidate.id === filed.id)?.apartment?.id,
      ).toBe(ownApartmentId);
    } finally {
      await prisma.person.update({
        where: { id: resident.personId },
        data: { protectedPersonalData: false },
      });
    }
  });

  it("keeps the queue away from a resident", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/issue-queue",
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

/**
 * Decision 11, asserted rather than described.
 *
 * The property manager is an external party. Widening this list is the one
 * change that would breach what the platform promises a housing cooperative
 * about who its contractor can read.
 */
describe("the property manager", () => {
  it("reaches the issue queue and their own account", async () => {
    const queue = await inject({
      method: "GET",
      url: "/api/issue-queue",
      headers: { cookie: managerCookie },
    });
    expect(queue.statusCode).toBe(200);

    // The types and statuses an issue is moved between, which moving one
    // needs; not the board's screen for configuring them.
    const statuses = await inject({
      method: "GET",
      url: "/api/issue-queue/types",
      headers: { cookie: managerCookie },
    });
    expect(statuses.statusCode).toBe(200);

    const profile = await inject({
      method: "PUT",
      url: "/api/settings/profile",
      payload: { preferredLocale: "sv" },
      headers: { cookie: managerCookie },
    });
    expect(profile.statusCode).toBe(200);
  });

  it("reaches nothing else", async () => {
    for (const url of [
      "/api/address-book?filter=all&page=1",
      "/api/resident-directory?filter=all&page=1",
      "/api/member-register",
      "/api/apartment-register",
      "/api/settings",
      "/api/issue-types",
      "/api/issues/types",
      "/api/issues/mine",
    ]) {
      const response = await inject({
        method: "GET",
        url,
        headers: { cookie: managerCookie },
      });

      expect(
        response.statusCode,
        `${url} answered ${String(response.statusCode)}`,
      ).toBe(403);
    }
  });
});

describe("the type catalogue", () => {
  it("is configured by the board and refused to a resident", async () => {
    const listed = await inject({
      method: "GET",
      url: "/api/issue-types",
      headers: { cookie: boardCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ id: string }[]>().map((type) => type.id)).toEqual(
      expect.arrayContaining(Object.values(typeIds)),
    );

    const refused = await inject({
      method: "GET",
      url: "/api/issue-types",
      headers: { cookie: residentCookie },
    });
    expect(refused.statusCode).toBe(403);
  });

  it("refuses to delete a type that reports were filed under", async () => {
    const response = await inject({
      method: "DELETE",
      url: `/api/issue-types/${typeIds.member}`,
      headers: { cookie: boardCookie },
    });

    // Deactivating is the answer: the issues filed under it say what they were
    // about only through it.
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe("type-in-use");
  });

  it("creates, deactivates and removes an unused type", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/issue-types",
      payload: {
        name: laundryTypeName,
        reporters: ["RESIDENTS"],
        sortOrder: 9,
      },
      headers: { cookie: boardCookie },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    // A type works with no setup: one status of each meaning, each the
    // default of its meaning, named in the association's language.
    expect(
      created
        .json<{ statuses: { meaning: string; isDefault: boolean }[] }>()
        .statuses.map((status) => [status.meaning, status.isDefault]),
    ).toEqual([
      ["NEW", true],
      ["IN_PROGRESS", true],
      ["WAITING", true],
      ["DONE", true],
    ]);

    const deactivated = await inject({
      method: "PUT",
      url: `/api/issue-types/${id}`,
      payload: {
        name: laundryTypeName,
        reporters: ["RESIDENTS"],
        active: false,
        sortOrder: 9,
      },
      headers: { cookie: boardCookie },
    });
    expect(deactivated.statusCode).toBe(200);
    // Deactivated types are not offered, which is what deactivation means.
    expect(
      (await reportableTypes(residentCookie)).some((type) => type.id === id),
    ).toBe(false);

    const removed = await inject({
      method: "DELETE",
      url: `/api/issue-types/${id}`,
      headers: { cookie: boardCookie },
    });
    expect(removed.statusCode).toBe(204);
  });
});

describe("a type's statuses", () => {
  interface StatusRow {
    id: string;
    meaning: string;
    label: string;
    isDefault: boolean;
    active: boolean;
    sortOrder: number;
  }

  async function freshType(): Promise<{ id: string; statuses: StatusRow[] }> {
    const created = await inject({
      method: "POST",
      url: "/api/issue-types",
      payload: { name: `is-type-statuses-${suffix}`, reporters: ["RESIDENTS"] },
      headers: { cookie: boardCookie },
    });
    expect(created.statusCode).toBe(201);
    return created.json<{ id: string; statuses: StatusRow[] }>();
  }

  function statusesUrl(typeId: string, statusId?: string): string {
    return `/api/issue-types/${typeId}/statuses${statusId === undefined ? "" : `/${statusId}`}`;
  }

  it("lets the board rename a status and add one under a meaning", async () => {
    const type = await freshType();
    try {
      const waiting = type.statuses.find(
        (status) => status.meaning === "WAITING",
      );
      const renamed = await inject({
        method: "PUT",
        url: statusesUrl(type.id, waiting?.id),
        payload: { label: "  Väntar på svar  " },
        headers: { cookie: boardCookie },
      });
      expect(renamed.statusCode).toBe(200);

      const added = await inject({
        method: "POST",
        url: statusesUrl(type.id),
        payload: { meaning: "WAITING", label: "Väntar på styrelsebeslut" },
        headers: { cookie: boardCookie },
      });
      expect(added.statusCode).toBe(201);

      const waitingStatuses = added
        .json<{ statuses: StatusRow[] }>()
        .statuses.filter((status) => status.meaning === "WAITING");
      // Stored trimmed, the added one last within its meaning and not the
      // default: the default is what a case enters when none is named.
      expect(
        waitingStatuses.map((status) => [
          status.label,
          status.isDefault,
          status.sortOrder,
        ]),
      ).toEqual([
        ["Väntar på svar", true, 0],
        ["Väntar på styrelsebeslut", false, 1],
      ]);

      // A label of nothing but spaces names nothing.
      const blank = await inject({
        method: "POST",
        url: statusesUrl(type.id),
        payload: { meaning: "NEW", label: "   " },
        headers: { cookie: boardCookie },
      });
      expect(blank.statusCode).toBe(400);
    } finally {
      await prisma.issueType.delete({ where: { id: type.id } });
    }
  });

  it("keeps one default of each meaning, switched on", async () => {
    const type = await freshType();
    try {
      const done = type.statuses.find((status) => status.meaning === "DONE");
      const off = await inject({
        method: "PUT",
        url: statusesUrl(type.id, done?.id),
        payload: { label: done?.label ?? "", active: false },
        headers: { cookie: boardCookie },
      });
      expect(off.statusCode).toBe(409);
      expect(off.json<{ reason: string }>().reason).toBe(
        "default-status-required",
      );

      const added = await inject({
        method: "POST",
        url: statusesUrl(type.id),
        payload: { meaning: "DONE", label: "Avslutat" },
        headers: { cookie: boardCookie },
      });
      const other = added
        .json<{ statuses: StatusRow[] }>()
        .statuses.find((status) => status.label === "Avslutat");

      // Two requests at once, each making a status of the meaning the default,
      // leave one default and not two, and refuse neither.
      const answers = await Promise.all(
        [other?.id, done?.id].map((id) =>
          inject({
            method: "PUT",
            url: statusesUrl(type.id, id),
            payload: {
              label: id === other?.id ? "Avslutat" : (done?.label ?? ""),
              isDefault: true,
            },
            headers: { cookie: boardCookie },
          }),
        ),
      );
      expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200]);
      expect(
        await prisma.issueStatus.count({
          where: { typeId: type.id, meaning: "DONE", isDefault: true },
        }),
      ).toBe(1);

      const madeDefault = await inject({
        method: "PUT",
        url: statusesUrl(type.id, other?.id),
        payload: { label: "Avslutat", isDefault: true },
        headers: { cookie: boardCookie },
      });
      expect(madeDefault.statusCode).toBe(200);
      const switchedOff = await inject({
        method: "PUT",
        url: statusesUrl(type.id, done?.id),
        payload: { label: done?.label ?? "", active: false },
        headers: { cookie: boardCookie },
      });
      expect(switchedOff.statusCode).toBe(200);
      expect(
        switchedOff
          .json<{ statuses: StatusRow[] }>()
          .statuses.filter((status) => status.meaning === "DONE")
          .map((status) => [status.label, status.isDefault, status.active]),
      ).toEqual([
        [done?.label, false, false],
        ["Avslutat", true, true],
      ]);
    } finally {
      await prisma.issueType.delete({ where: { id: type.id } });
    }
  });

  it("refuses a switched-off status as a target", async () => {
    const added = await inject({
      method: "POST",
      url: statusesUrl(typeIds.member),
      payload: { meaning: "IN_PROGRESS", label: `Hos entreprenör ${suffix}` },
      headers: { cookie: boardCookie },
    });
    const status = added
      .json<{ statuses: StatusRow[] }>()
      .statuses.find((row) => row.label === `Hos entreprenör ${suffix}`);
    try {
      await inject({
        method: "PUT",
        url: statusesUrl(typeIds.member, status?.id),
        payload: { label: `Hos entreprenör ${suffix}`, active: false },
        headers: { cookie: boardCookie },
      });
      const filed = await report(residentCookie, {
        typeId: typeIds.member,
        description: "Ventilationen i badrummet bullrar.",
      });
      const refused = await moveIssue(filed.id ?? "", {
        statusId: status?.id ?? "",
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "status-not-found",
      );
    } finally {
      await prisma.issueStatus.delete({ where: { id: status?.id ?? "" } });
    }
  });

  it("is configured by the board and by nobody who only handles issues", async () => {
    for (const cookie of [managerCookie, residentCookie]) {
      const refused = await inject({
        method: "POST",
        url: statusesUrl(typeIds.member),
        payload: { meaning: "NEW", label: "Inkommen" },
        headers: { cookie },
      });
      expect(refused.statusCode).toBe(403);
    }
  });
});

/**
 * A type removed while somebody else writes against it.
 *
 * The checks before each write read the type and its reports and only then
 * write, so a write by somebody else can land in between. The foreign key from
 * an issue to its type is what notices, and it has to answer with the refusal
 * the check would have given rather than with a 500.
 *
 * Played out deterministically: the test opens a transaction that writes one
 * side and holds it open, sends the other side, waits until the database says
 * that request is queued behind the open transaction, and then commits.
 */
describe("a type removed while somebody writes against it", () => {
  /** Writes `first` in a transaction and holds it until `second` waits. */
  async function across<T>(
    first: (tx: Prisma.TransactionClient) => Promise<unknown>,
    second: () => Promise<T>,
  ): Promise<T> {
    let written!: (pid: number) => void;
    const wrote = new Promise<number>((resolve) => {
      written = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        const pid = await backendPid(tx);
        await first(tx);
        written(pid);
        await released;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );
    const holder = await wrote;

    // Let go however the wait ends, so a failure does not leave the write
    // held until the transaction times out.
    try {
      const answering = second();
      await waitFor(async () => (await waitersBehind(prisma, holder)) > 0);
      release();
      const [answer] = await Promise.all([answering, holding]);
      return answer;
    } finally {
      release();
      // Already settled on the way through; on a failure, its own rejection is
      // the second one and the first is what the test reports.
      await holding.catch(() => undefined);
    }
  }

  let racing = 0;

  async function racingType(): Promise<IssueTypeFixture> {
    racing += 1;
    return createIssueTypeFixture(prisma, {
      id: `is-type-racing-${suffix}-${String(racing)}`,
      name: `is-type-racing-${suffix}`,
      reporters: ["RESIDENTS"],
    });
  }

  async function sweep(typeId: string): Promise<void> {
    await prisma.issue.deleteMany({ where: { typeId } });
    await prisma.issueType.deleteMany({ where: { id: typeId } });
  }

  it("refuses the removal as in use when a report lands first", async () => {
    const { id: typeId, statusIds } = await racingType();
    try {
      const removed = await across(
        (tx) =>
          tx.issue.create({
            data: {
              typeId,
              statusId: statusIds.NEW,
              description: "Kranen droppar.",
            },
          }),
        () =>
          inject({
            method: "DELETE",
            url: `/api/issue-types/${typeId}`,
            headers: { cookie: boardCookie },
          }),
      );

      expect(removed.statusCode).toBe(409);
      expect(removed.json<{ reason: string }>().reason).toBe("type-in-use");
    } finally {
      await sweep(typeId);
    }
  });

  it("refuses the report as of no such type when the removal lands first", async () => {
    const { id: typeId } = await racingType();
    try {
      const filed = await across(
        (tx) => tx.issueType.delete({ where: { id: typeId } }),
        () =>
          report(residentCookie, {
            typeId,
            description: "Lampan i trapphuset ar trasig.",
          }),
      );

      expect(filed.statusCode).toBe(404);
      expect(filed.reason).toBe("type-not-found");
    } finally {
      await sweep(typeId);
    }
  });

  it("refuses an edit of a type removed under it as of no such type", async () => {
    const { id: typeId } = await racingType();
    try {
      const edited = await across(
        (tx) => tx.issueType.delete({ where: { id: typeId } }),
        () =>
          inject({
            method: "PUT",
            url: `/api/issue-types/${typeId}`,
            payload: {
              name: `is-type-racing-${suffix}`,
              reporters: ["RESIDENTS"],
            },
            headers: { cookie: boardCookie },
          }),
      );

      expect(edited.statusCode).toBe(404);
      expect(edited.json<{ reason: string }>().reason).toBe("type-not-found");
    } finally {
      await sweep(typeId);
    }
  });
});
