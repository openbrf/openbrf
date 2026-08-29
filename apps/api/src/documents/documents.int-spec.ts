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
import { pngBytes } from "../media/testing/image-fixtures";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * The document archive against a real database, over HTTP, per principal.
 *
 * The unit tests cover the audience rule and the transaction that keeps a
 * document's audience and its file's visibility in step. What only this suite
 * can show is the thing the archive actually promises: that the audience is
 * enforced on the bytes as well as on the shelf, by the media route, for a
 * caller who has only the file's address and no listing at all.
 *
 * So every case here asks the same two questions of a different principal -
 * what is on your shelf, and what happens when you ask for the file directly -
 * because an archive that filtered the list and served the file to anyone
 * would pass any test that only read the list.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const admin = {
  personId: `documents-admin-${suffix}`,
  email: `documents-admin-${suffix}@exempel.se`,
};
const boardMember = {
  personId: `documents-board-${suffix}`,
  email: `documents-board-${suffix}@exempel.se`,
};
const member = {
  personId: `documents-member-${suffix}`,
  email: `documents-member-${suffix}@exempel.se`,
};
const resident = {
  personId: `documents-resident-${suffix}`,
  email: `documents-resident-${suffix}@exempel.se`,
};
const actors = [admin, boardMember, member, resident];
const personIds = actors.map((actor) => actor.personId);

const addressId = `documents-address-${suffix}`;
const apartmentId = `documents-apartment-${suffix}`;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.12.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.12.${String(subnet)}.${String(host + 1)}`;
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
 * stops at the file part, so a field written after it is one the handler is
 * not guaranteed to have seen. Built by hand so no client is assumed, and so
 * the ordering is stated here rather than inherited from one.
 */
function multipart(
  fields: Readonly<Record<string, string>>,
  bytes: Buffer,
  fileName: string,
  contentType: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----openbrfDocumentBoundary";
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

interface DocumentBody {
  id: string;
  title: string;
  category: string;
  audience: "BOARD" | "MEMBER" | "PUBLIC";
  fileName: string;
  url: string;
}

async function fileDocument(
  cookie: string,
  fields: { title: string; category: string; audience: string },
  bytes: Buffer = pdfBytes(),
  fileName = "stadgar.pdf",
  contentType = "application/pdf",
) {
  const body = multipart(fields, bytes, fileName, contentType);
  return inject({
    method: "POST",
    url: "/api/documents",
    payload: body.payload,
    headers: { ...body.headers, cookie },
  });
}

async function shelfOf(cookie: string): Promise<DocumentBody[]> {
  const response = await inject({
    method: "GET",
    url: "/api/documents",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as DocumentBody[];
}

let adminCookie: string;
let boardCookie: string;
let memberCookie: string;
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
      { id: admin.personId, firstName: "Alma", lastName: `Arkiv${suffix}` },
      { id: boardMember.personId, firstName: "Bo", lastName: `Arkiv${suffix}` },
      { id: member.personId, firstName: "Maja", lastName: `Arkiv${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Arkiv${suffix}` },
    ],
  });

  await prisma.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
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
      street: `Arkivgatan ${suffix}`,
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
      {
        personId: resident.personId,
        apartmentId,
        role: "RESIDENT",
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

  adminCookie = await signIn(admin.email);
  boardCookie = await signIn(boardMember.email);
  memberCookie = await signIn(member.email);
  residentCookie = await signIn(resident.email);
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
      "The documents suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        // The document rows go with their files, by the cascade on the
        // reference; deleting the files is therefore the whole cleanup.
        () =>
          prisma.mediaFile.deleteMany({
            where: { uploadedByPersonId: { in: personIds } },
          }),
        () =>
          prisma.document.deleteMany({
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

describe("filing a document", () => {
  it("is the board's to do, and nobody else's", async () => {
    const asMember = await fileDocument(memberCookie, {
      title: "Stadgar",
      category: "Stadgar",
      audience: "PUBLIC",
    });
    const anonymous = await fileDocument("", {
      title: "Stadgar",
      category: "Stadgar",
      audience: "PUBLIC",
    });

    expect(asMember.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
  });

  it("accepts a PDF and answers with the path the file is served from", async () => {
    const response = await fileDocument(boardCookie, {
      title: `Stadgar ${suffix}`,
      category: "Stadgar",
      audience: "PUBLIC",
    });

    expect(response.statusCode).toBe(201);
    const document = response.json() as DocumentBody;
    expect(document.url).toMatch(/^\/api\/media\/[\w-]+$/);
    expect(document.fileName).toBe("stadgar.pdf");
  });

  it("refuses a file that is not a document, whatever it is named", async () => {
    const response = await fileDocument(
      boardCookie,
      { title: "Stadgar", category: "Stadgar", audience: "PUBLIC" },
      // A PDF header with nothing closing it, declared as a PDF: the bytes
      // decide, and these are not a document.
      Buffer.from("%PDF-1.7 and then something else entirely", "utf8"),
      "stadgar.pdf",
      "application/pdf",
    );

    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason: string }).reason).toBe(
      "unsupported-type",
    );
  });

  it("refuses a request that names no audience", async () => {
    const response = await fileDocument(boardCookie, {
      title: "Stadgar",
      category: "Stadgar",
      audience: "",
    });

    expect(response.statusCode).toBe(400);
  });

  it("records nothing about identifiable persons for a document", async () => {
    const response = await fileDocument(boardCookie, {
      title: `Trivselregler ${suffix}`,
      category: "Trivselregler",
      audience: "MEMBER",
    });
    const document = response.json() as DocumentBody;
    const fileId = document.url.split("/").pop() ?? "";

    // The declaration ties a photograph to a publication consent. A document
    // has no face in it to declare, and the column says so by being null
    // rather than by holding an answer nobody gave.
    const stored = await prisma.mediaFile.findUnique({
      where: { id: fileId },
    });
    expect(stored?.showsIdentifiablePersons).toBeNull();
    expect(stored?.contentType).toBe("application/pdf");
  });

  it("refuses an image, which belongs to the pages that ask for one", async () => {
    // The archive asks the media layer for a document, so a photograph is
    // refused outright rather than stored as one - and refused for what it is
    // rather than for the declaration a document has nowhere to carry.
    const response = await fileDocument(
      boardCookie,
      { title: "Fasad", category: "Bilder", audience: "PUBLIC" },
      pngBytes(20, 20),
      "fasad.png",
      "image/png",
    );

    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason: string }).reason).toBe(
      "unsupported-type",
    );
  });
});

describe("what each principal is shown, and what each may fetch", () => {
  let board: DocumentBody;
  let members: DocumentBody;
  let published: DocumentBody;

  beforeAll(async () => {
    board = (
      await fileDocument(adminCookie, {
        title: `Styrelseprotokoll ${suffix}`,
        category: "Protokoll",
        audience: "BOARD",
      })
    ).json() as DocumentBody;
    members = (
      await fileDocument(adminCookie, {
        title: `Stämmoprotokoll ${suffix}`,
        category: "Protokoll",
        audience: "MEMBER",
      })
    ).json() as DocumentBody;
    published = (
      await fileDocument(adminCookie, {
        title: `Stadgar ${suffix}`,
        category: "Stadgar",
        audience: "PUBLIC",
      })
    ).json() as DocumentBody;
  }, 60_000);

  const titles = (shelf: DocumentBody[]) => shelf.map((entry) => entry.title);

  it("shows the board all three shelves", async () => {
    expect(titles(await shelfOf(boardCookie))).toEqual(
      expect.arrayContaining([board.title, members.title, published.title]),
    );
  });

  it("keeps the board's own shelf from a member", async () => {
    const shelf = titles(await shelfOf(memberCookie));

    expect(shelf).toEqual(
      expect.arrayContaining([members.title, published.title]),
    );
    expect(shelf).not.toContain(board.title);
  });

  it("keeps the member shelf from a resident who is not a member", async () => {
    const shelf = titles(await shelfOf(residentCookie));

    expect(shelf).toContain(published.title);
    expect(shelf).not.toContain(members.title);
    expect(shelf).not.toContain(board.title);
  });

  it("refuses the archive to a caller with no session at all", async () => {
    expect(
      (await inject({ method: "GET", url: "/api/documents" })).statusCode,
    ).toBe(401);
  });

  it("serves a published document to a visitor with no session, and sets no cookie", async () => {
    const response = await inject({ method: "GET", url: published.url });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    // The media route is shared with the association's logo on the public
    // website. A file served to the street must not start a session.
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("answers a board document to a member exactly as a file that does not exist", async () => {
    const asMember = await inject({
      method: "GET",
      url: board.url,
      headers: { cookie: memberCookie },
    });
    const missing = await inject({
      method: "GET",
      url: "/api/media/en-fil-som-aldrig-funnits",
      headers: { cookie: memberCookie },
    });

    expect(asMember.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(asMember.body).toBe(missing.body);
  });

  it("serves a member document to a member", async () => {
    const response = await inject({
      method: "GET",
      url: members.url,
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
  });

  it("keeps a member document from a resident who is not a member", async () => {
    /*
     * The audience enforced on the bytes rather than only on the shelf. The
     * list already leaves the minutes off this resident's shelf; this is the
     * other half, and the half that survives somebody passing on the address.
     * Minutes of a general meeting name the members who spoke and how they
     * voted, and not every resident is a member.
     */
    const asResident = await inject({
      method: "GET",
      url: members.url,
      headers: { cookie: residentCookie },
    });
    const missing = await inject({
      method: "GET",
      url: "/api/media/en-fil-som-aldrig-funnits",
      headers: { cookie: residentCookie },
    });

    expect(asResident.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // Byte for byte, so holding the address teaches nothing about whether the
    // association has a file at it.
    expect(asResident.body).toBe(missing.body);
  });

  it("refuses a member document to a caller with no session at all", async () => {
    expect((await inject({ method: "GET", url: members.url })).statusCode).toBe(
      404,
    );
  });

  it("serves a member document to the board and to an administrator", async () => {
    // Neither holds a residency in this fixture, so neither is a member. They
    // read it through documents:manage, which on a member file widens rather
    // than narrows - the archive lists the document to both of them, and the
    // link under it has to work.
    const asBoard = await inject({
      method: "GET",
      url: members.url,
      headers: { cookie: boardCookie },
    });
    const asAdmin = await inject({
      method: "GET",
      url: members.url,
      headers: { cookie: adminCookie },
    });

    expect(asBoard.statusCode).toBe(200);
    expect(asAdmin.statusCode).toBe(200);
  });

  it("keeps the serve of a member document out of the audit log", async () => {
    const fileId = members.url.split("/").pop() ?? "";
    const before = await prisma.auditLogEntry.count({
      where: { action: "MEDIA_ACCESSED", targetId: fileId },
    });

    expect(
      (
        await inject({
          method: "GET",
          url: members.url,
          headers: { cookie: memberCookie },
        })
      ).statusCode,
    ).toBe(200);

    /*
     * Narrowed and deliberately not recorded, which is the one place the
     * archive's two narrowed audiences part company. The board's papers are
     * few and opened rarely, so a row each is accountability; the members read
     * the bylaws, the annual report and every set of minutes as a matter of
     * course, and a row each would be a permanent record - in a table the
     * purge cannot reach - of which member read which document when.
     */
    const after = await prisma.auditLogEntry.count({
      where: { action: "MEDIA_ACCESSED", targetId: fileId },
    });
    expect(after).toBe(before);
  });

  it("writes every serve of a board document to the audit log", async () => {
    const fileId = board.url.split("/").pop() ?? "";
    const before = await prisma.auditLogEntry.count({
      where: { action: "MEDIA_ACCESSED", targetId: fileId },
    });

    const response = await inject({
      method: "GET",
      url: board.url,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);

    /*
     * The whole reason a board document is narrowed by capability rather than
     * merely marked internal: the media service records MEDIA_ACCESSED for the
     * files whose access is narrowed, so accountability for the board's own
     * papers comes from the serving path rather than from a second route this
     * module would have had to write.
     */
    const after = await prisma.auditLogEntry.count({
      where: {
        action: "MEDIA_ACCESSED",
        targetId: fileId,
        actorPersonId: boardMember.personId,
      },
    });
    expect(after).toBe(before + 1);
  });
});

describe("changing who a document is for", () => {
  it("takes the file off the street in the same breath as the shelf", async () => {
    const document = (
      await fileDocument(boardCookie, {
        title: `Årsredovisning ${suffix}`,
        category: "Årsredovisning",
        audience: "PUBLIC",
      })
    ).json() as DocumentBody;

    const open = await inject({ method: "GET", url: document.url });
    expect(open.statusCode).toBe(200);

    const changed = await inject({
      method: "PUT",
      url: `/api/documents/${document.id}`,
      payload: {
        title: document.title,
        category: document.category,
        audience: "BOARD",
      },
      headers: { cookie: boardCookie },
    });
    expect(changed.statusCode).toBe(200);

    // The demotion the archive exists to get right. A document taken off the
    // public shelf whose file stayed PUBLIC would still be fetchable by anyone
    // who had seen its address while it was published.
    const closed = await inject({ method: "GET", url: document.url });
    expect(closed.statusCode).toBe(404);

    const toMember = await inject({
      method: "GET",
      url: document.url,
      headers: { cookie: memberCookie },
    });
    expect(toMember.statusCode).toBe(404);
  });

  it("takes a published document off the street when it goes to the members", async () => {
    const document = (
      await fileDocument(boardCookie, {
        title: `Stämmoprotokoll ${suffix}-2`,
        category: "Protokoll",
        audience: "PUBLIC",
      })
    ).json() as DocumentBody;

    expect(
      (await inject({ method: "GET", url: document.url })).statusCode,
    ).toBe(200);

    const changed = await inject({
      method: "PUT",
      url: `/api/documents/${document.id}`,
      payload: {
        title: document.title,
        category: document.category,
        audience: "MEMBER",
      },
      headers: { cookie: boardCookie },
    });
    expect(changed.statusCode).toBe(200);

    // No session at all, and a session that is not a member's: both closed by
    // the same write, in the transaction that moved the shelf.
    expect(
      (await inject({ method: "GET", url: document.url })).statusCode,
    ).toBe(404);
    expect(
      (
        await inject({
          method: "GET",
          url: document.url,
          headers: { cookie: residentCookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await inject({
          method: "GET",
          url: document.url,
          headers: { cookie: memberCookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("is refused to a member, who can neither rename nor remove", async () => {
    const document = (
      await fileDocument(boardCookie, {
        title: `Trivselregler ${suffix}-2`,
        category: "Trivselregler",
        audience: "PUBLIC",
      })
    ).json() as DocumentBody;

    const renamed = await inject({
      method: "PUT",
      url: `/api/documents/${document.id}`,
      payload: {
        title: "Något annat",
        category: "Stadgar",
        audience: "PUBLIC",
      },
      headers: { cookie: memberCookie },
    });
    const removed = await inject({
      method: "DELETE",
      url: `/api/documents/${document.id}`,
      headers: { cookie: memberCookie },
    });

    expect(renamed.statusCode).toBe(403);
    expect(removed.statusCode).toBe(403);
  });

  it("answers a document that is not there with a refusal, not a silence", async () => {
    const response = await inject({
      method: "PUT",
      url: "/api/documents/ett-dokument-som-aldrig-funnits",
      payload: { title: "Stadgar", category: "Stadgar", audience: "PUBLIC" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { reason: string }).reason).toBe("not-found");
  });
});

describe("removing a document", () => {
  it("takes the bytes with it", async () => {
    const document = (
      await fileDocument(boardCookie, {
        title: `Protokoll ${suffix}-borttaget`,
        category: "Protokoll",
        audience: "MEMBER",
      })
    ).json() as DocumentBody;
    const fileId = document.url.split("/").pop() ?? "";

    const response = await inject({
      method: "DELETE",
      url: `/api/documents/${document.id}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);

    expect(
      await prisma.document.findUnique({ where: { id: document.id } }),
    ).toBeNull();
    expect(
      await prisma.mediaFile.findUnique({ where: { id: fileId } }),
    ).toBeNull();
    expect(
      (await inject({ method: "GET", url: document.url })).statusCode,
    ).toBe(404);
  });
});

describe("the audience a document gets when nobody names one", () => {
  it("is the members, which is where minutes belong", async () => {
    /*
     * Written straight into the table on purpose. Every endpoint requires an
     * audience, so this is the only way to ask what the column itself decides
     * - and the column is the last line of the guardrail: a writer added later
     * that forgot to state an audience must not put a set of minutes on the
     * street. The file is a row without bytes, which is all this needs: the
     * document is never served.
     */
    const file = await prisma.mediaFile.create({
      data: {
        storageKey: `documents/default-${suffix}`,
        contentType: "application/pdf",
        byteSize: 1,
        checksum: "0".repeat(64),
        fileName: "protokoll.pdf",
        visibility: "INTERNAL",
        uploadedByPersonId: boardMember.personId,
      },
    });

    const document = await prisma.document.create({
      data: {
        title: `Protokoll ${suffix}-standard`,
        category: "Protokoll",
        mediaFileId: file.id,
        uploadedByPersonId: boardMember.personId,
      },
    });

    expect(document.audience).toBe("MEMBER");
  });
});
