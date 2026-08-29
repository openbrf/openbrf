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
import { registerMultipart } from "../http/multipart";
import { pngBytes } from "../media/testing/image-fixtures";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { IssueTypeService } from "./issue-type.service";

/**
 * Issues over HTTP, against a real database.
 *
 * Four properties can only be shown here, and each one is a promise the module
 * makes rather than a convenience.
 *
 * The audience filter is enforced by the server. A resident is offered the
 * member types and nothing else, and posting the identifier of an internal type
 * they were never shown is answered as if that type did not exist - so the
 * catalogue cannot be enumerated one guess at a time.
 *
 * The public form is a toggle, not a hidden control. With it off the anonymous
 * audience is refused at the service, which is what makes "the form does not
 * exist" true rather than merely rendered.
 *
 * A reporter reads their own reports and nobody else's, and a photograph can
 * only be hung on one's own.
 *
 * And the property manager's promise (decision 11): the queue, their own
 * account, and NOTHING else - not the address book, not either statutory
 * register, not the instance settings, not even the type catalogue.
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
const personIds = [board.personId, resident.personId, manager.personId];

const addressId = `is-address-${suffix}`;
const ownApartmentId = `is-apartment-own-${suffix}`;
const otherApartmentId = `is-apartment-other-${suffix}`;

const typeIds = {
  nonMember: `is-type-non-member-${suffix}`,
  member: `is-type-member-${suffix}`,
  boardInternal: `is-type-board-${suffix}`,
};

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
        // 10.9.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.9.${String(subnet)}.${String(host + 1)}`,
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
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
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
  audience: string;
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
    ],
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  await prisma.issueType.createMany({
    data: [
      {
        id: typeIds.nonMember,
        name: "Skadegorelse pa fasaden",
        audience: "NON_MEMBER",
        sortOrder: 1,
      },
      {
        id: typeIds.member,
        name: "Fel i lagenheten",
        audience: "MEMBER",
        sortOrder: 2,
      },
      {
        id: typeIds.boardInternal,
        name: "Internt: besiktning",
        audience: "BOARD",
        sortOrder: 3,
      },
    ],
  });

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
  managerCookie = await signIn(manager.email);
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
    where: { id: { in: Object.values(typeIds) } },
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

describe("the audience filter", () => {
  it("offers a resident the member types and nothing else", async () => {
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

  it("offers a caller with no session the non-member types only", async () => {
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

  it("refuses a non-member type from a resident the same way", async () => {
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
      mine.json<{ id: string; status: string; typeName: string }[]>();
    expect(rows.some((row) => row.id === filed.id)).toBe(true);
    expect(rows[0]?.status).toBe("NEW");
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
});

describe("the triage queue", () => {
  it("moves a report through the three states", async () => {
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
    const rows =
      queue.json<
        { id: string; status: string; reporter: { kind: string } }[]
      >();
    const row = rows.find((candidate) => candidate.id === filed.id);
    expect(row?.status).toBe("NEW");
    expect(row?.reporter.kind).toBe("resident");

    for (const status of ["IN_PROGRESS", "DONE"] as const) {
      const moved = await inject({
        method: "POST",
        url: `/api/issue-queue/${filed.id ?? ""}/status`,
        payload: { status },
        headers: { cookie: managerCookie },
      });
      expect(moved.statusCode).toBe(201);
      expect(moved.json<{ status: string }>().status).toBe(status);
    }
  });

  it("withholds the name of a reporter with protected personal data", async () => {
    const filed = await report(residentCookie, {
      typeId: typeIds.member,
      description: "Rapport fran en skyddad person.",
    });
    expect(filed.statusCode).toBe(201);

    await prisma.person.update({
      where: { id: resident.personId },
      data: { protectedPersonalData: true },
    });
    try {
      const queue = await inject({
        method: "GET",
        url: "/api/issue-queue",
        headers: { cookie: managerCookie },
      });
      const row = queue
        .json<{ id: string; reporter: { kind: string } }[]>()
        .find((candidate) => candidate.id === filed.id);

      /*
       * Skyddade personuppgifter are masked in every view. The board's own
       * address book prints the name because a statutory register has to; a
       * queue an external property manager reads has no such reason, so the
       * name is simply not in the response.
       */
      expect(row?.reporter.kind).toBe("protected");
      expect(JSON.stringify(row)).not.toContain("Rune");
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
      payload: { name: "Tvattstugan", audience: "MEMBER", sortOrder: 9 },
      headers: { cookie: boardCookie },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const deactivated = await inject({
      method: "PUT",
      url: `/api/issue-types/${id}`,
      payload: {
        name: "Tvattstugan",
        audience: "MEMBER",
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
