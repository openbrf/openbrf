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
import { pdfBytes } from "../media/testing/document-fixtures";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * The apartment binder against a real database, over HTTP, per principal.
 *
 * The unit tests cover the refusals and the serving branch over fakes. What
 * only this suite can show is the thing the binder actually promises: that the
 * audience is enforced on the bytes as well as on the shelf, by the media
 * route, for a caller who has nothing but the file's address.
 *
 * So every case asks the same two questions of a different principal - what is
 * in your binder, and what happens when you ask for the file directly - because
 * a binder that filtered the list and served the file to anyone would pass any
 * test that only read the list.
 *
 * The transfer is the case the whole design is for: a move-out and a move-in on
 * the same day, after which the next household reads every entry with no name
 * on any of them and the last one reads nothing. It is written with dates
 * rather than with a clock, because the comparison is a calendar day.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const admin = {
  personId: `binder-admin-${suffix}`,
  email: `binder-admin-${suffix}@exempel.se`,
};
const boardMember = {
  personId: `binder-board-${suffix}`,
  email: `binder-board-${suffix}@exempel.se`,
};
const holder = {
  personId: `binder-holder-${suffix}`,
  email: `binder-holder-${suffix}@exempel.se`,
};
const partner = {
  personId: `binder-partner-${suffix}`,
  email: `binder-partner-${suffix}@exempel.se`,
};
const neighbour = {
  personId: `binder-neighbour-${suffix}`,
  email: `binder-neighbour-${suffix}@exempel.se`,
};
const buyer = {
  personId: `binder-buyer-${suffix}`,
  email: `binder-buyer-${suffix}@exempel.se`,
};
const actors = [admin, boardMember, holder, partner, neighbour, buyer];
const personIds = actors.map((actor) => actor.personId);

const addressId = `binder-address-${suffix}`;
const apartmentId = `binder-apartment-${suffix}`;
const otherApartmentId = `binder-other-apartment-${suffix}`;

/** Well behind today, so every residency below is held now. */
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
/** Well ahead of today: a move-in the board recorded before tillträde. */
const NOT_YET = new Date("2099-01-01T00:00:00.000Z");

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.53.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.53.${String(subnet)}.${String(host + 1)}`;
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
        ...options.headers,
      },
    });
}

/**
 * A multipart body carrying the fields and then one file.
 *
 * The fields go first, which is the order the handler depends on: the parser
 * stops at the file part, so a field written after it is one the handler is not
 * guaranteed to have seen.
 */
function multipart(
  fields: Readonly<Record<string, string>>,
  bytes: Buffer,
  fileName: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----openbrfBinderBoundary";
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
        `Content-Type: application/pdf\r\n\r\n`,
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

interface EntryBody {
  id: string;
  kind: string;
  audience: string;
  title: string;
  datedOn: string | null;
  filedAs: "BOARD" | "TENANT_OWNER";
  filedByYou: boolean;
  url: string;
}

interface BinderBody {
  apartmentId: string;
  apartment: string;
  isTenantOwner: boolean;
  entries: EntryBody[];
}

interface BoardBinderBody {
  apartmentId: string;
  tenantOwners: number;
  otherResidents: number;
  entries: (Omit<EntryBody, "filedByYou"> & {
    filedBy: { kind: string; name?: string };
  })[];
}

function fileEntry(
  cookie: string,
  url: string,
  fields: Readonly<Record<string, string>>,
  fileName = "ritning.pdf",
) {
  const body = multipart(fields, pdfBytes(), fileName);
  return inject({
    method: "POST",
    url,
    payload: body.payload,
    headers: { ...body.headers, cookie },
  });
}

async function bindersOf(cookie: string): Promise<BinderBody[]> {
  const response = await inject({
    method: "GET",
    url: "/api/apartment-binder",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as BinderBody[];
}

function fetchFile(cookie: string, url: string) {
  return inject({ method: "GET", url, headers: { cookie } });
}

let adminCookie: string;
let boardCookie: string;
let holderCookie: string;
let partnerCookie: string;
let neighbourCookie: string;
let buyerCookie: string;

/** The board's permission, for the tenant-owners. */
let permissionUrl: string;
/** A drawing, for the whole household. */
let drawingUrl: string;

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
      { id: admin.personId, firstName: "Alma", lastName: `Parm${suffix}` },
      { id: boardMember.personId, firstName: "Bo", lastName: `Parm${suffix}` },
      { id: holder.personId, firstName: "Hanna", lastName: `Parm${suffix}` },
      { id: partner.personId, firstName: "Pelle", lastName: `Parm${suffix}` },
      {
        id: neighbour.personId,
        firstName: "Nina",
        lastName: `Parm${suffix}`,
      },
      { id: buyer.personId, firstName: "Bengt", lastName: `Parm${suffix}` },
    ],
  });

  await prisma.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
  });
  await prisma.boardPosition.create({
    data: {
      personId: boardMember.personId,
      position: "BOARD_MEMBER",
      electedOn: LONG_AGO,
    },
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Parmgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: [
          { id: apartmentId, number: "1201", floor: 2 },
          { id: otherApartmentId, number: "1202", floor: 2 },
        ],
      },
    },
  });

  await prisma.residency.createMany({
    data: [
      {
        personId: holder.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: LONG_AGO,
      },
      {
        personId: partner.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: LONG_AGO,
      },
      {
        personId: neighbour.personId,
        apartmentId: otherApartmentId,
        role: "MEMBER",
        movedInOn: LONG_AGO,
      },
      // Recorded when the board admitted them, before tillträde: held by
      // nobody yet, and it grants nothing until the day arrives (ADR 0014).
      {
        personId: buyer.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: NOT_YET,
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

  adminCookie = await signIn(admin.email);
  boardCookie = await signIn(boardMember.email);
  holderCookie = await signIn(holder.email);
  partnerCookie = await signIn(partner.email);
  neighbourCookie = await signIn(neighbour.email);
  buyerCookie = await signIn(buyer.email);

  const permission = await fileEntry(
    boardCookie,
    `/api/apartment-binders/${apartmentId}/documents`,
    {
      kind: "ALTERATION_PERMISSION",
      audience: "TENANT_OWNERS",
      title: `Tillstand stambyte ${suffix}`,
      datedOn: "2026-05-04",
    },
    "tillstand.pdf",
  );
  expect(permission.statusCode).toBe(201);
  permissionUrl = (permission.json() as EntryBody).url;

  const drawing = await fileEntry(
    boardCookie,
    `/api/apartment-binders/${apartmentId}/documents`,
    {
      kind: "DRAWING",
      audience: "HOUSEHOLD",
      title: `Ritning badrum ${suffix}`,
    },
  );
  expect(drawing.statusCode).toBe(201);
  drawingUrl = (drawing.json() as EntryBody).url;
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
      "The apartment binder suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        // The entries go with their files, by the cascade on the reference,
        // and the files name the apartment, so this reaches both.
        () =>
          prisma.mediaFile.deleteMany({
            where: { apartmentId: { in: [apartmentId, otherApartmentId] } },
          }),
        () =>
          prisma.apartmentDocument.deleteMany({
            where: { apartmentId: { in: [apartmentId, otherApartmentId] } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.apartment.deleteMany({
            where: { id: { in: [apartmentId, otherApartmentId] } },
          }),
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
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("the household's own binder", () => {
  it("gives a tenant-owner both audiences, and the file behind each", async () => {
    const binders = await bindersOf(holderCookie);

    expect(binders).toHaveLength(1);
    expect(binders[0]?.isTenantOwner).toBe(true);
    expect(binders[0]?.entries.map((entry) => entry.kind)).toEqual([
      "DRAWING",
      "ALTERATION_PERMISSION",
    ]);
    // Never a name, not even to the person who holds the apartment.
    for (const entry of binders[0]?.entries ?? []) {
      expect(entry.filedAs).toBe("BOARD");
      expect(JSON.stringify(entry)).not.toContain(`Parm${suffix}`);
    }

    expect((await fetchFile(holderCookie, permissionUrl)).statusCode).toBe(200);
    expect((await fetchFile(holderCookie, drawingUrl)).statusCode).toBe(200);
  });

  it("gives a resident the household entries and refuses the rest, list and bytes alike", async () => {
    const binders = await bindersOf(partnerCookie);

    expect(binders[0]?.isTenantOwner).toBe(false);
    expect(binders[0]?.entries.map((entry) => entry.kind)).toEqual(["DRAWING"]);

    expect((await fetchFile(partnerCookie, drawingUrl)).statusCode).toBe(200);
    // The file the list left out, asked for by its own address.
    expect((await fetchFile(partnerCookie, permissionUrl)).statusCode).toBe(
      404,
    );
  });

  it("gives a household of another apartment its own binder and nothing of this one", async () => {
    // Their own, which is empty, and not a line of the neighbours'. A binder
    // is offered per apartment held rather than per apartment there is.
    const binders = await bindersOf(neighbourCookie);

    expect(binders).toHaveLength(1);
    expect(binders[0]?.apartmentId).toBe(otherApartmentId);
    expect(binders[0]?.entries).toEqual([]);

    expect((await fetchFile(neighbourCookie, drawingUrl)).statusCode).toBe(404);
    expect((await fetchFile(neighbourCookie, permissionUrl)).statusCode).toBe(
      404,
    );
  });

  it("gives a buyer whose move-in has not arrived nothing", async () => {
    // The board records a buyer when it admits them, which is before
    // tillträde. Until that day the seller still lives there and the binder is
    // the seller's household's.
    expect(await bindersOf(buyerCookie)).toEqual([]);
    expect((await fetchFile(buyerCookie, drawingUrl)).statusCode).toBe(404);
  });

  it("answers a file that may not be read exactly as one that is not there", async () => {
    const missing = await fetchFile(
      neighbourCookie,
      "/api/media/does-not-exist",
    );
    const refused = await fetchFile(neighbourCookie, permissionUrl);

    expect(refused.statusCode).toBe(missing.statusCode);
    expect(refused.json()).toEqual(missing.json());
  });
});

describe("filing", () => {
  it("lets a tenant-owner file, and takes the entry out again", async () => {
    const filed = await fileEntry(
      holderCookie,
      `/api/apartment-binder/${apartmentId}/documents`,
      {
        kind: "INSTRUCTIONS",
        audience: "HOUSEHOLD",
        title: `Bruksanvisning diskmaskin ${suffix}`,
      },
      "bruksanvisning.pdf",
    );

    expect(filed.statusCode).toBe(201);
    const entry = filed.json() as EntryBody;
    expect(entry.filedAs).toBe("TENANT_OWNER");
    expect(entry.filedByYou).toBe(true);
    expect((await fetchFile(partnerCookie, entry.url)).statusCode).toBe(200);

    const removed = await inject({
      method: "DELETE",
      url: `/api/apartment-binder/documents/${entry.id}`,
      headers: { cookie: holderCookie },
    });
    expect(removed.statusCode).toBe(200);
    // The bytes go with the entry, by the cascade on the reference.
    expect((await fetchFile(holderCookie, entry.url)).statusCode).toBe(404);
  });

  it("refuses the board's permission to a tenant-owner", async () => {
    const refused = await fileEntry(
      holderCookie,
      `/api/apartment-binder/${apartmentId}/documents`,
      {
        kind: "ALTERATION_PERMISSION",
        audience: "TENANT_OWNERS",
        title: `Tillstand ${suffix}`,
        datedOn: "2026-05-04",
      },
    );

    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { reason: string }).reason).toBe(
      "kind-is-the-boards",
    );
  });

  it("refuses the board's permission without the day it was decided", async () => {
    const refused = await fileEntry(
      boardCookie,
      `/api/apartment-binders/${apartmentId}/documents`,
      {
        kind: "ALTERATION_PERMISSION",
        audience: "TENANT_OWNERS",
        title: `Tillstand utan dag ${suffix}`,
      },
    );

    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { reason: string }).reason).toBe("date-required");
  });

  it("answers an apartment that is not the caller's as one that is not there", async () => {
    const other = await fileEntry(
      holderCookie,
      `/api/apartment-binder/${otherApartmentId}/documents`,
      {
        kind: "DRAWING",
        audience: "HOUSEHOLD",
        title: `Ritning ${suffix}`,
      },
    );
    const absent = await fileEntry(
      holderCookie,
      `/api/apartment-binder/apartment-does-not-exist/documents`,
      {
        kind: "DRAWING",
        audience: "HOUSEHOLD",
        title: `Ritning ${suffix}`,
      },
    );

    expect(other.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(other.json()).toEqual(absent.json());
  });

  it("keeps every entry's audience and its file's visibility in step", async () => {
    // A CHECK cannot reach across two tables, so this is the assertion that
    // the two records of one decision agree for every entry written.
    const entries = await prisma.apartmentDocument.findMany({
      where: { apartmentId: { in: [apartmentId, otherApartmentId] } },
      select: {
        audience: true,
        mediaFile: {
          select: {
            visibility: true,
            apartmentId: true,
            requiredCapability: true,
            encryption: true,
          },
        },
      },
    });

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.mediaFile.visibility).toBe(entry.audience);
      expect(entry.mediaFile.apartmentId).toBe(apartmentId);
      expect(entry.mediaFile.requiredCapability).toBe("apartmentBinder:manage");
      // Every stored file is encrypted at rest (ADR 0015), a binder's included.
      expect(entry.mediaFile.encryption).toBe("SECRETSTREAM_64K");
    }
  });
});

describe("the board's way in", () => {
  it("is a board seat and not the administrator's grant", async () => {
    const asBoard = await inject({
      method: "GET",
      url: `/api/apartment-binders/${apartmentId}`,
      headers: { cookie: boardCookie },
    });
    const asAdmin = await inject({
      method: "GET",
      url: `/api/apartment-binders/${apartmentId}`,
      headers: { cookie: adminCookie },
    });

    expect(asBoard.statusCode).toBe(200);
    // The administrator holds every other capability in the product. ADR 0017.
    expect(asAdmin.statusCode).toBe(403);
    // And the bytes answer the same way.
    expect((await fetchFile(adminCookie, permissionUrl)).statusCode).toBe(404);
  });

  it("names the filer and counts who the binder is shown to today", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/apartment-binders/${apartmentId}`,
      headers: { cookie: boardCookie },
    });

    const binder = response.json() as BoardBinderBody;
    expect(binder.tenantOwners).toBe(1);
    expect(binder.otherResidents).toBe(1);
    expect(binder.entries[0]?.filedBy).toMatchObject({ kind: "person" });
  });

  it("writes every serve of a binder file to the board to the audit log", async () => {
    const before = await prisma.auditLogEntry.count({
      where: { action: "MEDIA_ACCESSED", actorPersonId: boardMember.personId },
    });

    expect((await fetchFile(boardCookie, permissionUrl)).statusCode).toBe(200);

    const after = await prisma.auditLogEntry.count({
      where: { action: "MEDIA_ACCESSED", actorPersonId: boardMember.personId },
    });
    expect(after).toBe(before + 1);
  });

  it("keeps the file name out of the upload entry", async () => {
    // The audit log is append-only and exempt from every purge, and a
    // household's file name is its own words about its own home.
    const uploads = await prisma.auditLogEntry.findMany({
      where: { action: "MEDIA_UPLOADED", actorPersonId: boardMember.personId },
      select: { context: true },
    });

    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      expect(upload.context).not.toHaveProperty("fileName");
    }
  });
});

describe("when the apartment changes hands", () => {
  it("hands the binder over on the day, copying nothing", async () => {
    /*
     * A move-out and a move-in on the same day, which is what a transfer looks
     * like in the register: the move-out date is the first day not held and the
     * move-in date is the first day held, so no day is held by two households
     * and none by nobody. Nothing is written to the binder at all.
     */
    const today = new Date();
    const handover = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - 1,
      ),
    );

    await prisma.residency.updateMany({
      where: { personId: holder.personId, apartmentId },
      data: { movedOutOn: handover },
    });
    await prisma.residency.updateMany({
      where: { personId: buyer.personId, apartmentId },
      data: { movedInOn: handover },
    });

    const buyersBinder = await bindersOf(buyerCookie);
    expect(buyersBinder[0]?.isTenantOwner).toBe(true);
    expect(buyersBinder[0]?.entries.map((entry) => entry.kind)).toEqual([
      "DRAWING",
      "ALTERATION_PERMISSION",
    ]);
    for (const entry of buyersBinder[0]?.entries ?? []) {
      expect(JSON.stringify(entry)).not.toContain(`Parm${suffix}`);
    }
    expect((await fetchFile(buyerCookie, permissionUrl)).statusCode).toBe(200);

    // And the household that left reads nothing, at the list and at the bytes.
    expect(await bindersOf(holderCookie)).toEqual([]);
    expect((await fetchFile(holderCookie, permissionUrl)).statusCode).toBe(404);
    expect((await fetchFile(holderCookie, drawingUrl)).statusCode).toBe(404);

    /*
     * The residency the board did not end. The partner still reads the
     * household's entries, which no code can close because only the board knows
     * they have gone - and which is why the board is shown how many people the
     * binder reaches today.
     */
    expect((await fetchFile(partnerCookie, drawingUrl)).statusCode).toBe(200);
  });
});
