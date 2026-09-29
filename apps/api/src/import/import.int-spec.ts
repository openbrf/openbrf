import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { buildWorkbook } from "../testing/xlsx-fixture";
import { writeCsv } from "./csv";
import { IMPORT_CHUNK_ROWS, ImportApplyService } from "./import-apply.service";
import type { ImportField } from "./import-columns";
import type { ImportRunView } from "./import-run";
import {
  type ImportPreview,
  ImportService,
  type ImportSessionView,
} from "./import.service";

/**
 * The import from upload to applied register, against a real database and a
 * real job queue.
 *
 * The CSV path runs end to end because that is the one a board actually uses;
 * the Excel path is verified as far as the parsed rows, which is where the two
 * paths converge. Both are required (plan exit criterion 7).
 *
 * The assertions that matter are the ones a smaller test would skip: that the
 * match-key precedence reaches the person the row is about rather than making a
 * second copy of them, that an ambiguous row stops the import until a human
 * decides, that contact data lands encrypted and still searchable, that a member
 * row writes the statutory register entry - and that the apply, which is a
 * chunked background job, gets there through the queue, survives being
 * interrupted between chunks, writes nothing twice when it resumes, and tells a
 * refusal it can only record apart from a failure a retry could survive.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let applies: ImportApplyService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const surname = `Impman${suffix}`;

const addressId = `imp-address-${suffix}`;
const addressLabel = `Impgatan ${suffix}`;
const apartments = {
  a: `imp-apartment-a-${suffix}`,
  b: `imp-apartment-b-${suffix}`,
  c: `imp-apartment-c-${suffix}`,
  d: `imp-apartment-d-${suffix}`,
  /** The apartment the overlapping move-in case imports into. */
  e: `imp-apartment-e-${suffix}`,
  /** The one the move-in it overlaps takes. */
  f: `imp-apartment-f-${suffix}`,
  /** Where the rows that contradict the person they matched are imported. */
  g: `imp-apartment-g-${suffix}`,
  /** Where a row gives a register person an address a later row also has. */
  h: `imp-apartment-h-${suffix}`,
};

const actors = {
  board: {
    personId: `imp-board-${suffix}`,
    email: `imp-board-${suffix}@exempel.se`,
  },
  resident: {
    personId: `imp-resident-${suffix}`,
    email: `imp-resident-${suffix}@exempel.se`,
  },
  /** Already in the register; a row must match them by email, not duplicate them. */
  existing: {
    personId: `imp-existing-${suffix}`,
    email: `imp-existing-${suffix}@exempel.se`,
  },
  /** Two people of the same name in one apartment: the ambiguous case. */
  twinA: { personId: `imp-twin-a-${suffix}` },
  twinB: { personId: `imp-twin-b-${suffix}` },
  /** Already in the register, and moving in while their row is applied. */
  mover: {
    personId: `imp-mover-${suffix}`,
    email: `imp-mover-${suffix}@exempel.se`,
  },
} as const;

const twinFirstName = "Dubbel";
const newcomerEmail = `imp-nina-${suffix}@exempel.se`;
/** A second newcomer, used by the concurrent-apply case and nowhere else. */
const raceEmail = `imp-race-${suffix}@exempel.se`;

const personIds = [
  actors.board.personId,
  actors.resident.personId,
  actors.existing.personId,
  actors.twinA.personId,
  actors.twinB.personId,
];

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": `10.8.0.${String(ipCounter % 250)}`,
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

async function createPerson(input: {
  personId: string;
  firstName: string;
  lastName?: string;
  email?: string;
  identityNumber?: string;
}): Promise<void> {
  const email =
    input.email === undefined
      ? null
      : await encryption.encrypt("person.email", input.email);
  const identityNumber =
    input.identityNumber === undefined
      ? null
      : await encryption.encrypt(
          "person.personalIdentityNumber",
          input.identityNumber,
        );
  await prisma.person.create({
    data: {
      id: input.personId,
      firstName: input.firstName,
      lastName: input.lastName ?? surname,
      emailCipher: email?.cipher ?? null,
      emailIndex: email?.index ?? null,
      personalIdentityNumberCipher: identityNumber?.cipher ?? null,
      personalIdentityNumberIndex: identityNumber?.index ?? null,
      preferredLocale: "sv",
    },
  });
}

/** The header row of the fixture, in the titles a Swedish export produces. */
const HEADERS = [
  "Adress",
  "Lägenhetsnummer",
  "Förnamn",
  "Efternamn",
  "Roll",
  "E-postadress",
  "Telefon",
  "Inflyttningsdatum",
];

const EXPECTED_MAPPING: (ImportField | null)[] = [
  "addressLabel",
  "apartmentNumber",
  "firstName",
  "lastName",
  "role",
  "email",
  "phone",
  "movedInOn",
];

function fixtureRows(): string[][] {
  return [
    HEADERS,
    // A new member: creates a person, a residency and a register entry.
    [
      addressLabel,
      "2101",
      "Nina",
      surname,
      "Medlem",
      newcomerEmail,
      "070-111 00 11",
      "2021-04-01",
    ],
    // Already in the register, and identified by the email blind index.
    [
      addressLabel,
      "2102",
      "Existing",
      surname,
      "Boende",
      actors.existing.email,
      "",
      "2020-01-01",
    ],
    // Two people of this name live in 2103, so nothing may pick one.
    [
      addressLabel,
      "2103",
      twinFirstName,
      surname,
      "Boende",
      "",
      "",
      "2019-01-01",
    ],
    // No such apartment.
    [addressLabel, "9999", "Fel", surname, "Medlem", "", "", "2019-01-01"],
    // A date nobody can read unambiguously.
    [addressLabel, "2104", "Datum", surname, "Medlem", "", "", "01/03/2020"],
  ];
}

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function upload(
  cookie: string,
  fileName: string,
  content: string,
): Promise<ImportSessionView> {
  const response = await inject({
    method: "POST",
    url: "/api/import/sessions",
    payload: { fileName, content },
    headers: { cookie },
  });
  expect(response.statusCode).toBe(201);
  return JSON.parse(response.body) as ImportSessionView;
}

/**
 * Uploads a file and previews it, which is what the apply now requires: the
 * import that runs is the one the board looked at.
 */
/**
 * True while a transaction is waiting for this one person's transition lock.
 *
 * This person's, not any: the suite shares its database, and a count of every
 * advisory wait in it would be answered by an unrelated test holding an
 * unrelated lock - which would release the move-in below early and let the case
 * pass without the chunk ever having waited for anything.
 *
 * Postgres addresses the advisory lock space with a 64-bit key and reports it
 * split: the high half in classid, the low half in objid, and objsubid 1 for
 * the one-argument form the lock is taken with. hashtext returns an int4 that
 * the lock function widens to that key, so a negative hash sign-extends and its
 * high half comes back as all ones - which is why both halves are masked out of
 * the key rather than assumed to be zero.
 */
async function waitsForTransitionLock(personId: string): Promise<boolean> {
  const key = `residency:${personId}`;
  const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
    SELECT count(*) AS waiting
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND NOT granted
      AND objsubid = 1
      AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
      AND objid = (hashtext(${key})::bigint & 4294967295)::oid`;
  return (row?.waiting ?? 0n) > 0n;
}

/** Polls until the condition holds, or gives up so a failure is a failure. */
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the chunk to block or finish.");
}

async function uploadAndPreview(
  cookie: string,
  fileName: string,
  rows: string[][],
): Promise<ImportSessionView> {
  const session = await upload(cookie, fileName, encode(writeCsv(rows)));
  const response = await inject({
    method: "POST",
    url: `/api/import/sessions/${session.sessionId}/preview`,
    payload: { mapping: session.suggestedMapping },
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return session;
}

function applyImport(
  cookie: string,
  sessionId: string,
  decisions: Record<string, unknown> = {},
) {
  return inject({
    method: "POST",
    url: `/api/import/sessions/${sessionId}/apply`,
    payload: { decisions },
    headers: { cookie },
  });
}

async function readRun(
  cookie: string,
  sessionId: string,
): Promise<ImportRunView> {
  const response = await inject({
    method: "GET",
    url: `/api/import/sessions/${sessionId}/run`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as ImportRunView;
}

/**
 * Waits for the job to reach a state, by re-reading the run the screen reads.
 *
 * There is no other honest way to wait for it: the apply happens in a worker,
 * and the session row is the only place its progress exists.
 */
async function waitForRun(
  cookie: string,
  sessionId: string,
  until: (run: ImportRunView) => boolean,
  timeoutMs = 45_000,
): Promise<ImportRunView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await readRun(cookie, sessionId);
    if (until(run)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Import ${sessionId} stayed ${run.status} at ` +
          `${String(run.rowsDone)}/${String(run.rowsTotal)} rows`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * A file longer than one chunk, so the apply has to take more than one.
 *
 * One real row at the start and one past the chunk boundary, so both chunks
 * write a person and a statutory entry; everything between them carries a date
 * nobody can read, which counts as a row with a problem and writes nothing. That
 * keeps the file long without leaving a hundred people in a register that
 * refuses to have rows removed.
 */
function longFixture(prefix: string): string[][] {
  const rows: string[][] = [HEADERS];
  const total = IMPORT_CHUNK_ROWS + 20;

  for (let rowNumber = 1; rowNumber <= total; rowNumber++) {
    if (rowNumber === 1) {
      rows.push([
        addressLabel,
        "2101",
        `${prefix}First`,
        surname,
        "Medlem",
        "",
        "",
        "2021-04-01",
      ]);
    } else if (rowNumber === IMPORT_CHUNK_ROWS + 1) {
      rows.push([
        addressLabel,
        "2104",
        `${prefix}Last`,
        surname,
        "Medlem",
        "",
        "",
        "2021-05-01",
      ]);
    } else {
      rows.push([
        addressLabel,
        "2101",
        `${prefix}Bad${String(rowNumber)}`,
        surname,
        "Medlem",
        "",
        "",
        "01/03/2020",
      ]);
    }
  }

  return rows;
}

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
  encryption = app.get(FieldEncryptionService);
  applies = app.get(ImportApplyService);

  // The apply is a background job, so the queue and its worker are what make
  // these tests test anything: an import that is only enqueued writes no
  // register. Started here rather than at boot, which the API deliberately does
  // not do under test.
  await applies.startApplyWorker();

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Impgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 930,
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartments.a, addressId, number: "2101", floor: 1 },
      { id: apartments.b, addressId, number: "2102", floor: 1 },
      { id: apartments.c, addressId, number: "2103", floor: 1 },
      { id: apartments.d, addressId, number: "2104", floor: 1 },
      { id: apartments.e, addressId, number: "2105", floor: 1 },
      { id: apartments.f, addressId, number: "2106", floor: 1 },
      { id: apartments.g, addressId, number: "2107", floor: 1 },
      { id: apartments.h, addressId, number: "2108", floor: 1 },
    ],
  });

  await createPerson({
    personId: actors.board.personId,
    firstName: "Bea",
    email: actors.board.email,
  });
  await createPerson({
    personId: actors.resident.personId,
    firstName: "Rita",
    email: actors.resident.email,
  });
  await createPerson({
    personId: actors.existing.personId,
    firstName: "Existing",
    email: actors.existing.email,
  });
  await createPerson({
    personId: actors.mover.personId,
    firstName: "Mover",
    email: actors.mover.email,
  });
  await createPerson({
    personId: actors.twinA.personId,
    firstName: twinFirstName,
  });
  await createPerson({
    personId: actors.twinB.personId,
    firstName: twinFirstName,
  });

  await prisma.residency.createMany({
    data: [
      {
        personId: actors.resident.personId,
        apartmentId: apartments.a,
        role: "RESIDENT",
        movedInOn: new Date("2022-01-01T00:00:00.000Z"),
      },
      {
        personId: actors.twinA.personId,
        apartmentId: apartments.c,
        role: "RESIDENT",
        movedInOn: new Date("2018-01-01T00:00:00.000Z"),
      },
      {
        personId: actors.twinB.personId,
        apartmentId: apartments.c,
        role: "RESIDENT",
        movedInOn: new Date("2018-01-01T00:00:00.000Z"),
      },
    ],
  });

  await prisma.boardPosition.create({
    data: {
      personId: actors.board.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15T00:00:00.000Z"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [actors.board, actors.resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
}, 180_000);

afterAll(async () => {
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.residency.deleteMany({
    where: { apartmentId: { in: Object.values(apartments) } },
  });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.importSession.deleteMany({
    where: { createdById: actors.board.personId },
  });
  // The fixture persons hold no member register entry, so they go: an
  // integration suite shares its database, and rows left behind accumulate on
  // every run. What stays is what the archive names - the persons the imports
  // created, apartments `a` and `d` that their ENTRY rows point at, and the
  // address those belong to. The archive is append-only and its foreign keys
  // are what keep it readable.
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  // A person an import created and no register entry names is not archive
  // content either, so they go the same way rather than accumulating on every
  // run of the suite.
  await prisma.person.deleteMany({
    where: { lastName: surname, memberRegisterEntries: { none: {} } },
  });
  await prisma.apartment.deleteMany({
    where: {
      id: { in: [apartments.b, apartments.c, apartments.g, apartments.h] },
    },
  });
  await app.close();
});

describe("who may import", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/import/sessions",
      payload: { fileName: "medlemmar.csv", content: encode("a;b\n1;2") },
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/import/sessions",
      payload: { fileName: "medlemmar.csv", content: encode("a;b\n1;2") },
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("the template", () => {
  it("is a spreadsheet the board can open and fill in", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/import/template",
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("attachment");
    // The byte order mark is what makes Excel read the Swedish titles as UTF-8.
    expect(response.body.startsWith("﻿")).toBe(true);
    expect(response.body).toContain("Lägenhetsnummer");
  });
});

describe("uploading a CSV", () => {
  it("reads the columns and guesses the mapping from their titles", async () => {
    const session = await upload(
      await signIn(actors.board.email),
      "medlemmar.csv",
      encode(writeCsv(fixtureRows())),
    );

    expect(session.format).toBe("CSV");
    expect(session.columns).toEqual(HEADERS);
    expect(session.rowCount).toBe(5);
    expect(session.suggestedMapping).toEqual(EXPECTED_MAPPING);
    // The sample exists so a column can be recognised by what is in it.
    expect(session.sample[0]?.[2]).toBe("Nina");
  });

  it("refuses a file with nothing under its column titles", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/import/sessions",
      payload: { fileName: "tom.csv", content: encode("Adress;Lgh\n") },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "file-empty",
    );
  });
});

describe("uploading an Excel workbook", () => {
  it("reads the same rows out of a real xlsx", async () => {
    // The workbook is built here rather than committed as a binary blob, so the
    // fixture stays readable in a diff.
    const workbook = buildWorkbook(fixtureRows(), "Medlemmar");
    const session = await upload(
      await signIn(actors.board.email),
      "medlemmar.xlsx",
      workbook.toString("base64"),
    );

    expect(session.format).toBe("XLSX");
    expect(session.columns).toEqual(HEADERS);
    expect(session.rowCount).toBe(5);
    expect(session.suggestedMapping).toEqual(EXPECTED_MAPPING);
    expect(session.sample[1]?.[5]).toBe(actors.existing.email);
  });

  it("reads a workbook whose name claims it is a CSV", async () => {
    // The content decides, not the extension: read as text it would be one
    // column of mojibake rather than an error the board can act on.
    const session = await upload(
      await signIn(actors.board.email),
      "medlemmar.csv",
      buildWorkbook(fixtureRows()).toString("base64"),
    );

    expect(session.format).toBe("XLSX");
  });
});

describe("previewing", () => {
  async function preview(): Promise<{
    session: ImportSessionView;
    value: ImportPreview;
    cookie: string;
  }> {
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(fixtureRows())),
    );
    const response = await inject({
      method: "POST",
      url: `/api/import/sessions/${session.sessionId}/preview`,
      payload: { mapping: session.suggestedMapping },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    return {
      session,
      cookie,
      value: JSON.parse(response.body) as ImportPreview,
    };
  }

  it("says what each row would do without doing any of it", async () => {
    const before = await prisma.person.count({ where: { lastName: surname } });
    const { value } = await preview();

    expect(value.summary).toEqual({
      create: 1,
      update: 1,
      ambiguous: 1,
      error: 2,
    });
    expect(await prisma.person.count({ where: { lastName: surname } })).toBe(
      before,
    );
  });

  it("matches a person already in the register through the email blind index", async () => {
    const { value } = await preview();
    const row = value.rows.find((candidate) => candidate.rowNumber === 2);

    expect(row?.outcome).toBe("update");
    expect(row?.matchedBy).toBe("email");
    expect(row?.matchedPersonId).toBe(actors.existing.personId);
  });

  it("flags two people of the same name for a human to decide", async () => {
    const { value } = await preview();
    const row = value.rows.find((candidate) => candidate.rowNumber === 3);

    expect(row?.outcome).toBe("ambiguous");
    expect(
      row?.candidates.map((candidate) => candidate.personId).sort(),
    ).toEqual([actors.twinA.personId, actors.twinB.personId].sort());
  });

  it("names what is wrong with a row rather than dropping it", async () => {
    const { value } = await preview();
    const missingApartment = value.rows.find((row) => row.rowNumber === 4);
    const badDate = value.rows.find((row) => row.rowNumber === 5);

    expect(missingApartment?.problems).toContainEqual({
      field: "addressLabel",
      reason: "apartment-not-found",
    });
    expect(badDate?.problems).toContainEqual({
      field: "movedInOn",
      reason: "date-not-iso",
    });
  });

  it("refuses a mapping that cannot identify a person", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(fixtureRows())),
    );
    const response = await inject({
      method: "POST",
      url: `/api/import/sessions/${session.sessionId}/preview`,
      payload: {
        mapping: session.suggestedMapping.map((field) =>
          field === "firstName" || field === "lastName" ? null : field,
        ),
      },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "mapping-invalid",
    );
  });
});

describe("applying", () => {
  it("refuses an import nobody has previewed", async () => {
    // The apply runs the mapping the preview was taken with, so applying
    // without one would run a mapping nobody looked at - into a register that
    // cannot be corrected by editing.
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(fixtureRows())),
    );

    const response = await applyImport(cookie, session.sessionId);

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "preview-required",
    );
  });

  it("refuses while a row still matches more than one person", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(
      cookie,
      "medlemmar.csv",
      fixtureRows(),
    );

    const response = await applyImport(cookie, session.sessionId);

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "ambiguous-rows-undecided",
    );
    // Refused before anything is queued: the session is still an upload waiting
    // for its mapping to be applied.
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
  });

  it("refuses a decision naming somebody the row did not match", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(
      cookie,
      "medlemmar.csv",
      fixtureRows(),
    );

    const response = await applyImport(cookie, session.sessionId, {
      "3": { action: "use-person", personId: actors.board.personId },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "decision-not-a-candidate",
    );
  });

  it("writes the register once the ambiguity is decided, and only once", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(
      cookie,
      "medlemmar.csv",
      fixtureRows(),
    );

    const response = await applyImport(cookie, session.sessionId, {
      "3": { action: "use-person", personId: actors.twinA.personId },
    });

    // Accepted, not done: the register write happens in a worker.
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body) as ImportRunView).toMatchObject({
      status: "QUEUED",
      rowsDone: 0,
      rowsTotal: 5,
    });

    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.rowsDone).toBe(5);
    expect(run.result).toEqual({
      personsCreated: 1,
      personsUpdated: 2,
      // The decided row's person already lives in 2103, so no second residency
      // is created for them.
      residenciesCreated: 2,
      memberRegisterEntriesCreated: 1,
      skipped: 0,
      errors: 2,
    });

    const created = await prisma.person.findFirstOrThrow({
      where: { firstName: "Nina", lastName: surname },
      select: {
        id: true,
        emailCipher: true,
        emailIndex: true,
        phoneCipher: true,
        residencies: { select: { apartmentId: true, role: true } },
        memberRegisterEntries: { select: { eventType: true } },
      },
    });

    // Contact data lands encrypted, not in plaintext, and still carries the
    // index that makes it findable (plan exit criterion 7).
    expect(created.emailCipher).not.toContain(newcomerEmail);
    expect(created.emailIndex).toBe(
      await encryption.computeIndex("person.email", newcomerEmail),
    );
    expect(created.phoneCipher).not.toBeNull();
    expect(created.residencies).toEqual([
      { apartmentId: apartments.a, role: "MEMBER" },
    ]);
    // A member row writes the statutory entry, in the same transaction.
    expect(created.memberRegisterEntries).toEqual([{ eventType: "ENTRY" }]);

    // Looked up the way the register looks a contact address up: by the blind
    // index computed from the plaintext, which is the only route to an
    // encrypted field (ADR 0002). An imported person the register cannot find
    // again is a person the board would import a second time.
    const found = await prisma.person.findFirstOrThrow({
      where: {
        emailIndex: await encryption.computeIndex(
          "person.email",
          newcomerEmail,
        ),
      },
      select: { id: true },
    });
    expect(found.id).toBe(created.id);

    // The existing person was matched rather than duplicated.
    expect(
      await prisma.person.count({
        where: { firstName: "Existing", lastName: surname },
      }),
    ).toBe(1);

    const repeat = await applyImport(cookie, session.sessionId, {
      "3": { action: "use-person", personId: actors.twinA.personId },
    });
    expect(repeat.statusCode).toBe(409);
    expect((JSON.parse(repeat.body) as { reason: string }).reason).toBe(
      "session-already-applied",
    );
  }, 60_000);

  it("is the import the screen finds again after a reload", async () => {
    // A board member who closes the tab has nothing left to ask with, so the
    // screen asks for the import itself rather than for a session it remembers.
    const cookie = await signIn(actors.board.email);

    const response = await inject({
      method: "GET",
      url: "/api/import/sessions/active",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const active = JSON.parse(response.body) as ImportRunView | null;
    expect(active?.status).toBe("APPLIED");
    expect(active?.fileName).toBe("medlemmar.csv");
  });
});

describe("two applies of one session", () => {
  it("queues the import once when they overlap", async () => {
    // A double-clicked button is enough to produce this. Both requests read a
    // session in MAPPING, and two queued jobs would each create the person, the
    // residency and the statutory ENTRY row. member_register_entry refuses
    // UPDATE and DELETE, so a member listed twice could only be answered with a
    // further correction entry - the session has to be claimed by a conditional
    // update, and nothing may be queued for the request that loses.
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(cookie, "en-rad.csv", [
      HEADERS,
      [
        addressLabel,
        "2104",
        "Race",
        surname,
        "Medlem",
        raceEmail,
        "",
        "2022-09-01",
      ],
    ]);

    const [first, second] = await Promise.all([
      applyImport(cookie, session.sessionId),
      applyImport(cookie, session.sessionId),
    ]);
    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([202, 409]);

    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.result.personsCreated).toBe(1);

    const created = await prisma.person.findMany({
      where: { firstName: "Race", lastName: surname },
      select: { id: true, memberRegisterEntries: { select: { id: true } } },
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.memberRegisterEntries).toHaveLength(1);
  }, 60_000);

  it("writes one chunk once when two workers race it", async () => {
    // The request-level claim is not the last line: a queue redelivers, a
    // restart re-queues, and two workers can reach the same session. They meet
    // at the cursor, which one of them claims inside the transaction that
    // writes, and the other finds moved.
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(cookie, "kapp.csv", [
      HEADERS,
      [addressLabel, "2101", "Kapp", surname, "Medlem", "", "", "2022-10-01"],
      [addressLabel, "2101", "KappBad", surname, "Medlem", "", "", "3/10/22"],
    ]);

    // Claimed here rather than through the endpoint, because the endpoint would
    // also queue it and the point of this case is two workers on one session.
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });

    await Promise.all([
      applies.applyNextChunk(session.sessionId),
      applies.applyNextChunk(session.sessionId),
    ]);

    const run = await readRun(cookie, session.sessionId);
    expect(run.status).toBe("APPLIED");
    expect(run.rowsDone).toBe(2);
    // Counted once, not twice: the chunk that lost the claim rolled back whole.
    expect(run.result.personsCreated).toBe(1);
    expect(run.result.errors).toBe(1);

    const created = await prisma.person.findMany({
      where: { firstName: "Kapp", lastName: surname },
      select: { id: true, memberRegisterEntries: { select: { id: true } } },
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.memberRegisterEntries).toHaveLength(1);
  }, 60_000);
});

describe("an apply overlapping a move", () => {
  it("waits for the move rather than reading round it", async () => {
    // Whether a member row begins a membership is decided by counting the
    // person's other tenant-ownerships, and the chunk reads that count before
    // the row that would answer it exists. A move-in for the same person
    // committing inside that window is invisible to the count, so the chunk
    // appends a second ENTRY - to a register that refuses UPDATE and DELETE,
    // where two tenant-ownerships are one membership and the mistake can only
    // be answered by a later correction row.
    //
    // The move-in is played out here as the transaction it is, rather than
    // through the service, because the case is about what the chunk sees while
    // that transaction is open: it holds the person's transition lock, writes
    // what a move-in writes, and does not commit until this test lets it. A
    // chunk that takes the same lock cannot read until then; one that does not
    // reads a register with no membership in it and writes the duplicate.
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(cookie, "flytt.csv", [
      HEADERS,
      [
        addressLabel,
        "2105",
        "Mover",
        surname,
        "Medlem",
        actors.mover.email,
        "",
        "2023-03-01",
      ],
    ]);
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const moveIn = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`residency:${actors.mover.personId}`}))`;
        await tx.residency.create({
          data: {
            personId: actors.mover.personId,
            apartmentId: apartments.f,
            role: "MEMBER",
            movedInOn: new Date("2023-03-01T00:00:00.000Z"),
          },
        });
        await tx.memberRegisterEntry.create({
          data: {
            personId: actors.mover.personId,
            apartmentId: apartments.f,
            eventType: "ENTRY",
            eventOn: new Date("2023-03-01T00:00:00.000Z"),
            recordedFirstName: "Mover",
            recordedLastName: surname,
          },
        });
        await held;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    let chunkSettled = false;
    const chunk = applies
      .applyNextChunk(session.sessionId)
      .finally(() => (chunkSettled = true));

    // Released only once the chunk can make no further progress on its own:
    // either it is waiting for this person's lock, which is the whole of the
    // fix, or it has finished without taking one, which is the defect. Waiting
    // on the state rather than on a duration keeps both outcomes deterministic.
    await waitFor(
      async () =>
        chunkSettled || (await waitsForTransitionLock(actors.mover.personId)),
    );
    release();
    await Promise.all([moveIn, chunk]);

    const entries = await prisma.memberRegisterEntry.findMany({
      where: { personId: actors.mover.personId },
      orderBy: { createdAt: "asc" },
      select: { eventType: true },
    });
    // Two tenant-ownerships, one membership, one ENTRY: the chunk read the
    // move-in's row because it waited for it.
    expect(
      await prisma.residency.count({
        where: { personId: actors.mover.personId },
      }),
    ).toBe(2);
    expect(entries.map((entry) => entry.eventType)).toEqual(["ENTRY"]);
  }, 60_000);
});

describe("an apply longer than one chunk", () => {
  it("runs to the end through the queue and reports its progress", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(
      cookie,
      "lang.csv",
      longFixture("Chunked"),
    );
    const total = IMPORT_CHUNK_ROWS + 20;

    expect((await applyImport(cookie, session.sessionId)).statusCode).toBe(202);

    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.rowsTotal).toBe(total);
    expect(run.rowsDone).toBe(total);
    // One person from the first chunk and one from the second, so both chunks
    // are known to have written rather than only counted them.
    expect(run.result.personsCreated).toBe(2);
    expect(run.result.memberRegisterEntriesCreated).toBe(2);
    expect(run.result.errors).toBe(total - 2);
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
  }, 120_000);

  it("resumes from the chunk it reached instead of starting again", async () => {
    // The state a killed process leaves: one chunk committed, the cursor where
    // it stopped, nothing running. What has to happen next is convergence -
    // the rest of the file written, and not one row of the first chunk written
    // a second time into a register that cannot have rows removed.
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(
      cookie,
      "avbruten.csv",
      longFixture("Resumed"),
    );
    const total = IMPORT_CHUNK_ROWS + 20;

    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });
    expect(await applies.applyNextChunk(session.sessionId)).toBe(true);

    const interrupted = await readRun(cookie, session.sessionId);
    expect(interrupted.status).toBe("APPLYING");
    expect(interrupted.rowsDone).toBe(IMPORT_CHUNK_ROWS);
    expect(interrupted.result.personsCreated).toBe(1);

    // What the API does as it comes up: everything unfinished goes back on the
    // queue, and the job reads the cursor rather than the file's first row.
    expect(await applies.resumeInterruptedApplies()).toBeGreaterThan(0);

    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.rowsDone).toBe(total);
    expect(run.result.personsCreated).toBe(2);
    expect(run.result.errors).toBe(total - 2);

    // The first chunk's member was written once, by the run that was
    // interrupted, and the resumed run did not write them again.
    const first = await prisma.person.findMany({
      where: { firstName: "ResumedFirst", lastName: surname },
      select: {
        residencies: { select: { id: true } },
        memberRegisterEntries: { select: { id: true } },
      },
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.residencies).toHaveLength(1);
    expect(first[0]?.memberRegisterEntries).toHaveLength(1);
  }, 120_000);
});

describe("an apply that fails", () => {
  it("records a refusal instead of spending its retries on it", async () => {
    // The mapping is stored with the session and read again by every chunk, so
    // a mapping that no longer fits the file is refused identically on every
    // attempt. Retrying it would make a board wait through five of them and
    // then read that the import was interrupted, which is not what happened:
    // it never started writing.
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(cookie, "koppling.csv", [
      HEADERS,
      [
        addressLabel,
        "2101",
        "Koppling",
        surname,
        "Medlem",
        "",
        "",
        "2022-11-01",
      ],
    ]);

    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: {
        // Claimed the way the endpoint claims it, but carrying a mapping that
        // has lost its apartment column: nothing in the file says which
        // apartment a row is about any more.
        status: "QUEUED",
        decisions: {},
        mapping: EXPECTED_MAPPING.map((field) =>
          field === "apartmentNumber" ? "" : (field ?? ""),
        ),
      },
    });

    // Resolves rather than rejects: a job that throws is a job the queue hands
    // out again, and this one has nothing left to try.
    await expect(applies.runApply(session.sessionId)).resolves.toBeUndefined();

    const run = await readRun(cookie, session.sessionId);
    expect(run.status).toBe("FAILED");
    // The reason the import actually had, not the one an exhausted job leaves.
    expect(run.failureReason).toBe("mapping-invalid");
    expect(run.finishedAt).not.toBeNull();
    expect(run.rowsDone).toBe(0);
    // Refused before the first row, so the register has nothing of this file.
    expect(
      await prisma.person.count({
        where: { firstName: "Koppling", lastName: surname },
      }),
    ).toBe(0);
  }, 60_000);

  it("keeps its retries for a failure another attempt could survive", async () => {
    // The other half of the same rule. A database that went away is what the
    // retries exist for: the job is thrown out of so the queue takes it again,
    // and the session is left as the next attempt needs to find it rather than
    // closed as a failure of the import.
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(cookie, "avbrott.csv", [
      HEADERS,
      [
        addressLabel,
        "2101",
        "Avbrott",
        surname,
        "Medlem",
        "",
        "",
        "2022-12-01",
      ],
    ]);
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });

    const gone = new Error("Connection terminated unexpectedly");
    const chunk = vi
      .spyOn(applies, "applyNextChunk")
      .mockRejectedValueOnce(gone);
    try {
      await expect(applies.runApply(session.sessionId)).rejects.toBe(gone);
    } finally {
      chunk.mockRestore();
    }

    const run = await readRun(cookie, session.sessionId);
    expect(run.status).toBe("QUEUED");
    expect(run.failureReason).toBeNull();
    expect(run.finishedAt).toBeNull();
  }, 60_000);
});

/**
 * Synthetic personal identity numbers, checksum-valid so the planner treats
 * them as indexable. Built rather than listed: what matters is how many
 * distinct ones the file carries.
 */
function identityNumbers(count: number, birthDate = "900101"): string[] {
  const numbers: string[] = [];
  for (let serial = 0; numbers.length < count; serial++) {
    const nine = `${birthDate}${String(serial).padStart(3, "0")}`;
    let sum = 0;
    for (let position = 0; position < 9; position++) {
      const digit = Number(nine[position]);
      const weighted = position % 2 === 0 ? digit * 2 : digit;
      sum += weighted > 9 ? weighted - 9 : weighted;
    }
    numbers.push(`${nine}${String((10 - (sum % 10)) % 10)}`);
  }
  return numbers;
}

describe("a file carrying personal identity numbers", () => {
  it("indexes them in the job and matches on them the next time", async () => {
    // The expensive half of an import: each index is 43.8 ms of Argon2id by
    // design (ADR 0002), which is why the apply is a job at all. What has to
    // hold is that the job pays it, stores what it computed, and that the
    // stored index is what a second import of the same people matches on
    // instead of creating them again.
    const cookie = await signIn(actors.board.email);
    const numbers = identityNumbers(3);
    const rows = [
      [...HEADERS, "Personnummer"],
      ...numbers.map((identityNumber, index) => [
        addressLabel,
        "2102",
        `Pin${String(index)}`,
        surname,
        "Boende",
        "",
        "",
        "2021-04-01",
        identityNumber,
      ]),
    ];

    const first = await uploadAndPreview(cookie, "personnummer.csv", rows);
    expect((await applyImport(cookie, first.sessionId)).statusCode).toBe(202);
    const firstRun = await waitForRun(
      cookie,
      first.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(firstRun.result.personsCreated).toBe(3);

    const created = await prisma.person.findMany({
      where: { lastName: surname, firstName: { startsWith: "Pin" } },
      orderBy: { firstName: "asc" },
      select: {
        firstName: true,
        personalIdentityNumberCipher: true,
        personalIdentityNumberIndex: true,
      },
    });
    expect(created).toHaveLength(3);
    for (const [index, person] of created.entries()) {
      const number = numbers[index] ?? "";
      // Encrypted, and findable only through the index computed from the
      // plaintext - which is the only route to an encrypted field (ADR 0002).
      expect(person.personalIdentityNumberCipher).not.toContain(number);
      expect(person.personalIdentityNumberIndex).toBe(
        await encryption.computeIndex("person.personalIdentityNumber", number),
      );
    }

    const second = await uploadAndPreview(cookie, "personnummer.csv", rows);
    expect((await applyImport(cookie, second.sessionId)).statusCode).toBe(202);
    const secondRun = await waitForRun(
      cookie,
      second.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(secondRun.result.personsCreated).toBe(0);
    expect(secondRun.result.personsUpdated).toBe(3);
    expect(
      await prisma.person.count({
        where: { lastName: surname, firstName: { startsWith: "Pin" } },
      }),
    ).toBe(3);
  }, 120_000);
});

describe("a row that contradicts the person it matched", () => {
  it("waits for the board instead of writing to that person", async () => {
    // Four people already in the register, one row each. The first two rows
    // reach their person through an email address or an apartment and a name
    // but carry someone else's identity number; the third reaches its person
    // through the identity number itself; the fourth reaches a person who has
    // no identity number through an email address alone.
    const cookie = await signIn(actors.board.email);
    const [emailOwner, rowForEmail, neighbour, rowForName, customer, stranger] =
      identityNumbers(6, "850615");
    const people = {
      byEmail: {
        personId: `imp-contra-email-${suffix}`,
        firstName: "Kontakt",
        email: `imp-contra-email-${suffix}@exempel.se`,
        identityNumber: emailOwner,
      },
      byName: {
        personId: `imp-contra-name-${suffix}`,
        firstName: "Grannen",
        identityNumber: neighbour,
      },
      byNumber: {
        personId: `imp-contra-number-${suffix}`,
        firstName: "Kund",
        identityNumber: customer,
      },
      withoutNumber: {
        personId: `imp-contra-none-${suffix}`,
        firstName: "Utan",
        email: `imp-contra-none-${suffix}@exempel.se`,
      },
    };
    for (const person of Object.values(people)) {
      await createPerson(person);
    }
    await prisma.residency.create({
      data: {
        personId: people.byName.personId,
        apartmentId: apartments.g,
        role: "RESIDENT",
        movedInOn: new Date("2018-01-01T00:00:00.000Z"),
      },
    });

    function row(
      firstName: string,
      email: string,
      identityNumber: string | undefined,
    ): string[] {
      return [
        addressLabel,
        "2107",
        firstName,
        surname,
        "Boende",
        email,
        "070-222 00 22",
        "2021-04-01",
        identityNumber ?? "",
      ];
    }
    const rows = [
      [...HEADERS, "Personnummer"],
      row("Kontakt", people.byEmail.email, rowForEmail),
      row("Grannen", "", rowForName),
      row("Kund", `imp-contra-number-${suffix}@exempel.se`, customer),
      row("Utan", people.withoutNumber.email, stranger),
    ];

    const session = await upload(
      cookie,
      "motsagelser.csv",
      encode(writeCsv(rows)),
    );
    const response = await inject({
      method: "POST",
      url: `/api/import/sessions/${session.sessionId}/preview`,
      payload: { mapping: session.suggestedMapping },
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const preview = JSON.parse(response.body) as ImportPreview;
    const planned = (rowNumber: number) =>
      preview.rows.find((candidate) => candidate.rowNumber === rowNumber);

    expect(planned(1)).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "email",
      matchedPersonId: null,
      mismatch: "personalIdentityNumber",
      candidates: [
        { personId: people.byEmail.personId, name: `Kontakt ${surname}` },
      ],
    });
    expect(planned(2)).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "apartmentAndName",
      matchedPersonId: null,
      mismatch: "personalIdentityNumber",
    });
    expect(planned(3)).toMatchObject({
      outcome: "update",
      matchedBy: "personalIdentityNumber",
      matchedPersonId: people.byNumber.personId,
      matchedPersonName: `Kund ${surname}`,
    });
    expect(planned(4)).toMatchObject({
      outcome: "update",
      matchedBy: "email",
      matchedPersonId: people.withoutNumber.personId,
    });

    // Undecided, the import does not start at all.
    expect((await applyImport(cookie, session.sessionId)).statusCode).toBe(400);

    expect(
      (
        await applyImport(cookie, session.sessionId, {
          "1": { action: "skip" },
          "2": { action: "skip" },
        })
      ).statusCode,
    ).toBe(202);
    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.result).toMatchObject({
      personsCreated: 0,
      personsUpdated: 2,
      skipped: 2,
    });

    const stored = async (personId: string) =>
      prisma.person.findUniqueOrThrow({
        where: { id: personId },
        select: {
          phoneCipher: true,
          personalIdentityNumberIndex: true,
          residencies: { select: { apartmentId: true } },
        },
      });
    const indexOf = (value: string | undefined) =>
      encryption.computeIndex("person.personalIdentityNumber", value ?? "");

    // The contradicted persons are exactly as they were.
    const byEmail = await stored(people.byEmail.personId);
    expect(byEmail.phoneCipher).toBeNull();
    expect(byEmail.residencies).toEqual([]);
    expect(byEmail.personalIdentityNumberIndex).toBe(await indexOf(emailOwner));
    const byName = await stored(people.byName.personId);
    expect(byName.phoneCipher).toBeNull();
    expect(byName.personalIdentityNumberIndex).toBe(await indexOf(neighbour));

    // An identity-number match still fills in what the register lacks.
    const byNumber = await stored(people.byNumber.personId);
    expect(byNumber.phoneCipher).not.toBeNull();
    expect(byNumber.residencies).toEqual([{ apartmentId: apartments.g }]);

    // An email match fills in contact details but never an identity number.
    const withoutNumber = await stored(people.withoutNumber.personId);
    expect(withoutNumber.phoneCipher).not.toBeNull();
    expect(withoutNumber.personalIdentityNumberIndex).toBeNull();
  }, 120_000);
});

describe("a row that contradicts a person an earlier row writes", () => {
  async function preview(
    cookie: string,
    fileName: string,
    rows: string[][],
  ): Promise<{ sessionId: string; preview: ImportPreview }> {
    const session = await upload(cookie, fileName, encode(writeCsv(rows)));
    const response = await inject({
      method: "POST",
      url: `/api/import/sessions/${session.sessionId}/preview`,
      payload: { mapping: session.suggestedMapping },
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return {
      sessionId: session.sessionId,
      preview: JSON.parse(response.body) as ImportPreview,
    };
  }

  it("is found by the preview when the two rows fall in different chunks", async () => {
    // The apply meets row 1's person in the register when it plans the second
    // chunk, and stops at a row that contradicts them. The preview has to find
    // that row too, or the import stops half written.
    const cookie = await signIn(actors.board.email);
    const [sharedNumber, otherNumber] = identityNumbers(2, "770312");
    const householdEmail = `imp-household-${suffix}@exempel.se`;
    const numberEmail = `imp-number-${suffix}@exempel.se`;
    const total = IMPORT_CHUNK_ROWS + 60;
    const row = (
      firstName: string,
      email: string,
      identityNumber: string,
      movedInOn = "2021-04-01",
    ) => [
      addressLabel,
      "2102",
      firstName,
      surname,
      "Boende",
      email,
      "",
      movedInOn,
      identityNumber,
    ];

    const rows: string[][] = [[...HEADERS, "Personnummer"]];
    for (let rowNumber = 1; rowNumber <= total; rowNumber++) {
      if (rowNumber === 1) {
        rows.push(row("Hushall", householdEmail, ""));
      } else if (rowNumber === 2) {
        rows.push(row("Nummer", numberEmail, sharedNumber ?? ""));
      } else if (rowNumber === 150) {
        // Row 1's address, somebody else's name.
        rows.push(row("Granne", householdEmail, ""));
      } else if (rowNumber === 151) {
        // Row 2's address and name, somebody else's identity number.
        rows.push(row("Nummer", numberEmail, otherNumber ?? ""));
      } else {
        rows.push(row(`Fyll${String(rowNumber)}`, "", "", "01/03/2020"));
      }
    }

    const { sessionId, preview: planned } = await preview(
      cookie,
      "delad-adress.csv",
      rows,
    );
    const at = (rowNumber: number) =>
      planned.rows.find((candidate) => candidate.rowNumber === rowNumber);
    expect(at(1)?.outcome).toBe("create");
    expect(at(150)).toMatchObject({
      outcome: "ambiguous",
      mismatch: "name",
      sameAsRowNumber: 1,
      candidates: [],
    });
    expect(at(151)).toMatchObject({
      outcome: "ambiguous",
      mismatch: "personalIdentityNumber",
      sameAsRowNumber: 2,
      candidates: [],
    });

    // Decided as a new person and as left out. Both still hold when the second
    // chunk meets the person row 1 or row 2 created as a candidate.
    expect(
      (
        await applyImport(cookie, sessionId, {
          "150": { action: "create" },
          "151": { action: "skip" },
        })
      ).statusCode,
    ).toBe(202);
    const run = await waitForRun(
      cookie,
      sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
      90_000,
    );
    expect(run.status).toBe("APPLIED");
    expect(run.failureReason).toBeNull();
    expect(run.result).toMatchObject({ personsCreated: 3, skipped: 1 });

    expect(
      await prisma.person.count({
        where: { lastName: surname, firstName: { in: ["Hushall", "Granne"] } },
      }),
    ).toBe(2);
    const numbered = await prisma.person.findMany({
      where: { lastName: surname, firstName: "Nummer" },
      select: { personalIdentityNumberIndex: true },
    });
    expect(numbered).toEqual([
      {
        personalIdentityNumberIndex: await encryption.computeIndex(
          "person.personalIdentityNumber",
          sharedNumber ?? "",
        ),
      },
    ]);
  }, 180_000);

  it("does not write a row to the register person an earlier row gave its address", async () => {
    // Row 1 reaches a person already in the register by apartment and name and
    // gives them an email address they did not have. Row 2 is somebody else
    // with that address. Folding it into row 1's person would give them row
    // 2's phone number, postal address and apartment.
    const cookie = await signIn(actors.board.email);
    const person = {
      personId: `imp-lone-${suffix}`,
      firstName: "Ensam",
    };
    await createPerson(person);
    await prisma.residency.create({
      data: {
        personId: person.personId,
        apartmentId: apartments.h,
        role: "RESIDENT",
        movedInOn: new Date("2018-01-01T00:00:00.000Z"),
      },
    });
    const email = `imp-lone-${suffix}@exempel.se`;

    const header = [...HEADERS, "Postadress", "Postnummer", "Postort"];
    const rows = [
      header,
      [
        addressLabel,
        "2108",
        "Ensam",
        surname,
        "Boende",
        email,
        "",
        "2018-01-01",
        "",
        "",
        "",
      ],
      [
        addressLabel,
        "2102",
        "Framling",
        surname,
        "Boende",
        email,
        "070-333 00 33",
        "2021-04-01",
        "Box 1",
        "11122",
        "Stockholm",
      ],
    ];

    const { sessionId, preview: planned } = await preview(
      cookie,
      "given-adress.csv",
      rows,
    );
    expect(planned.rows[0]).toMatchObject({
      outcome: "update",
      matchedBy: "apartmentAndName",
      matchedPersonId: person.personId,
    });
    expect(planned.rows[1]).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "email",
      mismatch: "name",
      matchedPersonId: null,
      candidates: [{ personId: person.personId, name: `Ensam ${surname}` }],
    });

    expect(
      (await applyImport(cookie, sessionId, { "2": { action: "create" } }))
        .statusCode,
    ).toBe(202);
    const run = await waitForRun(
      cookie,
      sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
    );
    expect(run.status).toBe("APPLIED");

    const stored = await prisma.person.findUniqueOrThrow({
      where: { id: person.personId },
      select: {
        emailIndex: true,
        phoneCipher: true,
        postalStreet: true,
        postalCode: true,
        postalCity: true,
        residencies: { select: { apartmentId: true } },
      },
    });
    // Row 1's address, and nothing of row 2's.
    expect(stored).toEqual({
      emailIndex: await encryption.computeIndex("person.email", email),
      phoneCipher: null,
      postalStreet: null,
      postalCode: null,
      postalCity: null,
      residencies: [{ apartmentId: apartments.h }],
    });
    expect(
      await prisma.person.count({
        where: { lastName: surname, firstName: "Framling" },
      }),
    ).toBe(1);
  }, 120_000);
});

describe("a row after one the board decided", () => {
  function reasonOf(response: { body: string }): string {
    return (JSON.parse(response.body) as { reason: string }).reason;
  }

  it("is refused at the apply rather than stopping it halfway", async () => {
    // Row 1 is one of the two Dubbels, and the board says which. The apply
    // then gives that twin row 1's address - and row 150, far down the file in
    // the second chunk, is somebody else with that address. Only the decision
    // makes it contradict anyone, so the preview could not show it. Found by the
    // chunk, it would stop the import with the first chunk already written.
    const cookie = await signIn(actors.board.email);
    const email = `imp-decided-${suffix}@exempel.se`;
    const total = IMPORT_CHUNK_ROWS + 60;
    const row = (
      apartment: string,
      firstName: string,
      address: string,
      movedInOn = "2021-04-01",
    ) => [
      addressLabel,
      apartment,
      firstName,
      surname,
      "Boende",
      address,
      "",
      movedInOn,
    ];

    const rows: string[][] = [HEADERS];
    for (let rowNumber = 1; rowNumber <= total; rowNumber++) {
      if (rowNumber === 1) {
        rows.push(row("2103", twinFirstName, email));
      } else if (rowNumber === 150) {
        rows.push(row("2102", "Okand", email));
      } else {
        rows.push(row("2102", `Beslut${String(rowNumber)}`, "", "01/03/2020"));
      }
    }

    const session = await upload(
      cookie,
      "beslutad-rad.csv",
      encode(writeCsv(rows)),
    );
    const preview = async (decisions: Record<string, unknown>) => {
      const response = await inject({
        method: "POST",
        url: `/api/import/sessions/${session.sessionId}/preview`,
        payload: { mapping: session.suggestedMapping, decisions },
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body) as ImportPreview;
    };

    const first = await preview({});
    expect(first.summary.ambiguous).toBe(1);
    expect(first.rows[0]?.outcome).toBe("ambiguous");
    expect(first.rows[149]?.outcome).toBe("create");

    const decided = {
      "1": { action: "use-person", personId: actors.twinA.personId },
    };
    const refused = await applyImport(cookie, session.sessionId, decided);
    expect(refused.statusCode).toBe(400);
    expect(reasonOf(refused)).toBe("ambiguous-rows-undecided");

    // Nothing was queued and nothing was written.
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
    expect(
      await prisma.person.findUniqueOrThrow({
        where: { id: actors.twinA.personId },
        select: { emailIndex: true },
      }),
    ).toEqual({ emailIndex: null });
    expect(
      await prisma.person.count({
        where: { lastName: surname, firstName: "Okand" },
      }),
    ).toBe(0);

    // Previewed again with the decision, row 150 is shown for what it is.
    const second = await preview(decided);
    expect(second.summary.ambiguous).toBe(2);
    expect(second.rows[149]).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "email",
      mismatch: "name",
      candidates: [
        {
          personId: actors.twinA.personId,
          name: `${twinFirstName} ${surname}`,
        },
      ],
    });

    const accepted = await applyImport(cookie, session.sessionId, {
      ...decided,
      "150": { action: "create" },
    });
    expect(accepted.statusCode).toBe(202);
    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
      90_000,
    );
    expect(run.status).toBe("APPLIED");
    expect(run.failureReason).toBeNull();
    expect(run.result).toMatchObject({ personsCreated: 1, personsUpdated: 1 });

    expect(
      await prisma.person.findUniqueOrThrow({
        where: { id: actors.twinA.personId },
        select: { emailIndex: true },
      }),
    ).toEqual({
      emailIndex: await encryption.computeIndex("person.email", email),
    });
  }, 180_000);

  it("is refused when a decision settles a row the preview asked about", async () => {
    // Both rows are a Dubbel of 2103 with the same address. Decided as a new
    // person, row 1 creates the Dubbel that address belongs to, and row 2 then
    // follows row 1 - which would drop the board's answer for row 2 without
    // anyone seeing that.
    const cookie = await signIn(actors.board.email);
    const email = `imp-settled-${suffix}@exempel.se`;
    const row = [
      addressLabel,
      "2103",
      twinFirstName,
      surname,
      "Boende",
      email,
      "",
      "2021-04-01",
    ];
    const session = await uploadAndPreview(cookie, "avgjord-rad.csv", [
      HEADERS,
      row,
      row,
    ]);

    const response = await applyImport(cookie, session.sessionId, {
      "1": { action: "create" },
      "2": { action: "use-person", personId: actors.twinB.personId },
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("preview-outdated");
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
    });
  });

  it("is refused when skips undo the decision the preview was taken with", async () => {
    // Previewed with row 1 given to a Dubbel, row 2 contradicts that twin and
    // is asked about. Skipping both leaves row 2 matching nobody, so it would
    // be created - the row the board skipped. The skips alone must not pass
    // for the plan that was previewed.
    const cookie = await signIn(actors.board.email);
    const email = `imp-skipped-${suffix}@exempel.se`;
    const row = (apartment: string, firstName: string) => [
      addressLabel,
      apartment,
      firstName,
      surname,
      "Boende",
      email,
      "",
      "2021-04-01",
    ];
    const session = await upload(
      cookie,
      "hoppade-rader.csv",
      encode(
        writeCsv([HEADERS, row("2103", twinFirstName), row("2102", "Hoppad")]),
      ),
    );
    const decided = {
      "1": { action: "use-person", personId: actors.twinB.personId },
    };
    const previewed = await inject({
      method: "POST",
      url: `/api/import/sessions/${session.sessionId}/preview`,
      payload: { mapping: session.suggestedMapping, decisions: decided },
      headers: { cookie },
    });
    expect(previewed.statusCode).toBe(200);
    expect(
      (JSON.parse(previewed.body) as ImportPreview).rows.map(
        (planned) => planned.outcome,
      ),
    ).toEqual(["ambiguous", "ambiguous"]);

    const response = await applyImport(cookie, session.sessionId, {
      "1": { action: "skip" },
      "2": { action: "skip" },
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("preview-outdated");
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
    expect(
      await prisma.person.count({
        where: { lastName: surname, firstName: "Hoppad" },
      }),
    ).toBe(0);
    expect(
      await prisma.person.findUniqueOrThrow({
        where: { id: actors.twinB.personId },
        select: { emailIndex: true },
      }),
    ).toEqual({ emailIndex: null });
  });
});

describe("expired uploads", () => {
  it("are deleted rather than left holding the member list", async () => {
    // Refusing an expired session is not the same as removing it: the row
    // still carries the uploaded rows, personal identity numbers included.
    const imports = app.get(ImportService);
    const expired = await prisma.importSession.create({
      data: {
        fileName: "gammal.csv",
        format: "CSV",
        columns: HEADERS,
        rowsCipher: (
          await encryption.encrypt("importSession.rows", JSON.stringify([]))
        ).cipher,
        rowCount: 0,
        createdById: actors.board.personId,
        expiresAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
    const current = await upload(
      await signIn(actors.board.email),
      "aktuell.csv",
      encode(writeCsv(fixtureRows())),
    );

    await imports.purgeExpiredSessions();

    expect(
      await prisma.importSession.findUnique({ where: { id: expired.id } }),
    ).toBeNull();
    // An upload still inside its lifetime is untouched: the board is in the
    // middle of mapping it.
    expect(
      await prisma.importSession.findUnique({
        where: { id: current.sessionId },
      }),
    ).not.toBeNull();
  });
});
