import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { buildWorkbook } from "../testing/xlsx-fixture";
import { writeCsv } from "./csv";
import { IMPORT_CHUNK_ROWS, ImportApplyService } from "./import-apply.service";
import type { ImportField } from "./import-columns";
import { MAX_IMPORT_ROWS, MAX_WORKBOOK_ENTRY_BYTES } from "./import-limits";
import { ImportPlannerService } from "./import-planner.service";
import {
  type ImportPreview,
  type ImportPreviewRun,
  ImportPreviewService,
  PREVIEW_PROGRESS_ROWS,
} from "./import-preview.service";
import type { ImportRunView } from "./import-run";
import { ImportService, type ImportSessionView } from "./import.service";
import { lockResidencyTransitions } from "../registers/residency-lock";
import {
  advisoryLockCount,
  blockedBehindResidencyApartmentCount,
  residencyApartmentLockCount,
  waitFor,
  waitingLockCount,
} from "../testing/advisory-locks";
import { lockApartmentResidencies } from "../registers/residency-lock";

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
let previews: ImportPreviewService;

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
  /** The out-of-order cases: two apartments per person, g to l. */
  g: `imp-apartment-g-${suffix}`,
  h: `imp-apartment-h-${suffix}`,
  i: `imp-apartment-i-${suffix}`,
  j: `imp-apartment-j-${suffix}`,
  k: `imp-apartment-k-${suffix}`,
  l: `imp-apartment-l-${suffix}`,
  /**
   * Where the rows that contradict the person they matched are imported, and
   * the register-changed-under-the-chunk and no-move-in-column cases.
   */
  m: `imp-apartment-m-${suffix}`,
  /** Where a row gives a register person an address a later row also has. */
  n: `imp-apartment-n-${suffix}`,
  /** Where a person is entered while a chunk is applied. */
  o: `imp-apartment-o-${suffix}`,
  /** Where somebody joins the candidates of a row the board decided. */
  p: `imp-apartment-p-${suffix}`,
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
  /** Holds the administrator grant: the one who may abandon an import. */
  admin: {
    personId: `imp-admin-${suffix}`,
    email: `imp-admin-${suffix}@exempel.se`,
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
  /**
   * The out-of-order cases, one person each. Matched by email, and never in
   * `personIds`: the rows they get are the member register's, which keeps them.
   */
  backDater: {
    personId: `imp-back-${suffix}`,
    email: `imp-back-${suffix}@exempel.se`,
  },
  lateRecorder: {
    personId: `imp-late-${suffix}`,
    email: `imp-late-${suffix}@exempel.se`,
  },
  newestFirst: {
    personId: `imp-newest-${suffix}`,
    email: `imp-newest-${suffix}@exempel.se`,
  },
} as const;

const twinFirstName = "Dubbel";
/**
 * The day both Dubbels moved into 2103. A row about one of them there states
 * it, so the row is about the residency they hold rather than a second one on
 * the same days, which the import refuses.
 */
const twinsMovedInOn = "2018-01-01";
const newcomerEmail = `imp-nina-${suffix}@exempel.se`;
/** A second newcomer, used by the concurrent-apply case and nowhere else. */
const raceEmail = `imp-race-${suffix}@exempel.se`;

const personIds = [
  actors.board.personId,
  actors.resident.personId,
  actors.admin.personId,
  actors.existing.personId,
  actors.twinA.personId,
  actors.twinB.personId,
];

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "DELETE";
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

async function createPerson(
  input: {
    personId: string;
    firstName: string;
    lastName?: string;
    email?: string;
    identityNumber?: string;
  },
  client: Prisma.TransactionClient = prisma,
): Promise<void> {
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
  await client.person.create({
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
 * True while a transaction is waiting for this one person's transition lock.
 *
 * This person's, not any: the suite shares its database, and a count of every
 * advisory wait in it would be answered by an unrelated test holding an
 * unrelated lock - which would release the move-in below early and let the case
 * pass without the chunk ever having waited for anything.
 */
async function waitsForTransitionLock(personId: string): Promise<boolean> {
  return (await advisoryLockCount(prisma, `residency:${personId}`, false)) > 0n;
}

/** Asks for a preview, as the screen does, and answers what the API said. */
async function askForPreview(
  cookie: string,
  sessionId: string,
  payload: object,
): Promise<ImportPreviewRun> {
  const response = await inject({
    method: "POST",
    url: `/api/import/sessions/${sessionId}/preview`,
    payload,
    headers: { cookie },
  });
  // Accepted, not done: the preview is planned by a worker.
  expect(response.statusCode).toBe(202);
  return JSON.parse(response.body) as ImportPreviewRun;
}

async function readPreview(
  cookie: string,
  sessionId: string,
  previewId: string,
) {
  return inject({
    method: "GET",
    url: `/api/import/sessions/${sessionId}/preview/${previewId}`,
    headers: { cookie },
  });
}

/**
 * Polls a preview until its job has stopped planning it, as the screen does.
 * The session row is the only place the job's progress exists.
 */
async function waitForPreview(
  cookie: string,
  sessionId: string,
  previewId: string,
  timeoutMs = 45_000,
): Promise<ImportPreviewRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await readPreview(cookie, sessionId, previewId);
    expect(response.statusCode).toBe(200);
    const run = JSON.parse(response.body) as ImportPreviewRun;
    if (run.status !== "PLANNING") {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Preview ${previewId} stayed PLANNING at ` +
          `${String(run.rowsDone)}/${String(run.rowsTotal)} rows`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Asks for a preview and waits until it is ready. */
async function previewImport(
  cookie: string,
  sessionId: string,
  payload: object,
): Promise<ImportPreview> {
  const asked = await askForPreview(cookie, sessionId, payload);
  const run = await waitForPreview(cookie, sessionId, asked.previewId);
  expect(run).toMatchObject({ status: "READY", failureReason: null });
  if (run.preview === null) {
    throw new Error(`Preview ${asked.previewId} is ready with no preview`);
  }
  return run.preview;
}

/**
 * Uploads a file and previews it, which is what the apply now requires: the
 * import that runs is the one the board looked at.
 */
async function uploadAndPreview(
  cookie: string,
  fileName: string,
  rows: string[][],
): Promise<ImportSessionView> {
  const session = await upload(cookie, fileName, encode(writeCsv(rows)));
  await previewImport(cookie, session.sessionId, {
    mapping: session.suggestedMapping,
  });
  return session;
}

/**
 * Starts an import, as the screen that took its preview does.
 *
 * That screen holds the token its preview answered with, so unless a case says
 * otherwise this sends the one the session recorded last.
 */
async function applyImport(
  cookie: string,
  sessionId: string,
  decisions: Record<string, unknown> = {},
  previewToken?: string,
) {
  const recorded = await prisma.importSession.findUnique({
    where: { id: sessionId },
    select: { previewToken: true },
  });
  return inject({
    method: "POST",
    url: `/api/import/sessions/${sessionId}/apply`,
    payload: {
      decisions,
      previewToken: previewToken ?? recorded?.previewToken ?? "never-previewed",
    },
    headers: { cookie },
  });
}

/** The reason a refused request answered with. */
function reasonOf(response: { body: string }): string {
  return (JSON.parse(response.body) as { reason: string }).reason;
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
  previews = app.get(ImportPreviewService);

  // The preview and the apply are background jobs, so the queue and its
  // workers are what make these tests test anything: an import that is only
  // enqueued writes no register. Started here rather than at boot, which the
  // API deliberately does not do under test.
  await previews.startPreviewWorker();
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
      { id: apartments.i, addressId, number: "2109", floor: 1 },
      { id: apartments.j, addressId, number: "2110", floor: 1 },
      { id: apartments.k, addressId, number: "2111", floor: 1 },
      { id: apartments.l, addressId, number: "2112", floor: 1 },
      { id: apartments.m, addressId, number: "2113", floor: 1 },
      { id: apartments.n, addressId, number: "2114", floor: 1 },
      { id: apartments.o, addressId, number: "2115", floor: 1 },
      { id: apartments.p, addressId, number: "2116", floor: 1 },
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
    personId: actors.admin.personId,
    firstName: "Ada",
    email: actors.admin.email,
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
    personId: actors.backDater.personId,
    firstName: "Bodil",
    email: actors.backDater.email,
  });
  await createPerson({
    personId: actors.lateRecorder.personId,
    firstName: "Lars",
    email: actors.lateRecorder.email,
  });
  await createPerson({
    personId: actors.newestFirst.personId,
    firstName: "Nora",
    email: actors.newestFirst.email,
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

  await prisma.systemRole.create({
    data: { personId: actors.admin.personId, role: "ADMIN" },
  });

  const auth = app.get(AuthService);
  for (const actor of [actors.board, actors.resident, actors.admin]) {
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
      id: {
        in: [
          apartments.b,
          apartments.c,
          apartments.m,
          apartments.n,
          apartments.o,
          apartments.p,
        ],
      },
    },
  });
  await app.close();
});

// One import runs at a time, so a session a case leaves QUEUED or APPLYING -
// claimed by hand with no job behind it, or stopped by a failed assertion -
// would have every later apply in the file refused as another-import-running,
// hiding the failure that left it there. Closed the way the dead letter closes
// it once the retries are spent.
afterEach(async () => {
  await prisma.importSession.updateMany({
    where: {
      createdById: actors.board.personId,
      status: { in: ["QUEUED", "APPLYING"] },
    },
    data: {
      status: "FAILED",
      failureReason: "apply-interrupted",
      finishedAt: new Date(),
    },
  });
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

  it.each([
    [
      "a quoted cell that is never closed",
      'Adress;Lgh\n"1;2\n3;4\n',
      "unterminated-quote",
    ],
    [
      "a row wider than the mapping takes",
      `${";".repeat(250)}\na\n`,
      "too-many-columns",
    ],
    [
      "more rows than an import takes",
      `Lgh\n${"1\n".repeat(5001)}`,
      "too-many-rows",
    ],
  ])("refuses %s, and says which", async (_case, text, reason) => {
    const response = await inject({
      method: "POST",
      url: "/api/import/sessions",
      payload: { fileName: "fel.csv", content: encode(text) },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      reason,
    );
  });

  it("answers a file that mixes UTF-8 and Windows-1252 with its own reason", async () => {
    const bytes = Buffer.concat([
      Buffer.from("Förnamn;Efternamn\nÅsa;Öberg\nBj", "utf8"),
      Buffer.from([0xf6]),
      Buffer.from("rk;Lind\n", "utf8"),
    ]);
    const response = await inject({
      method: "POST",
      url: "/api/import/sessions",
      payload: { fileName: "blandad.csv", content: bytes.toString("base64") },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "file-mixed-encoding",
    );
  });
});

describe("uploading a CSV saved by Swedish Excel", () => {
  /**
   * The fixture files byte for byte, previewed through the mapping the titles
   * suggest. The preview is what the apply writes, so a name that reads right
   * here is the name the register gets.
   */
  async function previewFixture(name: string): Promise<{
    session: ImportSessionView;
    value: ImportPreview;
  }> {
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      name,
      readFileSync(
        join(process.cwd(), "src", "import", "fixtures", name),
      ).toString("base64"),
    );
    const response = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
      defaultMovedInOn: "2021-04-01",
    });
    return { session, value: response };
  }

  it.each(["medlemmar-windows-1252.csv", "medlemmar-utf-8-bom.csv"])(
    "reads Åsa Öberg out of %s",
    async (name) => {
      const { session, value } = await previewFixture(name);

      // The titles decode too, which is what lets the mapping be guessed.
      expect(session.columns).toEqual([
        "Förnamn",
        "Efternamn",
        "Lägenhetsnummer",
        "Roll",
      ]);
      expect(session.sample).toEqual([["Åsa", "Öberg", "1101", "Medlem"]]);
      expect(value.rows[0]?.person).toMatchObject({
        firstName: "Åsa",
        lastName: "Öberg",
      });
      expect(value.rows[0]?.problems).not.toContainEqual(
        expect.objectContaining({ reason: "garbled-characters" }),
      );
    },
  );

  it("refuses a row whose name already lost a letter, and says so in the preview", async () => {
    // UTF-8 that holds U+FFFD itself: a file that went through a wrong decode
    // before it got here. Nothing can recover the letter, so the row is not
    // imported rather than written into the register as it stands.
    const rows = fixtureRows();
    rows[1] = rows[1]!.map((cell, index) =>
      index === 2 ? "Bj\uFFFDrk" : cell,
    );
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(rows)),
    );
    const value = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    const garbled = value.rows.find((row) => row.rowNumber === 1);

    expect(garbled?.outcome).toBe("error");
    expect(garbled?.problems).toContainEqual({
      field: "firstName",
      reason: "garbled-characters",
    });
  });
});

describe("holding an upload between its steps", () => {
  it("gives back every letter, including those above U+00FF", async () => {
    // The rows are encrypted into the import session on upload and decrypted
    // for the preview, so a name that survives here survived the round trip
    // through the database.
    const rows = fixtureRows();
    rows[1] = rows[1]!.map((cell, index) =>
      index === 2 ? "Åsa" : index === 3 ? "Öberg-Żółkiewska" : cell,
    );
    rows[2] = rows[2]!.map((cell, index) => (index === 2 ? "Łukasz" : cell));
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(rows)),
    );
    const value = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });

    expect(value.rows.find((row) => row.rowNumber === 1)?.person).toMatchObject(
      { firstName: "Åsa", lastName: "Öberg-Żółkiewska" },
    );
    expect(value.rows.find((row) => row.rowNumber === 2)?.person).toMatchObject(
      { firstName: "Łukasz" },
    );
    for (const row of value.rows) {
      expect(row.problems).not.toContainEqual(
        expect.objectContaining({ reason: "garbled-characters" }),
      );
    }
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

  it("refuses a workbook that inflates past what an import reads", async () => {
    const workbook = buildWorkbook([["Lgh"], ["1101"]], "Blad1", {
      sharedStrings: `<si><t>${"a".repeat(MAX_WORKBOOK_ENTRY_BYTES)}</t></si>`,
    });
    const response = await inject({
      method: "POST",
      url: "/api/import/sessions",
      payload: { fileName: "stor.xlsx", content: workbook.toString("base64") },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "workbook-too-large",
    );
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
    const value = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    return { session, cookie, value };
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
    // Refused before anything was recorded or queued.
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: session.sessionId },
        select: { previewId: true, previewStatus: true },
      }),
    ).toEqual({ previewId: null, previewStatus: null });
  });
});

describe("the preview job", () => {
  /**
   * Puts a session in the state a preview request leaves it in, without
   * queueing a job for it. The case then runs the job itself, so no worker can
   * race it to the session.
   */
  async function planningWithoutJob(
    session: ImportSessionView,
    previewId: string,
    overrides: { mapping?: string[]; previewWatchedAt?: Date } = {},
  ): Promise<void> {
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: {
        mapping:
          overrides.mapping ??
          session.suggestedMapping.map((field) => field ?? ""),
        defaultMovedInOn: "2010-01-01",
        previewId,
        previewStatus: "PLANNING",
        previewWatchedAt: overrides.previewWatchedAt ?? new Date(),
      },
    });
  }

  it("answers at once, and issues the token only once the plan is ready", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(fixtureRows())),
    );

    const asked = await askForPreview(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    expect(asked).toMatchObject({
      sessionId: session.sessionId,
      status: "PLANNING",
      rowsDone: 0,
      rowsTotal: 5,
      failureReason: null,
      preview: null,
    });

    const run = await waitForPreview(
      cookie,
      session.sessionId,
      asked.previewId,
    );
    expect(run).toMatchObject({ status: "READY", rowsDone: 5, rowsTotal: 5 });
    const recorded = await prisma.importSession.findUniqueOrThrow({
      where: { id: session.sessionId },
      select: { previewToken: true, previewCipher: true },
    });
    expect(run.preview?.previewToken).toBe(recorded.previewToken);
    expect(run.preview?.summary).toEqual({
      create: 1,
      update: 1,
      ambiguous: 1,
      error: 2,
    });
    // Stored encrypted: the preview names everybody in the file.
    expect(recorded.previewCipher).not.toBeNull();
    expect(recorded.previewCipher).not.toContain(newcomerEmail);
  });

  it("refuses to show a preview that has been replaced", async () => {
    // The screen that asked first is told, rather than shown a plan for the
    // mapping the second one chose.
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(fixtureRows())),
    );

    const first = await askForPreview(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    const second = await askForPreview(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });

    const stale = await readPreview(cookie, session.sessionId, first.previewId);
    expect(stale.statusCode).toBe(409);
    expect((JSON.parse(stale.body) as { reason: string }).reason).toBe(
      "preview-replaced",
    );
    expect(
      (await waitForPreview(cookie, session.sessionId, second.previewId))
        .status,
    ).toBe("READY");
  });

  it("withdraws the token before as soon as another preview is asked for", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(fixtureRows())),
    );
    const first = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });

    // Not waited for: whether the second preview is still being planned or
    // is ready already, the first token no longer names the session's preview.
    await askForPreview(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    const response = await applyImport(
      cookie,
      session.sessionId,
      { "3": { action: "skip" } },
      first.previewToken,
    );

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "preview-replaced",
    );
    expect((await readRun(cookie, session.sessionId)).status).toBe("MAPPING");
  });

  it("reports its progress as it plans", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "lang.csv",
      encode(writeCsv(longFixture("Progress"))),
    );
    const previewId = `progress-${suffix}`;
    await planningWithoutJob(session, previewId);

    const updates = vi.spyOn(prisma.importSession, "updateMany");
    try {
      await previews.runPreview(session.sessionId, previewId);
      // This session's progress reports: the updates that move the count
      // and nothing else.
      const reported = updates.mock.calls.flatMap(([call]) =>
        call?.where?.id === session.sessionId &&
        typeof call.data.previewRowsDone === "number" &&
        call.data.previewStatus === undefined
          ? [call.data.previewRowsDone]
          : [],
      );
      expect(reported).toEqual([
        PREVIEW_PROGRESS_ROWS,
        2 * PREVIEW_PROGRESS_ROWS,
      ]);
    } finally {
      updates.mockRestore();
    }

    const run = await waitForPreview(cookie, session.sessionId, previewId);
    expect(run).toMatchObject({
      status: "READY",
      rowsDone: IMPORT_CHUNK_ROWS + 20,
      rowsTotal: IMPORT_CHUNK_ROWS + 20,
    });
  });

  it("stops planning a preview nobody is watching", async () => {
    // The screen holds the preview's id, and a reload loses it, so a preview
    // nobody has asked about for minutes is one nobody will see. Planning it
    // to the end would hold the one worker other previews wait for.
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "lang.csv",
      encode(writeCsv(longFixture("Unwatched"))),
    );
    const previewId = `unwatched-${suffix}`;
    await planningWithoutJob(session, previewId, {
      previewWatchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await previews.runPreview(session.sessionId, previewId);

    const stopped = await readPreview(cookie, session.sessionId, previewId);
    expect(stopped.statusCode).toBe(200);
    expect(JSON.parse(stopped.body) as ImportPreviewRun).toMatchObject({
      status: "FAILED",
      failureReason: "preview-interrupted",
      preview: null,
    });

    // And the next preview of the same upload is planned as usual.
    const preview = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
      defaultMovedInOn: "2010-01-01",
    });
    expect(preview.rows).toHaveLength(IMPORT_CHUNK_ROWS + 20);
  });

  it("stops a preview the screen has cancelled", async () => {
    // The board picked another file. Told so, the job lets go of the worker
    // rather than planning on until the preview is found unwatched.
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "lang.csv",
      encode(writeCsv(longFixture("Cancelled"))),
    );
    const previewId = `cancelled-${suffix}`;
    await planningWithoutJob(session, previewId);

    const cancelled = await inject({
      method: "DELETE",
      url: `/api/import/sessions/${session.sessionId}/preview/${previewId}`,
      headers: { cookie },
    });
    expect(cancelled.statusCode).toBe(204);

    await previews.runPreview(session.sessionId, previewId);
    const stopped = await readPreview(cookie, session.sessionId, previewId);
    expect(JSON.parse(stopped.body) as ImportPreviewRun).toMatchObject({
      status: "FAILED",
      rowsDone: 0,
      failureReason: "preview-cancelled",
      preview: null,
    });

    // A preview that has been replaced since is not the one cancelled.
    const next = await askForPreview(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
      defaultMovedInOn: "2010-01-01",
    });
    const late = await inject({
      method: "DELETE",
      url: `/api/import/sessions/${session.sessionId}/preview/${previewId}`,
      headers: { cookie },
    });
    expect(late.statusCode).toBe(204);
    expect(
      (await waitForPreview(cookie, session.sessionId, next.previewId)).status,
    ).toBe("READY");
  });

  it("records a refusal, and holds up neither a later preview nor the apply", async () => {
    const cookie = await signIn(actors.board.email);
    // One row, with a date nobody can read: applied, it writes nothing.
    const session = await upload(
      cookie,
      "stoppad.csv",
      encode(
        writeCsv([
          HEADERS,
          [
            addressLabel,
            "2101",
            "Stoppad",
            surname,
            "Medlem",
            "",
            "",
            "01/03/2020",
          ],
        ]),
      ),
    );
    const previewId = `refused-${suffix}`;
    // A stored mapping that no longer fits the file: the job refuses it.
    await planningWithoutJob(session, previewId, { mapping: [] });

    await previews.runPreview(session.sessionId, previewId);

    const refused = await readPreview(cookie, session.sessionId, previewId);
    expect(JSON.parse(refused.body) as ImportPreviewRun).toMatchObject({
      status: "FAILED",
      failureReason: "mapping-invalid",
    });
    // A preview that stopped issued no token, so nothing can be applied on it.
    const early = await applyImport(cookie, session.sessionId);
    expect(early.statusCode).toBe(409);
    expect((JSON.parse(early.body) as { reason: string }).reason).toBe(
      "preview-replaced",
    );

    await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    expect((await applyImport(cookie, session.sessionId)).statusCode).toBe(202);
    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.result).toMatchObject({ personsCreated: 0, errors: 1 });
    // The stored preview has done its work once the import is claimed.
    expect(
      (
        await prisma.importSession.findUniqueOrThrow({
          where: { id: session.sessionId },
          select: { previewCipher: true },
        })
      ).previewCipher,
    ).toBeNull();
  });

  it("is planned again when the API comes back up", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "medlemmar.csv",
      encode(writeCsv(fixtureRows())),
    );
    const previewId = `resumed-${suffix}`;
    await planningWithoutJob(session, previewId);

    expect(await previews.resumeInterruptedPreviews()).toBeGreaterThan(0);

    expect(
      (await waitForPreview(cookie, session.sessionId, previewId)).status,
    ).toBe("READY");
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

  it("refuses while a previewed row is left without a decision", async () => {
    // Two Dubbel rows with addresses of their own: each asks for a decision,
    // and neither answer changes the other. Deciding row 1 alone leaves row 2
    // asking, and nothing else in the plan has moved.
    const cookie = await signIn(actors.board.email);
    const row = (email: string) => [
      addressLabel,
      "2103",
      twinFirstName,
      surname,
      "Boende",
      email,
      "",
      "2021-04-01",
    ];
    const session = await upload(
      cookie,
      "tva-tvetydiga.csv",
      encode(
        writeCsv([
          HEADERS,
          row(`imp-undecided-a-${suffix}@exempel.se`),
          row(`imp-undecided-b-${suffix}@exempel.se`),
        ]),
      ),
    );
    const previewed = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    expect(previewed.rows.map((planned) => planned.outcome)).toEqual([
      "ambiguous",
      "ambiguous",
    ]);

    const response = await applyImport(cookie, session.sessionId, {
      "1": { action: "use-person", personId: actors.twinA.personId },
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("ambiguous-rows-undecided");
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
      personsUpdated: 1,
      residenciesCreated: 2,
      memberRegisterEntriesCreated: 1,
      skipped: 0,
      // The decided row's person has lived in 2103 since 2018, and the row
      // says 2019: a second residency on the same days, which is a problem with
      // the row rather than something to write or to drop without a word.
      errors: 3,
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

  it("is the import still running, not a newer one that has finished", async () => {
    const cookie = await signIn(actors.board.email);
    const rows = [
      HEADERS,
      [addressLabel, "2104", "Aktiv", surname, "Medlem", "", "", "2022-11-01"],
    ];
    const running = await uploadAndPreview(cookie, "pagar.csv", rows);
    await prisma.importSession.update({
      where: { id: running.sessionId },
      data: { status: "APPLYING" },
    });
    const newer = await uploadAndPreview(cookie, "klar.csv", rows);
    await prisma.importSession.update({
      where: { id: newer.sessionId },
      data: { status: "FAILED", failureReason: "stopped for the test" },
    });

    try {
      const response = await inject({
        method: "GET",
        url: "/api/import/sessions/active",
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      const active = JSON.parse(response.body) as ImportRunView | null;
      expect(active?.sessionId).toBe(running.sessionId);
      expect(active?.status).toBe("APPLYING");
    } finally {
      await prisma.importSession.updateMany({
        where: { id: { in: [running.sessionId, newer.sessionId] } },
        data: { status: "MAPPING" },
      });
    }
  });
});

describe("an apply after the upload was previewed again", () => {
  it("is refused rather than run under the mapping it never showed", async () => {
    // Tab A previews and decides; tab B, or another board member, previews the
    // same upload with another mapping; tab A applies. Its decisions were made
    // against rows B's mapping may not even produce.
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "tva-flikar.csv",
      encode(writeCsv(fixtureRows())),
    );
    const preview = (mapping: (ImportField | null)[]) =>
      previewImport(cookie, session.sessionId, {
        mapping,
        defaultRole: "RESIDENT",
      });

    const first = await preview(session.suggestedMapping);
    const second = await preview(
      session.suggestedMapping.map((field) =>
        field === "role" ? null : field,
      ),
    );
    expect(second.previewToken).not.toBe(first.previewToken);

    const response = await applyImport(
      cookie,
      session.sessionId,
      { "3": { action: "skip" } },
      first.previewToken,
    );
    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "preview-replaced",
    );
    expect((await readRun(cookie, session.sessionId)).status).toBe("MAPPING");
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
    // The other click's own session, not another import: the screen answers
    // this reason by showing the import that did start.
    const refused = first.statusCode === 409 ? first : second;
    expect(reasonOf(refused)).toBe("session-already-applied");

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
    // Left APPLYING, as the first attempt leaves it: from QUEUED only one of
    // the two would start it, and the other would stop before the cursor.
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "APPLYING", startedAt: new Date(), decisions: {} },
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

describe("two imports of one file", () => {
  it("applies one of them and refuses the other while it runs", async () => {
    // The same file uploaded twice - by two board members, or in a second tab
    // because the first looked stuck. Each import's chunks plan against a
    // register that lacks what the other is about to commit, so both would
    // create the person, each with a statutory ENTRY row.
    const cookie = await signIn(actors.board.email);
    const rows = [
      HEADERS,
      [
        addressLabel,
        "2104",
        "Tvilling",
        surname,
        "Medlem",
        "",
        "",
        "2022-11-01",
      ],
    ];
    const first = await uploadAndPreview(cookie, "forsta.csv", rows);
    const second = await uploadAndPreview(cookie, "andra.csv", rows);

    const responses = await Promise.all([
      applyImport(cookie, first.sessionId),
      applyImport(cookie, second.sessionId),
    ]);
    const codes = responses.map((response) => response.statusCode);
    expect([...codes].sort((a, b) => a - b)).toEqual([202, 409]);
    const refused = responses.find((response) => response.statusCode === 409);
    expect(
      (JSON.parse(refused?.body ?? "{}") as { reason?: string }).reason,
    ).toBe("another-import-running");

    const started = codes[0] === 202 ? first : second;
    await waitForRun(
      cookie,
      started.sessionId,
      (run) => run.status === "APPLIED",
    );

    const created = await prisma.person.findMany({
      where: { firstName: "Tvilling", lastName: surname },
      select: { memberRegisterEntries: { select: { id: true } } },
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.memberRegisterEntries).toHaveLength(1);
  }, 60_000);
});

describe("an apply and a preview of one session", () => {
  it("does not start the import when a preview replaces the one the apply was checked against", async () => {
    // A second board member, or a second tab, previews the session while an
    // apply is between its checks and its claim. That preview may record
    // another mapping, and the decisions the apply carries answer the old
    // one, so the claim has to find nothing to claim.
    //
    // The apply is held where the gap is - it readies the queues after the
    // plan is checked and before the claim - so the preview lands there on
    // every run rather than whenever the scheduler happens to allow it.
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(cookie, "ersatt.csv", [
      HEADERS,
      [addressLabel, "2101", "Ersatt", surname, "Medlem", "", "", "1/2/23"],
    ]);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const checked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const ensureQueues = applies.ensureQueues.bind(applies);
    const paused = vi
      .spyOn(applies, "ensureQueues")
      .mockImplementationOnce(async () => {
        reached();
        await held;
        await ensureQueues();
      });
    const enqueued = vi.spyOn(applies, "enqueueInTransaction");

    let replacedAt: Date | null = null;
    let queued: number;
    let response: Awaited<ReturnType<typeof applyImport>>;
    try {
      const applying = applyImport(cookie, session.sessionId);
      try {
        // Raced with the apply itself, so one refused before the gap fails
        // at the assertions below instead of as a timeout here.
        await Promise.race([checked, applying]);
        await previewImport(cookie, session.sessionId, {
          mapping: session.suggestedMapping,
          defaultMovedInOn: "2023-02-01",
        });
        ({ previewedAt: replacedAt } =
          await prisma.importSession.findUniqueOrThrow({
            where: { id: session.sessionId },
            select: { previewedAt: true },
          }));
      } finally {
        release();
      }
      response = await applying;
      // Counted before the spy is restored, which clears its calls.
      queued = enqueued.mock.calls.length;
    } finally {
      paused.mockRestore();
      enqueued.mockRestore();
    }

    expect(response.statusCode).toBe(409);
    expect(reasonOf(response)).toBe("preview-replaced");
    expect(queued).toBe(0);
    // The newer preview is what the session holds, ready to be applied.
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: session.sessionId },
        select: {
          status: true,
          mapping: true,
          defaultMovedInOn: true,
          previewedAt: true,
          decisions: true,
          rowsDone: true,
        },
      }),
    ).toEqual({
      status: "MAPPING",
      mapping: EXPECTED_MAPPING,
      defaultMovedInOn: "2023-02-01",
      previewedAt: replacedAt,
      decisions: null,
      rowsDone: 0,
    });
  }, 60_000);
});

describe("two imports of two files", () => {
  /**
   * A file whose only row has a date nobody can read: it previews, applies and
   * finishes like any other, and writes nothing into a register that cannot
   * have rows removed.
   */
  function harmlessRows(firstName: string): string[][] {
    return [
      HEADERS,
      [addressLabel, "2101", firstName, surname, "Medlem", "", "", "1/2/23"],
    ];
  }

  it("refuses the second while the first is queued or applying, and runs it after", async () => {
    // Two files applied side by side would each plan against a register the
    // other is writing, and a person in both would be created twice, with an
    // ENTRY row each. The second has to wait, and has to still be there to
    // apply once the first is done.
    const cookie = await signIn(actors.board.email);
    const first = await uploadAndPreview(
      cookie,
      "forsta.csv",
      harmlessRows("Forsta"),
    );
    const second = await uploadAndPreview(
      cookie,
      "andra.csv",
      harmlessRows("Andra"),
    );

    // Claimed here rather than through the endpoint, so the worker does not
    // finish the first import before the second asks: the case is about what
    // the second finds while the first is still running.
    await prisma.importSession.update({
      where: { id: first.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });

    const whileQueued = await applyImport(cookie, second.sessionId);
    expect(whileQueued.statusCode).toBe(409);
    expect(reasonOf(whileQueued)).toBe("another-import-running");
    // Refused before anything is queued: still an upload, still applicable.
    expect(await readRun(cookie, second.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });

    await prisma.importSession.update({
      where: { id: first.sessionId },
      data: { status: "APPLYING", startedAt: new Date() },
    });

    const whileApplying = await applyImport(cookie, second.sessionId);
    expect(whileApplying.statusCode).toBe(409);
    expect(reasonOf(whileApplying)).toBe("another-import-running");
    expect((await readRun(cookie, second.sessionId)).status).toBe("MAPPING");

    await applies.runApply(first.sessionId);
    expect((await readRun(cookie, first.sessionId)).status).toBe("APPLIED");

    const afterwards = await applyImport(cookie, second.sessionId);
    expect(afterwards.statusCode).toBe(202);
    const run = await waitForRun(
      cookie,
      second.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.result.errors).toBe(1);
  }, 60_000);

  it("starts exactly one when two are applied at once", async () => {
    // The claim's row lock cannot settle this: the two requests claim
    // different rows. Without the lock in front of the read, both would find
    // nothing running and both would queue.
    //
    // The table is held here so that no claim can be written until both
    // requests are waiting. With the lock, the first waits at its claim while
    // holding the lock, and the second waits for the lock without having read.
    // Without it, both have read "nothing running" and wait at their claims.
    // Either way the race is decided the same way on every run, rather than
    // whenever the scheduler happens to interleave the two.
    const cookie = await signIn(actors.board.email);
    const sessions = await Promise.all([
      uploadAndPreview(cookie, "samtidig-1.csv", harmlessRows("SamtidigEtt")),
      uploadAndPreview(cookie, "samtidig-2.csv", harmlessRows("SamtidigTva")),
    ]);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding!: () => void;
    const taken = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        // EXCLUSIVE lets the reads through and stops every write.
        await tx.$executeRaw`LOCK TABLE import_session IN EXCLUSIVE MODE`;
        holding();
        await held;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );
    await taken;

    // A request that returns before it reaches a lock (a 4xx or a 500) counts
    // as settled, so it fails at the status-code assertion below rather than as
    // a timeout here.
    let settled = 0;
    const requests = sessions.map((session) =>
      applyImport(cookie, session.sessionId).finally(() => (settled += 1)),
    );
    try {
      await waitFor(
        async () => settled === 2 || (await waitingLockCount(prisma)) === 2n,
      );
    } finally {
      // The table lock blocks every write, so it must not outlive a failure.
      release();
    }
    const [responses] = await Promise.all([Promise.all(requests), holder]);
    const codes = responses.map((response) => response.statusCode);
    expect([...codes].sort((a, b) => a - b)).toEqual([202, 409]);

    const winner = codes.indexOf(202);
    const loser = 1 - winner;
    expect(reasonOf(responses[loser] as { body: string })).toBe(
      "another-import-running",
    );
    const loserSession = sessions[loser] as ImportSessionView;
    const winnerSession = sessions[winner] as ImportSessionView;
    expect((await readRun(cookie, loserSession.sessionId)).status).toBe(
      "MAPPING",
    );

    await waitForRun(
      cookie,
      winnerSession.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect((await applyImport(cookie, loserSession.sessionId)).statusCode).toBe(
      202,
    );
    await waitForRun(
      cookie,
      loserSession.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
  }, 60_000);
});

function abandonImport(cookie: string, sessionId: string) {
  return inject({
    method: "POST",
    url: `/api/import/sessions/${sessionId}/abandon`,
    headers: { cookie },
  });
}

describe("abandoning an import that is stuck", () => {
  /** One row nobody can read the date of: it applies and writes nothing. */
  function harmlessRows(firstName: string): string[][] {
    return [
      HEADERS,
      [addressLabel, "2101", firstName, surname, "Medlem", "", "", "1/2/23"],
    ];
  }

  it("is refused to anybody but an administrator", async () => {
    // The board imports, but stopping an import part way through a register
    // that cannot be edited - perhaps one another board member is watching -
    // is a call about how the instance is running.
    const board = await signIn(actors.board.email);
    const session = await uploadAndPreview(
      board,
      "fast-styrelse.csv",
      harmlessRows("FastStyrelse"),
    );
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });

    expect((await abandonImport(board, session.sessionId)).statusCode).toBe(
      403,
    );
    expect(
      (
        await abandonImport(
          await signIn(actors.resident.email),
          session.sessionId,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await inject({
          method: "POST",
          url: `/api/import/sessions/${session.sessionId}/abandon`,
        })
      ).statusCode,
    ).toBe(401);

    // Refused before anything changed, and nothing logged as abandoned.
    expect((await readRun(board, session.sessionId)).status).toBe("QUEUED");
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "IMPORT_ABANDONED", targetId: session.sessionId },
      }),
    ).toBe(0);
  }, 60_000);

  it("ends a session whose job was lost, logs who did it, and lets the next import run", async () => {
    // QUEUED with no job behind it: what a lost job leaves, and what would
    // otherwise hold every other import off until the next restart.
    const board = await signIn(actors.board.email);
    const admin = await signIn(actors.admin.email);
    const lost = await uploadAndPreview(
      board,
      "forlorad.csv",
      harmlessRows("Forlorad"),
    );
    const next = await uploadAndPreview(
      board,
      "nasta.csv",
      harmlessRows("Nasta"),
    );
    await prisma.importSession.update({
      where: { id: lost.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });
    const refused = await applyImport(board, next.sessionId);
    expect(reasonOf(refused)).toBe("another-import-running");

    const response = await abandonImport(admin, lost.sessionId);

    expect(response.statusCode).toBe(200);
    const run = JSON.parse(response.body) as ImportRunView;
    expect(run).toMatchObject({
      sessionId: lost.sessionId,
      status: "FAILED",
      failureReason: "apply-abandoned",
      rowsDone: 0,
    });
    expect(run.finishedAt).not.toBeNull();

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "IMPORT_ABANDONED", targetId: lost.sessionId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      channel: "WEB",
      actorPersonId: actors.admin.personId,
      targetKind: "importSession",
      targetPersonId: null,
      // Never started, and uploaded by the board: what the entry has to say
      // on its own once the session is purged.
      context: {
        rowsDone: 0,
        rowsTotal: 1,
        startedAt: null,
        createdById: actors.board.personId,
      },
    });

    // The import the lost one was holding off now runs.
    expect((await applyImport(board, next.sessionId)).statusCode).toBe(202);
    await waitForRun(
      board,
      next.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );

    // Abandoned once. A second press finds nothing running and logs nothing.
    const again = await abandonImport(admin, lost.sessionId);
    expect(again.statusCode).toBe(409);
    expect(reasonOf(again)).toBe("session-not-running");
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "IMPORT_ABANDONED", targetId: lost.sessionId },
      }),
    ).toBe(1);
  }, 60_000);

  it("is shown on the screen after its upload has expired, so it can still be abandoned", async () => {
    // A lost job does not run out with the upload: the purge leaves a running
    // session alone, and it holds off every other apply until somebody ends
    // it. The screen has to keep finding it, or there is nothing to press.
    const board = await signIn(actors.board.email);
    const admin = await signIn(actors.admin.email);
    const session = await uploadAndPreview(
      board,
      "gammal.csv",
      harmlessRows("Gammal"),
    );
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: {
        status: "QUEUED",
        decisions: {},
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const readActive = async (): Promise<ImportRunView | null> => {
      const response = await inject({
        method: "GET",
        url: "/api/import/sessions/active",
        headers: { cookie: board },
      });
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body) as ImportRunView | null;
    };

    expect(await readActive()).toMatchObject({
      sessionId: session.sessionId,
      fileName: "gammal.csv",
      status: "QUEUED",
    });

    const response = await abandonImport(admin, session.sessionId);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as ImportRunView).toMatchObject({
      sessionId: session.sessionId,
      status: "FAILED",
      failureReason: "apply-abandoned",
    });

    // Ended, it is an expired upload like any other and leaves the screen.
    expect((await readActive())?.sessionId).not.toBe(session.sessionId);
  }, 60_000);

  it("refuses an upload that was never started, and one that does not exist", async () => {
    const board = await signIn(actors.board.email);
    const admin = await signIn(actors.admin.email);
    const mapping = await uploadAndPreview(
      board,
      "ej-startad.csv",
      harmlessRows("EjStartad"),
    );

    const notStarted = await abandonImport(admin, mapping.sessionId);
    expect(notStarted.statusCode).toBe(409);
    expect(reasonOf(notStarted)).toBe("session-not-running");
    // Still an upload, still applicable.
    expect((await readRun(board, mapping.sessionId)).status).toBe("MAPPING");

    const missing = await abandonImport(admin, `imp-no-such-${suffix}`);
    expect(missing.statusCode).toBe(404);
    expect(reasonOf(missing)).toBe("session-not-found");
  }, 60_000);

  it("leaves a job that wakes afterwards nothing to do", async () => {
    // A hung attempt: one chunk written, then nothing. Abandoned, and then the
    // retry, a redelivery or the re-queue at the next start comes for it.
    const board = await signIn(actors.board.email);
    const admin = await signIn(actors.admin.email);
    const session = await uploadAndPreview(
      board,
      "hangd.csv",
      longFixture("Hangd"),
    );
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });
    expect(await applies.applyNextChunk(session.sessionId)).toBe(true);

    const response = await abandonImport(admin, session.sessionId);
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as ImportRunView).rowsDone).toBe(
      IMPORT_CHUNK_ROWS,
    );

    await expect(applies.runApply(session.sessionId)).resolves.toBeUndefined();

    const run = await readRun(board, session.sessionId);
    expect(run).toMatchObject({
      status: "FAILED",
      failureReason: "apply-abandoned",
      rowsDone: IMPORT_CHUNK_ROWS,
    });
    // What the first chunk wrote stays; the second chunk's person never comes.
    expect(
      await prisma.person.count({
        where: { firstName: "HangdFirst", lastName: surname },
      }),
    ).toBe(1);
    expect(
      await prisma.person.count({
        where: { firstName: "HangdLast", lastName: surname },
      }),
    ).toBe(0);
    const entry = await prisma.auditLogEntry.findFirst({
      where: { action: "IMPORT_ABANDONED", targetId: session.sessionId },
    });
    expect(entry?.context).toEqual({
      rowsDone: IMPORT_CHUNK_ROWS,
      rowsTotal: IMPORT_CHUNK_ROWS + 20,
      startedAt: run.startedAt,
      createdById: actors.board.personId,
    });
  }, 120_000);

  it("leaves a queued job that wakes afterwards nothing to do", async () => {
    const board = await signIn(actors.board.email);
    const admin = await signIn(actors.admin.email);
    const session = await uploadAndPreview(
      board,
      "vantande.csv",
      harmlessRows("Vantande"),
    );
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });
    expect((await abandonImport(admin, session.sessionId)).statusCode).toBe(
      200,
    );

    await expect(applies.runApply(session.sessionId)).resolves.toBeUndefined();

    const run = await readRun(board, session.sessionId);
    expect(run).toMatchObject({
      status: "FAILED",
      failureReason: "apply-abandoned",
      rowsDone: 0,
      startedAt: null,
    });
  }, 60_000);

  /**
   * Abandons the session while its next chunk is in flight, and answers what
   * the chunk returned and what the abandon did.
   *
   * The chunk is the real one, held at the one point an abandon can race it. A
   * test transaction holds the residency key of the apartment the chunk writes
   * to. The chunk claims the cursor, which takes the session row, and then
   * waits for that key. The abandon then has to wait for the session row, and
   * is shown to be waiting before the chunk is let go.
   */
  async function abandonDuringChunk(
    admin: string,
    sessionId: string,
    apartmentId: string,
  ): Promise<{
    more: boolean;
    response: Awaited<ReturnType<typeof abandonImport>>;
  }> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken!: () => void;
    const holding = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const apartment = prisma.$transaction(
      async (tx) => {
        await lockApartmentResidencies(tx, apartmentId);
        taken();
        await held;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );
    await holding;

    let chunkSettled = false;
    let abandonSettled = false;
    const chunk = applies.applyNextChunk(sessionId).finally(() => {
      chunkSettled = true;
    });
    let abandoning: ReturnType<typeof abandonImport> | null = null;
    try {
      // Waiting for the apartment means the cursor is claimed.
      await waitFor(
        async () =>
          chunkSettled ||
          (await residencyApartmentLockCount(prisma, apartmentId, false)) > 0n,
      );
      expect(chunkSettled).toBe(false);

      abandoning = abandonImport(admin, sessionId).finally(() => {
        abandonSettled = true;
      });
      // The abandon blocked by the chunk, on the session row the chunk holds
      // while it waits for the apartment.
      await waitFor(
        async () =>
          abandonSettled ||
          (await blockedBehindResidencyApartmentCount(prisma, apartmentId)) >
            0n,
      );
      expect(abandonSettled).toBe(false);
    } finally {
      release();
    }
    await apartment;

    const more = await chunk;
    if (abandoning === null) {
      throw new Error("The abandon was never sent");
    }
    return { more, response: await abandoning };
  }

  it("waits for a chunk in flight and reports where it really stopped", async () => {
    // A chunk claims the cursor first thing in its transaction and holds the
    // session row until it commits. An abandon that arrives meanwhile has to
    // wait for it rather than fail, and has to report and log the cursor that
    // chunk committed - not the one it read before the chunk finished. The
    // chunk held is the first of two, so the import is still running when it
    // commits.
    const board = await signIn(actors.board.email);
    const admin = await signIn(actors.admin.email);
    const session = await uploadAndPreview(
      board,
      "mitt-i.csv",
      longFixture("MittI"),
    );
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });

    // The first chunk writes its one real row in 2101.
    const { more, response } = await abandonDuringChunk(
      admin,
      session.sessionId,
      apartments.a,
    );

    expect(more).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as ImportRunView).toMatchObject({
      status: "FAILED",
      failureReason: "apply-abandoned",
      rowsDone: IMPORT_CHUNK_ROWS,
    });
    // What the chunk wrote is there; the abandon undid none of it.
    expect(
      await prisma.person.count({
        where: { firstName: "MittIFirst", lastName: surname },
      }),
    ).toBe(1);
    const entry = await prisma.auditLogEntry.findFirst({
      where: { action: "IMPORT_ABANDONED", targetId: session.sessionId },
    });
    expect(entry?.context).toEqual({
      rowsDone: IMPORT_CHUNK_ROWS,
      rowsTotal: IMPORT_CHUNK_ROWS + 20,
      startedAt: expect.any(String),
      createdById: actors.board.personId,
    });
  }, 120_000);

  it("refuses once the last chunk in flight has written every row", async () => {
    // The last chunk ends the import in the commit that writes its rows, so an
    // abandon that waited for it finds an import that is no longer running.
    // Recording it as abandoned would tell the board that an import which
    // wrote every row did not finish.
    const board = await signIn(actors.board.email);
    const admin = await signIn(actors.admin.email);
    const session = await uploadAndPreview(board, "sista.csv", [
      HEADERS,
      [addressLabel, "2102", "Sista", surname, "Boende", "", "", "2022-02-01"],
    ]);
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });

    const { more, response } = await abandonDuringChunk(
      admin,
      session.sessionId,
      apartments.b,
    );

    expect(more).toBe(false);
    expect(response.statusCode).toBe(409);
    expect(reasonOf(response)).toBe("session-not-running");
    const run = await readRun(board, session.sessionId);
    expect(run).toMatchObject({
      status: "APPLIED",
      failureReason: null,
      rowsDone: 1,
      rowsTotal: 1,
    });
    expect(run.finishedAt).not.toBeNull();
    expect(
      await prisma.residency.count({
        where: {
          apartmentId: apartments.b,
          person: { firstName: "Sista", lastName: surname },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "IMPORT_ABANDONED", targetId: session.sessionId },
      }),
    ).toBe(0);
  }, 60_000);

  it("finishes rather than abandons an import left applying with every row written", async () => {
    // What an instance that marked an import applied after its last chunk,
    // rather than with it, leaves when it stops in between: the rows are all
    // there and the session still says applying. It holds every other import
    // off like a stuck one, and the abandon is how an administrator clears
    // it - as applied, which is what it is.
    const board = await signIn(actors.board.email);
    const admin = await signIn(actors.admin.email);
    const session = await uploadAndPreview(
      board,
      "skriven.csv",
      harmlessRows("Skriven"),
    );
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: {
        status: "APPLYING",
        startedAt: new Date(),
        decisions: {},
        rowsDone: 1,
      },
    });

    const response = await abandonImport(admin, session.sessionId);

    expect(response.statusCode).toBe(409);
    expect(reasonOf(response)).toBe("session-not-running");
    const run = await readRun(board, session.sessionId);
    expect(run).toMatchObject({ status: "APPLIED", failureReason: null });
    expect(run.finishedAt).not.toBeNull();
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "IMPORT_ABANDONED", targetId: session.sessionId },
      }),
    ).toBe(0);
  }, 60_000);
});

describe("a file listing a person's rows out of date order", () => {
  /*
   * The same cases the move flows are held to in move.int-spec.ts, entered
   * through a file instead. The register a file leaves must not depend on which
   * of a person's apartments it lists first, and must read as the moves would
   * have left it: an import is how an association's earlier history reaches
   * the register, and that history is rarely sorted.
   */

  const OUT_OF_ORDER_HEADERS = [
    "Adress",
    "Lägenhetsnummer",
    "Förnamn",
    "Efternamn",
    "Roll",
    "E-postadress",
    "Inflyttningsdatum",
    "Utflyttningsdatum",
  ];

  function memberRow(
    actor: { email: string },
    firstName: string,
    apartmentNumber: string,
    movedInOn: string,
    movedOutOn = "",
  ): string[] {
    return [
      addressLabel,
      apartmentNumber,
      firstName,
      surname,
      "Medlem",
      actor.email,
      movedInOn,
      movedOutOn,
    ];
  }

  async function importRows(cookie: string, rows: string[][]): Promise<void> {
    const session = await uploadAndPreview(cookie, "historik.csv", [
      OUT_OF_ORDER_HEADERS,
      ...rows,
    ]);
    const response = await applyImport(cookie, session.sessionId);
    expect(response.statusCode).toBe(202);
    await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
  }

  async function registerRows(personId: string) {
    const entries = await prisma.memberRegisterEntry.findMany({
      where: { personId },
      orderBy: [{ eventOn: "asc" }, { createdAt: "asc" }],
      select: { eventType: true, eventOn: true, apartmentId: true },
    });
    return entries.map((entry) => ({
      eventType: entry.eventType,
      eventOn: entry.eventOn.toISOString().slice(0, 10),
      apartmentId: entry.apartmentId,
    }));
  }

  it("enters a back-dated move-in imported after a later one", async () => {
    const cookie = await signIn(actors.board.email);

    // Two files, as a board loading its history in two goes would: the later
    // purchase first, the earlier one after it. The same register the move
    // flow writes for the same two move-ins.
    await importRows(cookie, [
      memberRow(actors.backDater, "Bodil", "2108", "2027-01-01"),
    ]);
    await importRows(cookie, [
      memberRow(actors.backDater, "Bodil", "2107", "2026-10-01"),
    ]);

    expect(await registerRows(actors.backDater.personId)).toEqual([
      { eventType: "ENTRY", eventOn: "2026-10-01", apartmentId: apartments.g },
      { eventType: "ENTRY", eventOn: "2027-01-01", apartmentId: apartments.h },
    ]);
  }, 60_000);

  it("writes the EXIT when the earlier move-out is listed first", async () => {
    const cookie = await signIn(actors.board.email);

    await importRows(cookie, [
      memberRow(
        actors.lateRecorder,
        "Lars",
        "2110",
        "2021-01-01",
        "2026-11-01",
      ),
      memberRow(
        actors.lateRecorder,
        "Lars",
        "2109",
        "2020-01-01",
        "2026-12-01",
      ),
    ]);

    // One membership, ended on the later move-out, exactly as the move flow
    // records these two apartments.
    expect(await registerRows(actors.lateRecorder.personId)).toEqual([
      { eventType: "ENTRY", eventOn: "2020-01-01", apartmentId: apartments.i },
      { eventType: "EXIT", eventOn: "2026-12-01", apartmentId: apartments.i },
    ]);
  }, 60_000);

  it("keeps an earlier membership a file lists after a later one", async () => {
    const cookie = await signIn(actors.board.email);

    await importRows(cookie, [
      memberRow(actors.newestFirst, "Nora", "2112", "2022-01-01"),
      memberRow(actors.newestFirst, "Nora", "2111", "2010-01-01", "2015-01-01"),
    ]);

    // Listed newest first, this used to read as "member since 2022".
    expect(await registerRows(actors.newestFirst.personId)).toEqual([
      { eventType: "ENTRY", eventOn: "2010-01-01", apartmentId: apartments.k },
      { eventType: "EXIT", eventOn: "2015-01-01", apartmentId: apartments.k },
      { eventType: "ENTRY", eventOn: "2022-01-01", apartmentId: apartments.l },
    ]);
  }, 60_000);
});

describe("an apply overlapping a move", () => {
  it("waits for the move rather than reading round it", async () => {
    // Whether a member row begins a membership is decided from the person's
    // other tenant-ownerships held on its date, and the chunk reads them before
    // the row that would answer it exists. A move-in for the same person
    // committing inside that window is invisible to that read, so the chunk
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

describe("a row for someone already living in the apartment", () => {
  it("is reported as a problem rather than dropped without a word", async () => {
    // Rita is a resident of 2101. A file listing her as a member there gave a
    // preview saying "update" and an apply that wrote nothing at all.
    const cookie = await signIn(actors.board.email);
    const session = await upload(
      cookie,
      "rita.csv",
      encode(
        writeCsv([
          HEADERS,
          [
            addressLabel,
            "2101",
            "Rita",
            surname,
            "Medlem",
            actors.resident.email,
            "",
            "2023-01-01",
          ],
        ]),
      ),
    );
    const preview = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    const row = preview.rows[0];
    expect(row?.outcome).toBe("error");
    expect(row?.problems).toContainEqual({
      field: "movedInOn",
      reason: "residency-conflict",
    });

    expect((await applyImport(cookie, session.sessionId)).statusCode).toBe(202);
    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.result.errors).toBe(1);
    expect(run.result.residenciesCreated).toBe(0);
  }, 60_000);

  it("writes the second period of someone who moved out and back in", async () => {
    const cookie = await signIn(actors.board.email);
    const personId = `imp-returner-${suffix}`;
    const email = `imp-returner-${suffix}@exempel.se`;
    await createPerson({ personId, firstName: "Ragnar", email });
    await prisma.residency.create({
      data: {
        personId,
        apartmentId: apartments.b,
        role: "RESIDENT",
        movedInOn: new Date("2010-01-01T00:00:00.000Z"),
        movedOutOn: new Date("2015-01-01T00:00:00.000Z"),
      },
    });

    const session = await uploadAndPreview(cookie, "ragnar.csv", [
      HEADERS,
      [
        addressLabel,
        "2102",
        "Ragnar",
        surname,
        "Boende",
        email,
        "",
        "2018-01-01",
      ],
    ]);
    expect((await applyImport(cookie, session.sessionId)).statusCode).toBe(202);
    await waitForRun(
      cookie,
      session.sessionId,
      (run) => run.status === "APPLIED",
    );

    const periods = await prisma.residency.findMany({
      where: { personId, apartmentId: apartments.b },
      orderBy: { movedInOn: "asc" },
      select: { movedInOn: true, movedOutOn: true },
    });
    expect(periods.map((period) => period.movedInOn.toISOString())).toEqual([
      "2010-01-01T00:00:00.000Z",
      "2018-01-01T00:00:00.000Z",
    ]);
  }, 60_000);
});

describe("a file without move-in dates", () => {
  it("fills in a current resident rather than refusing them", async () => {
    // Ylva has lived in 2113 since 2015. A file with no move-in column says
    // she lives there; the date the board gave for the file is not a claim
    // that she moved in on it.
    const cookie = await signIn(actors.board.email);
    const personId = `imp-ylva-${suffix}`;
    const email = `imp-ylva-${suffix}@exempel.se`;
    await createPerson({ personId, firstName: "Ylva", email });
    await prisma.residency.create({
      data: {
        personId,
        apartmentId: apartments.m,
        role: "RESIDENT",
        movedInOn: new Date("2015-01-01T00:00:00.000Z"),
      },
    });

    const headers = HEADERS.filter((title) => title !== "Inflyttningsdatum");
    const session = await upload(
      cookie,
      "utan-datum.csv",
      encode(
        writeCsv([
          headers,
          [
            addressLabel,
            "2113",
            "Ylva",
            surname,
            "Boende",
            email,
            "070-123 45 67",
          ],
        ]),
      ),
    );
    const preview = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
      defaultMovedInOn: "2026-10-01",
    });
    const row = preview.rows[0];
    expect(row?.problems).toEqual([]);
    expect(row?.outcome).toBe("update");

    expect((await applyImport(cookie, session.sessionId)).statusCode).toBe(202);
    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) => candidate.status === "APPLIED",
    );
    expect(run.result.residenciesCreated).toBe(0);
    expect(await prisma.residency.count({ where: { personId } })).toBe(1);
    const ylva = await prisma.person.findUniqueOrThrow({
      where: { id: personId },
      select: { phoneCipher: true },
    });
    expect(ylva.phoneCipher).not.toBeNull();
  }, 60_000);
});

describe("a register that changes while a chunk waits for its lock", () => {
  it("plans the chunk again rather than skip a row it can now write", async () => {
    // Bert's row for 2113 overlaps the residency he holds there, until that
    // residency is ended while the chunk waits. The chunk's other rows already
    // lock 2113 and Bert, so only the row's missing ciphertext says the chunk
    // has to be planned again.
    const cookie = await signIn(actors.board.email);
    const personId = `imp-bert-${suffix}`;
    const email = `imp-bert-${suffix}@exempel.se`;
    await createPerson({ personId, firstName: "Bert", email });
    const held = await prisma.residency.create({
      data: {
        personId,
        apartmentId: apartments.m,
        role: "RESIDENT",
        movedInOn: new Date("2010-01-01T00:00:00.000Z"),
      },
      select: { id: true },
    });

    const session = await uploadAndPreview(cookie, "bert.csv", [
      HEADERS,
      [addressLabel, "2113", "Anneli", surname, "Boende", "", "", "2024-01-01"],
      [
        addressLabel,
        "2113",
        "Bert",
        surname,
        "Boende",
        email,
        "",
        "2024-01-01",
      ],
      [
        addressLabel,
        "2114",
        "Bert",
        surname,
        "Boende",
        email,
        "",
        "2024-01-01",
      ],
    ]);
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: {} },
    });

    let release = (): void => undefined;
    const lockHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Bert's transition lock is the last the chunk takes before it plans
    // again, so holding it stops the chunk between its two plans.
    const holder = prisma.$transaction(
      async (tx) => {
        await lockResidencyTransitions(tx, personId);
        await lockHeld;
      },
      { timeout: 30_000 },
    );
    await waitFor(
      async () =>
        (await advisoryLockCount(prisma, `residency:${personId}`, true)) > 0n,
    );
    const chunk = applies.applyNextChunk(session.sessionId);
    await waitFor(() => waitsForTransitionLock(personId));
    await prisma.residency.update({
      where: { id: held.id },
      data: { movedOutOn: new Date("2023-01-01T00:00:00.000Z") },
    });
    release();
    await holder;

    await expect(chunk).rejects.toThrow(/planned again/);
    await applies.applyNextChunk(session.sessionId);

    const residencies = await prisma.residency.findMany({
      where: { personId },
      orderBy: [{ apartmentId: "asc" }, { movedInOn: "asc" }],
      select: { apartmentId: true, movedInOn: true },
    });
    expect(
      residencies.map((residency) => [
        residency.apartmentId,
        residency.movedInOn.toISOString().slice(0, 10),
      ]),
    ).toEqual([
      [apartments.m, "2010-01-01"],
      [apartments.m, "2024-01-01"],
      [apartments.n, "2024-01-01"],
    ]);
  }, 60_000);
});

describe("a person entered while a chunk is applied", () => {
  // A chunk plans before its transaction opens and writes a row it planned as
  // a new person inside it. Somebody entered in between - added from the
  // address book, linked by a sign-up approval, moved in - is not in the plan,
  // and writing the row as planned enters one human being twice: an access
  // report or an erasure asked for by person then finds one of the two. The
  // chunk has to look again once it holds its locks, and stop rather than
  // decide who the row is about.
  //
  // Each case plays the other writer out as a transaction that holds a lock
  // the chunk takes, has written the person, and commits only once the chunk is
  // waiting for that lock. By then the chunk has planned without the person,
  // so what it writes is decided by whether it reads the register again after
  // the wait.

  async function applyWhileEntering(
    sessionId: string,
    lockKey: string,
    enter: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    let entered!: () => void;
    const written = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        await enter(tx);
        entered();
        await held;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    // Started only once the other transaction holds the lock and has written:
    // a chunk that got to the lock first would be the case where nothing
    // overlaps.
    await written;
    let chunkSettled = false;
    const chunk = applies
      .runApply(sessionId)
      .finally(() => (chunkSettled = true));

    await waitFor(
      async () =>
        chunkSettled || (await advisoryLockCount(prisma, lockKey, false)) > 0n,
    );
    release();
    await Promise.all([other, chunk]);
  }

  async function expectStoppedUnwritten(
    cookie: string,
    sessionId: string,
    firstName: string,
  ): Promise<void> {
    const run = await readRun(cookie, sessionId);
    expect(run.status).toBe("FAILED");
    expect(run.failureReason).toBe("register-changed-during-apply");
    // The chunk rolled back whole, its claim on the cursor included.
    expect(run.rowsDone).toBe(0);
    expect(run.result.personsCreated).toBe(0);
    // The person the other writer entered, and nobody beside them.
    expect(
      await prisma.person.count({ where: { firstName, lastName: surname } }),
    ).toBe(1);
  }

  async function queued(
    cookie: string,
    fileName: string,
    rows: string[][],
    decisions: Record<string, { action: "create" }> = {},
  ): Promise<string> {
    const session = await uploadAndPreview(cookie, fileName, rows);
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions },
    });
    return session.sessionId;
  }

  it("stops when somebody with the row's address is added", async () => {
    // The address book takes the address's lock before it writes the person,
    // as every writer of an address does, so the chunk waits for it here.
    const cookie = await signIn(actors.board.email);
    const email = `imp-late-entry-${suffix}@exempel.se`;
    const sessionId = await queued(cookie, "sen-adress.csv", [
      HEADERS,
      [
        addressLabel,
        "2115",
        "Senadress",
        surname,
        "Boende",
        email,
        "",
        "2024-02-01",
      ],
    ]);
    const emailIndex = await encryption.computeIndex("person.email", email);

    await applyWhileEntering(
      sessionId,
      `person-email:${emailIndex ?? ""}`,
      (tx) =>
        createPerson(
          {
            personId: `imp-late-email-${suffix}`,
            firstName: "Senadress",
            email,
          },
          tx,
        ),
    );

    await expectStoppedUnwritten(cookie, sessionId, "Senadress");
  }, 60_000);

  it("stops when somebody with the row's identity number is added", async () => {
    // An identity number has no lock of its own. The other writer holds the
    // apartment's instead, which only parks the chunk between its plan and its
    // second look; what the case shows is that the second look reads the
    // identity number too.
    const cookie = await signIn(actors.board.email);
    const [number = ""] = identityNumbers(1, "730909");
    const sessionId = await queued(cookie, "sen-personnummer.csv", [
      [...HEADERS, "Personnummer"],
      [
        addressLabel,
        "2115",
        "Sennummer",
        surname,
        "Boende",
        "",
        "",
        "2024-02-01",
        number,
      ],
    ]);

    await applyWhileEntering(
      sessionId,
      `residency-apartment:${apartments.o}`,
      (tx) =>
        createPerson(
          {
            personId: `imp-late-number-${suffix}`,
            firstName: "Sennummer",
            identityNumber: number,
          },
          tx,
        ),
    );

    await expectStoppedUnwritten(cookie, sessionId, "Sennummer");
  }, 60_000);

  it("stops when somebody of the row's name moves into its apartment", async () => {
    // A move-in takes the apartment's lock before it writes the residency, as
    // every writer of a residency does, so the chunk waits for it here.
    const cookie = await signIn(actors.board.email);
    const sessionId = await queued(cookie, "sen-inflyttning.csv", [
      HEADERS,
      [
        addressLabel,
        "2115",
        "Seninflytt",
        surname,
        "Boende",
        "",
        "",
        "2024-02-01",
      ],
    ]);

    await applyWhileEntering(
      sessionId,
      `residency-apartment:${apartments.o}`,
      async (tx) => {
        const personId = `imp-late-mover-${suffix}`;
        await createPerson({ personId, firstName: "Seninflytt" }, tx);
        await tx.residency.create({
          data: {
            personId,
            apartmentId: apartments.o,
            role: "RESIDENT",
            movedInOn: new Date("2024-02-01T00:00:00.000Z"),
          },
        });
      },
    );

    await expectStoppedUnwritten(cookie, sessionId, "Seninflytt");
  }, 60_000);

  it("stops when somebody with the address of a row the board made new is added", async () => {
    // The row's address belongs to somebody of another name, so the row waits
    // for the board, which decides it is a person of their own. The board saw
    // one person under the address; a second one added since is somebody it
    // never chose against.
    const cookie = await signIn(actors.board.email);
    const email = `imp-late-choice-${suffix}@exempel.se`;
    await createPerson({
      personId: `imp-late-choice-known-${suffix}`,
      firstName: "Senkänd",
      email,
    });
    const sessionId = await queued(
      cookie,
      "sen-val.csv",
      [
        HEADERS,
        [
          addressLabel,
          "2115",
          "Senval",
          surname,
          "Boende",
          email,
          "",
          "2024-02-01",
        ],
      ],
      { "1": { action: "create" } },
    );
    const emailIndex = await encryption.computeIndex("person.email", email);

    await applyWhileEntering(
      sessionId,
      `person-email:${emailIndex ?? ""}`,
      (tx) =>
        createPerson(
          {
            personId: `imp-late-choice-added-${suffix}`,
            firstName: "Senval",
            email,
          },
          tx,
        ),
    );

    await expectStoppedUnwritten(cookie, sessionId, "Senval");
  }, 60_000);

  it("stops when somebody is given the address a later row adds to a new person", async () => {
    // Row 1 enters a person without an address. Row 2 reaches them by name in
    // the same apartment and gives them one. Nobody had that address when the
    // chunk was planned, or row 2 would have been matched by it; somebody given
    // it since would be the person row 2 is about.
    const cookie = await signIn(actors.board.email);
    const email = `imp-late-second-row-${suffix}@exempel.se`;
    const row = [addressLabel, "2115", "Senrad", surname, "Boende"];
    const sessionId = await queued(cookie, "sen-rad.csv", [
      HEADERS,
      [...row, "", "", "2024-02-01"],
      [...row, email, "", "2024-02-01"],
    ]);
    const emailIndex = await encryption.computeIndex("person.email", email);

    await applyWhileEntering(
      sessionId,
      `person-email:${emailIndex ?? ""}`,
      (tx) =>
        createPerson(
          {
            personId: `imp-late-second-row-${suffix}`,
            firstName: "Senepost",
            email,
          },
          tx,
        ),
    );

    await expectStoppedUnwritten(cookie, sessionId, "Senepost");
    expect(
      await prisma.person.count({
        where: { firstName: "Senrad", lastName: surname },
      }),
    ).toBe(0);
  }, 60_000);

  it("writes a row the board made new past somebody under a key the plan never looked under", async () => {
    // The row's address reaches somebody of another name, and the plan looks
    // no further: a namesake living in the apartment was never a candidate,
    // and a re-preview would show the row exactly as the board answered it.
    // Stopping on them would stop every attempt at the file.
    const cookie = await signIn(actors.board.email);
    const email = `imp-unasked-key-${suffix}@exempel.se`;
    await createPerson({
      personId: `imp-unasked-key-address-${suffix}`,
      firstName: "Senannan",
      email,
    });
    const residentId = `imp-unasked-key-resident-${suffix}`;
    await createPerson({ personId: residentId, firstName: "Senbo" });
    await prisma.residency.create({
      data: {
        personId: residentId,
        apartmentId: apartments.o,
        role: "RESIDENT",
        movedInOn: new Date("2024-01-01T00:00:00.000Z"),
      },
    });
    const sessionId = await queued(
      cookie,
      "sen-obesokt.csv",
      [
        HEADERS,
        [
          addressLabel,
          "2115",
          "Senbo",
          surname,
          "Boende",
          email,
          "",
          "2024-02-01",
        ],
      ],
      { "1": { action: "create" } },
    );

    await applies.runApply(sessionId);

    const run = await readRun(cookie, sessionId);
    expect(run.status).toBe("APPLIED");
    expect(run.result.personsCreated).toBe(1);
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

    // Closed by hand, as the dead letter would: only one import is applied at
    // a time, and the cases after this one start imports of their own.
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "FAILED", failureReason: "apply-interrupted" },
    });
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
        apartmentId: apartments.m,
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
        "2113",
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
    const preview = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
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
    expect(byNumber.residencies).toEqual([{ apartmentId: apartments.m }]);

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
    const response = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    return {
      sessionId: session.sessionId,
      preview: response,
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
        apartmentId: apartments.n,
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
        "2114",
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
      residencies: [{ apartmentId: apartments.n }],
    });
    expect(
      await prisma.person.count({
        where: { lastName: surname, firstName: "Framling" },
      }),
    ).toBe(1);
  }, 120_000);
});

describe("a person listed twice, the second time by identity number alone", () => {
  it("is written to the person the first row reached, however far apart the rows are", async () => {
    // Already in the register with an email address and no identity number.
    // Row 1 reaches them by email, so its number is not written onto them.
    // Row 150 is their second apartment with the number and nothing else to
    // know them by, and it falls in the second chunk, which meets a register
    // where nobody holds that number.
    const cookie = await signIn(actors.board.email);
    const [number] = identityNumbers(1, "680215");
    const person = {
      personId: `imp-twice-${suffix}`,
      firstName: "Tvagang",
      email: `imp-twice-${suffix}@exempel.se`,
    };
    await createPerson(person);
    const total = IMPORT_CHUNK_ROWS + 60;
    const row = (
      apartment: string,
      firstName: string,
      email: string,
      identityNumber: string,
      movedInOn = "2021-04-01",
    ) => [
      addressLabel,
      apartment,
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
        rows.push(row("2113", person.firstName, person.email, number ?? ""));
      } else if (rowNumber === 150) {
        rows.push(row("2114", person.firstName, "", number ?? ""));
      } else {
        rows.push(row("2102", `Tva${String(rowNumber)}`, "", "", "01/03/2020"));
      }
    }

    const session = await upload(
      cookie,
      "tva-lagenheter.csv",
      encode(writeCsv(rows)),
    );
    const planned = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    expect(planned.rows[149]).toMatchObject({
      outcome: "update",
      matchedPersonId: person.personId,
      matchedBy: "earlierRow",
      sameAsRowNumber: 1,
    });
    expect(planned.summary.create).toBe(0);

    expect((await applyImport(cookie, session.sessionId)).statusCode).toBe(202);
    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
      90_000,
    );
    expect(run.status).toBe("APPLIED");
    expect(run.result).toMatchObject({ personsCreated: 0, personsUpdated: 2 });

    expect(
      await prisma.person.count({
        where: { lastName: surname, firstName: person.firstName },
      }),
    ).toBe(1);
    const stored = await prisma.person.findUniqueOrThrow({
      where: { id: person.personId },
      select: {
        personalIdentityNumberIndex: true,
        residencies: { select: { apartmentId: true } },
      },
    });
    // Both apartments, and still no number: neither row reached them by it.
    expect(stored.personalIdentityNumberIndex).toBeNull();
    expect(
      stored.residencies.map((residency) => residency.apartmentId).sort(),
    ).toEqual([apartments.m, apartments.n].sort());
  }, 180_000);
});

describe("a decision for a row that does not need one", () => {
  // The file of the case above: row 1 reaches a register person with no
  // identity number by email, and row 150, in the second chunk, reaches them
  // through row 1's number. Neither row needs a decision.
  async function uploadTwice(label: string): Promise<{
    session: ImportSessionView;
    person: { personId: string };
    number: string;
  }> {
    const cookie = await signIn(actors.board.email);
    const [number = ""] = identityNumbers(1, "710312");
    const person = {
      personId: `imp-undecided-${label}-${suffix}`,
      firstName: `Obeslutad${label}`,
      email: `imp-undecided-${label}-${suffix}@exempel.se`,
    };
    await createPerson(person);
    const row = (
      apartment: string,
      firstName: string,
      email: string,
      identityNumber: string,
      movedInOn = "2021-04-01",
    ) => [
      addressLabel,
      apartment,
      firstName,
      surname,
      "Boende",
      email,
      "",
      movedInOn,
      identityNumber,
    ];

    const rows: string[][] = [[...HEADERS, "Personnummer"]];
    for (let rowNumber = 1; rowNumber <= IMPORT_CHUNK_ROWS + 60; rowNumber++) {
      if (rowNumber === 1) {
        rows.push(row("2113", person.firstName, person.email, number));
      } else if (rowNumber === 150) {
        rows.push(row("2114", person.firstName, "", number));
      } else {
        rows.push(row("2102", `Obe${String(rowNumber)}`, "", "", "01/03/2020"));
      }
    }

    const session = await uploadAndPreview(cookie, `${label}.csv`, rows);
    return { session, person, number };
  }

  it("is refused at the apply, and nothing is written", async () => {
    const cookie = await signIn(actors.board.email);
    const { session, person } = await uploadTwice("refused");

    const response = await applyImport(cookie, session.sessionId, {
      "150": { action: "use-person", personId: person.personId },
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("preview-outdated");
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
    expect(
      await prisma.residency.count({ where: { personId: person.personId } }),
    ).toBe(0);
  }, 120_000);

  it("does not give the number to the person it names when the register changes between chunks", async () => {
    // Stored as though an apply had accepted it. Between the chunks somebody
    // else is given the number in the register, so row 150 then matches both
    // of them by it, and the stored decision answers that.
    const { session, person, number } = await uploadTwice("stored");
    const other = {
      personId: `imp-undecided-other-${suffix}`,
      firstName: "Nummerhavare",
    };
    await createPerson(other);
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: {
        status: "QUEUED",
        decisions: {
          "150": { action: "use-person", personId: person.personId },
        },
      },
    });

    expect(await applies.applyNextChunk(session.sessionId)).toBe(true);
    const given = await encryption.encrypt(
      "person.personalIdentityNumber",
      number,
    );
    await prisma.person.update({
      where: { id: other.personId },
      data: {
        personalIdentityNumberCipher: given.cipher,
        personalIdentityNumberIndex: given.index,
      },
    });
    while (await applies.applyNextChunk(session.sessionId)) {
      // On to the end.
    }

    expect(
      await prisma.person.findUniqueOrThrow({
        where: { id: person.personId },
        select: {
          personalIdentityNumberCipher: true,
          personalIdentityNumberIndex: true,
        },
      }),
    ).toEqual({
      personalIdentityNumberCipher: null,
      personalIdentityNumberIndex: null,
    });
  }, 120_000);

  it("is refused before it is read when its row number is not one", async () => {
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(cookie, "fel-nyckel.csv", [
      HEADERS,
      [addressLabel, "2102", "Nyckel", surname, "Boende", "", "", "2021-04-01"],
    ]);

    // Asserted on the reason rather than the status alone: the apply also
    // refuses a decision for a row that asked for none, as preview-outdated
    // and with the same 400, so a status would pass with the key check gone.
    // The preview shares the schema and has no such check of its own.
    for (const decisions of [
      { first: { action: "skip" } },
      { "0": { action: "skip" } },
      Object.fromEntries(
        Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => [
          String(index + 1),
          { action: "skip" },
        ]),
      ),
    ]) {
      for (const response of [
        await applyImport(cookie, session.sessionId, decisions),
        await inject({
          method: "POST",
          url: `/api/import/sessions/${session.sessionId}/preview`,
          payload: { mapping: session.suggestedMapping, decisions },
          headers: { cookie },
        }),
      ]) {
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toMatchObject({
          reason: "invalid-body",
          issues: expect.arrayContaining([
            expect.objectContaining({
              path: expect.stringMatching(/^decisions(\.|$)/),
            }),
          ]),
        });
      }
    }
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
  });
});

describe("a decided row the register stops asking about between chunks", () => {
  // Row 150, in the second chunk, reaches a register person by email but gives
  // them another first name, so it waits for a decision. Between the chunks the
  // register's name is corrected to the file's, and the row then matches that
  // person and nobody else.
  it.each(["skip", "create"] as const)(
    "stops the apply rather than write a row decided %s to the person it now matches",
    async (action) => {
      const cookie = await signIn(actors.board.email);
      const person = {
        personId: `imp-stale-${action}-${suffix}`,
        firstName: `Tidigare${action}`,
        email: `imp-stale-${action}-${suffix}@exempel.se`,
      };
      await createPerson(person);
      const corrected = `Rattad${action}`;

      const rows: string[][] = [HEADERS];
      for (
        let rowNumber = 1;
        rowNumber <= IMPORT_CHUNK_ROWS + 60;
        rowNumber++
      ) {
        rows.push(
          rowNumber === 150
            ? [
                addressLabel,
                "2113",
                corrected,
                surname,
                "Boende",
                person.email,
                "070-333 00 33",
                "2021-04-01",
              ]
            : // A date nobody can read: a row with a problem, which writes
              // nothing and needs no decision.
              [
                addressLabel,
                "2102",
                `Inaktuell${String(rowNumber)}`,
                surname,
                "Boende",
                "",
                "",
                "01/03/2020",
              ],
        );
      }
      const session = await upload(
        cookie,
        `inaktuellt-val-${action}.csv`,
        encode(writeCsv(rows)),
      );
      const preview = await previewImport(cookie, session.sessionId, {
        mapping: session.suggestedMapping,
      });
      expect(preview.rows.find((row) => row.rowNumber === 150)).toMatchObject({
        outcome: "ambiguous",
        matchedBy: "email",
        mismatch: "name",
        candidates: [{ personId: person.personId }],
      });

      // Stored as an apply accepts it, with no job behind it, so the test runs
      // the chunks itself.
      await prisma.importSession.update({
        where: { id: session.sessionId },
        data: { status: "QUEUED", decisions: { "150": { action } } },
      });
      expect(await applies.applyNextChunk(session.sessionId)).toBe(true);
      await prisma.person.update({
        where: { id: person.personId },
        data: { firstName: corrected },
      });
      expect(await applies.applyNextChunk(session.sessionId)).toBe(false);

      expect(await readRun(cookie, session.sessionId)).toMatchObject({
        status: "FAILED",
        failureReason: "preview-outdated",
        rowsDone: IMPORT_CHUNK_ROWS,
        result: { personsCreated: 0, personsUpdated: 0 },
      });
      expect(
        await prisma.person.findUniqueOrThrow({
          where: { id: person.personId },
          select: {
            phoneCipher: true,
            residencies: { select: { id: true } },
            memberRegisterEntries: { select: { id: true } },
          },
        }),
      ).toEqual({
        phoneCipher: null,
        residencies: [],
        memberRegisterEntries: [],
      });
      expect(
        await prisma.person.count({
          where: { firstName: corrected, lastName: surname },
        }),
      ).toBe(1);
    },
    120_000,
  );
});

describe("a decided row that matches more people between chunks", () => {
  // A file of two chunks with one row in the second that writes anything; the
  // rest have a date nobody can read, and write nothing.
  function twoChunks(row: (rowNumber: number) => string[] | null): string[][] {
    const rows: string[][] = [HEADERS];
    for (let rowNumber = 1; rowNumber <= IMPORT_CHUNK_ROWS + 10; rowNumber++) {
      rows.push(
        row(rowNumber) ?? [
          addressLabel,
          "2102",
          `Fyllnad${String(rowNumber)}`,
          surname,
          "Boende",
          "",
          "",
          "01/03/2020",
        ],
      );
    }
    return rows;
  }

  it("stops when somebody with the address of a row the board made new is added after the apply began", async () => {
    // Row 105 reaches a register person by email but gives them another first
    // name, so it waits, and the board makes it a person of their own. Before
    // the second chunk is planned somebody else is given that address. The
    // chunk's plan then lists both, and the board chose against only one of
    // them: written, the row would be a second record of the person added.
    const cookie = await signIn(actors.board.email);
    const email = `imp-later-chunk-${suffix}@exempel.se`;
    const known = `imp-later-chunk-known-${suffix}`;
    await createPerson({ personId: known, firstName: "Senkandid", email });
    const session = await uploadAndPreview(
      cookie,
      "senare-del.csv",
      twoChunks((rowNumber) =>
        rowNumber === IMPORT_CHUNK_ROWS + 5
          ? [
              addressLabel,
              "2115",
              "Senaredel",
              surname,
              "Boende",
              email,
              "",
              "2024-02-01",
            ]
          : null,
      ),
    );
    const previewed = await prisma.importSession.findUniqueOrThrow({
      where: { id: session.sessionId },
      select: { ambiguousRows: true },
    });
    expect(previewed.ambiguousRows).toEqual({ "105": [known] });

    // Stored as an apply accepts it, with no job behind it, so the test runs
    // the chunks itself.
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: { status: "QUEUED", decisions: { "105": { action: "create" } } },
    });
    expect(await applies.applyNextChunk(session.sessionId)).toBe(true);
    await createPerson({
      personId: `imp-later-chunk-added-${suffix}`,
      firstName: "Senaredel",
      email,
    });
    expect(await applies.applyNextChunk(session.sessionId)).toBe(false);

    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "FAILED",
      failureReason: "register-changed-during-apply",
      rowsDone: IMPORT_CHUNK_ROWS,
      result: { personsCreated: 0 },
    });
    expect(
      await prisma.person.count({
        where: { firstName: "Senaredel", lastName: surname },
      }),
    ).toBe(1);
  }, 120_000);

  it("writes a row the board made new past a person an earlier chunk created", async () => {
    // Two people sharing an address, a chunk apart. Row 1 enters the first.
    // Row 105 reaches them by that address under another first name, so it
    // waits, and the preview lists nobody for it: the first has no id yet. The
    // second chunk finds them in the register, and has to take them for what
    // they are - somebody this import entered - and not for somebody new.
    const cookie = await signIn(actors.board.email);
    const email = `imp-shared-address-${suffix}@exempel.se`;
    const partner = (firstName: string): string[] => [
      addressLabel,
      "2115",
      firstName,
      surname,
      "Boende",
      email,
      "",
      "2024-02-01",
    ];
    const session = await uploadAndPreview(
      cookie,
      "delad-adress.csv",
      twoChunks((rowNumber) =>
        rowNumber === 1
          ? partner("Delaren")
          : rowNumber === IMPORT_CHUNK_ROWS + 5
            ? partner("Delarinnan")
            : null,
      ),
    );
    const previewed = await prisma.importSession.findUniqueOrThrow({
      where: { id: session.sessionId },
      select: { ambiguousRows: true },
    });
    expect(previewed.ambiguousRows).toEqual({ "105": [] });

    expect(
      (
        await applyImport(cookie, session.sessionId, {
          "105": { action: "create" },
        })
      ).statusCode,
    ).toBe(202);

    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
    );
    expect(run).toMatchObject({
      status: "APPLIED",
      rowsDone: IMPORT_CHUNK_ROWS + 10,
      result: { personsCreated: 2 },
    });
  }, 120_000);
});

describe("a decided row somebody joins the candidates of", () => {
  // Two people of one name live in 2116, and a row naming them waits for the
  // board. A third of that name moves in after the board decided. The row is
  // still ambiguous and the person the board chose is still a candidate, so
  // only the candidates the board decided against tell the newcomer apart from
  // the two it saw.
  //
  // `undated` leaves the row's move-in date to the file's default. A row that
  // states its own is matched against ended residencies too, so a candidate
  // who moves out is still one of the persons it could be, and the board's
  // question has not changed; an undated row is matched against current
  // residents only, and loses them.
  async function twoOfAName(
    label: string,
    { undated = false }: { undated?: boolean } = {},
  ): Promise<{
    cookie: string;
    sessionId: string;
    firstName: string;
    personIds: string[];
  }> {
    const cookie = await signIn(actors.board.email);
    const firstName = `Trilling${label}`;
    const personIds = [
      `imp-trio-${label}-a-${suffix}`,
      `imp-trio-${label}-b-${suffix}`,
    ];
    for (const personId of personIds) {
      await moveIn(personId, firstName);
    }
    const session = await upload(
      cookie,
      `trilling-${label}.csv`,
      encode(
        writeCsv([
          HEADERS,
          [
            addressLabel,
            "2116",
            firstName,
            surname,
            "Boende",
            "",
            "070-444 00 44",
            undated ? "" : "2024-02-01",
          ],
        ]),
      ),
    );
    await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
      ...(undated ? { defaultMovedInOn: "2024-02-01" } : {}),
    });
    return { cookie, sessionId: session.sessionId, firstName, personIds };
  }

  async function moveIn(
    personId: string,
    firstName: string,
    client: Prisma.TransactionClient = prisma,
  ): Promise<void> {
    await createPerson({ personId, firstName }, client);
    await client.residency.create({
      data: {
        personId,
        apartmentId: apartments.p,
        role: "RESIDENT",
        movedInOn: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
  }

  function decision(
    action: "create" | "use-person",
    personIds: readonly string[],
  ): Record<string, unknown> {
    return {
      "1":
        action === "create"
          ? { action }
          : { action, personId: personIds[0] ?? "" },
    };
  }

  async function expectStoppedUnwritten(
    cookie: string,
    sessionId: string,
    firstName: string,
    personIds: readonly string[],
    persons = 3,
  ): Promise<void> {
    const run = await waitForRun(
      cookie,
      sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
    );
    expect(run).toMatchObject({
      status: "FAILED",
      failureReason: "register-changed-during-apply",
      rowsDone: 0,
      result: { personsCreated: 0, personsUpdated: 0 },
    });
    // The ones who live or lived there, and nobody the row entered beside
    // them.
    expect(
      await prisma.person.count({ where: { firstName, lastName: surname } }),
    ).toBe(persons);
    // Nor did the row reach the person the board chose.
    expect(
      await prisma.person.findUniqueOrThrow({
        where: { id: personIds[0] },
        select: { phoneCipher: true },
      }),
    ).toEqual({ phoneCipher: null });
  }

  it.each(["create", "use-person"] as const)(
    "stops a decision to %s when somebody joins before the chunk plans",
    async (action) => {
      const { cookie, sessionId, firstName, personIds } = await twoOfAName(
        `plan-${action}`,
      );

      // The apply request has checked the decision against the register by
      // the time it creates the queues, and the chunk plans only once the job
      // is queued after that. The third of the name moves in in between.
      const ensureQueues = applies.ensureQueues.bind(applies);
      const paused = vi
        .spyOn(applies, "ensureQueues")
        .mockImplementationOnce(async () => {
          await moveIn(`imp-trio-plan-${action}-c-${suffix}`, firstName);
          await ensureQueues();
        });
      try {
        const response = await applyImport(
          cookie,
          sessionId,
          decision(action, personIds),
        );
        expect(response.statusCode).toBe(202);
      } finally {
        paused.mockRestore();
      }

      await expectStoppedUnwritten(cookie, sessionId, firstName, personIds);
    },
    60_000,
  );

  it.each(["create", "use-person"] as const)(
    "stops a decision to %s when somebody joins while the chunk waits for its locks",
    async (action) => {
      const { cookie, sessionId, firstName, personIds } = await twoOfAName(
        `lock-${action}`,
      );

      // A move-in takes the apartment's lock before it writes the residency,
      // as every writer of a residency does. This one holds it with the third
      // of the name written, so the apply request and the chunk's plan both
      // read the register without them, and commits only once the chunk is
      // waiting for that lock.
      const lockKey = `residency-apartment:${apartments.p}`;
      let entered!: () => void;
      const written = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const other = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
          await moveIn(`imp-trio-lock-${action}-c-${suffix}`, firstName, tx);
          entered();
          await held;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      try {
        await written;
        const response = await applyImport(
          cookie,
          sessionId,
          decision(action, personIds),
        );
        expect(response.statusCode).toBe(202);
        await waitFor(
          async () => (await advisoryLockCount(prisma, lockKey, false)) > 0n,
        );
      } finally {
        release();
        await other;
      }

      await expectStoppedUnwritten(cookie, sessionId, firstName, personIds);
    },
    60_000,
  );

  /** Ends the residency in 2116 of the candidate the board decided against. */
  async function moveOut(
    personId: string,
    client: Prisma.TransactionClient = prisma,
  ): Promise<void> {
    const ended = await client.residency.updateMany({
      where: { personId, apartmentId: apartments.p, movedOutOn: null },
      data: { movedOutOn: new Date("2024-01-01T00:00:00.000Z") },
    });
    expect(ended.count).toBe(1);
  }

  it.each(["create", "use-person"] as const)(
    "stops a decision to %s when a candidate leaves after the chunk plans",
    async (action) => {
      const { cookie, sessionId, firstName, personIds } = await twoOfAName(
        `left-${action}`,
        { undated: true },
      );

      // The chunk's plan still finds both of them. The one the board decided
      // against moves out before its transaction opens, which leaves the row
      // with a single person of the name - a question the board was not asked.
      const planner = app.get(ImportPlannerService);
      const plan = planner.plan.bind(planner);
      const planned = vi
        .spyOn(planner, "plan")
        .mockImplementation(async (request) => {
          const result = await plan(request);
          if (request.window !== undefined) {
            planned.mockRestore();
            await moveOut(personIds[1] ?? "");
          }
          return result;
        });
      try {
        const response = await applyImport(
          cookie,
          sessionId,
          decision(action, personIds),
        );
        expect(response.statusCode).toBe(202);
        await expectStoppedUnwritten(
          cookie,
          sessionId,
          firstName,
          personIds,
          2,
        );
      } finally {
        planned.mockRestore();
      }
    },
    60_000,
  );

  it.each(["create", "use-person"] as const)(
    "stops a decision to %s when a candidate leaves while the chunk waits for its locks",
    async (action) => {
      const { cookie, sessionId, firstName, personIds } = await twoOfAName(
        `leave-${action}`,
        { undated: true },
      );
      const leaving = personIds[1] ?? "";

      // A move-out takes the person's transition lock before it ends the
      // residency, as everything that takes a person out of the register
      // does. This one holds it with the residency ended, so the apply request
      // and the chunk's plan both still find them, and commits only once the
      // chunk is waiting for that lock: the chunk takes it for every candidate
      // of a row the board decided, written to or not.
      let entered!: () => void;
      const ended = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const other = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`residency:${leaving}`}))`;
          await moveOut(leaving, tx);
          entered();
          await held;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      try {
        await ended;
        const response = await applyImport(
          cookie,
          sessionId,
          decision(action, personIds),
        );
        expect(response.statusCode).toBe(202);
        await waitFor(() => waitsForTransitionLock(leaving));
      } finally {
        release();
        await other;
      }

      await expectStoppedUnwritten(cookie, sessionId, firstName, personIds, 2);
    },
    60_000,
  );

  it("knows the person an earlier chunk created for a row it offers", async () => {
    // Row 1 and a row of the second chunk both name one of the two, and the
    // board makes each a person of their own. The preview offers the later row
    // the two and the person row 1 creates; the second chunk meets that person
    // in the register, by an id the preview never had, and must not take them
    // for a newcomer.
    const { cookie, firstName, personIds } = await twoOfAName("chunks");
    const later = IMPORT_CHUNK_ROWS + 50;
    const row = (rowNumber: number): string[] =>
      rowNumber === 1 || rowNumber === later
        ? [
            addressLabel,
            "2116",
            firstName,
            surname,
            "Boende",
            "",
            "",
            "2024-02-01",
          ]
        : // A date nobody can read: a row with a problem, which writes
          // nothing and needs no decision.
          [
            addressLabel,
            "2102",
            `Fyrling${String(rowNumber)}`,
            surname,
            "Boende",
            "",
            "",
            "01/03/2020",
          ];
    const rows: string[][] = [HEADERS];
    for (let rowNumber = 1; rowNumber <= IMPORT_CHUNK_ROWS + 60; rowNumber++) {
      rows.push(row(rowNumber));
    }
    const session = await upload(cookie, "fyrling.csv", encode(writeCsv(rows)));
    const decisions = {
      "1": { action: "create" },
      [String(later)]: { action: "create" },
    };
    const preview = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
      decisions,
    });
    expect(
      preview.rows.find(({ rowNumber }) => rowNumber === later),
    ).toMatchObject({
      outcome: "ambiguous",
      candidates: expect.arrayContaining(
        personIds.map((personId) => expect.objectContaining({ personId })),
      ) as unknown,
    });

    const response = await applyImport(cookie, session.sessionId, decisions);
    expect(response.statusCode).toBe(202);

    const run = await waitForRun(
      cookie,
      session.sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
    );
    expect(run).toMatchObject({
      status: "APPLIED",
      result: { personsCreated: 2 },
    });
    expect(
      await prisma.person.count({ where: { firstName, lastName: surname } }),
    ).toBe(4);
  }, 120_000);

  it("writes past a row left out when somebody joins its candidates", async () => {
    // A row the board decided to skip writes nothing whoever it matches, so a
    // third of the name moving in before the chunk plans stops nothing.
    const { cookie, sessionId, firstName } = await twoOfAName("skip");

    const ensureQueues = applies.ensureQueues.bind(applies);
    const paused = vi
      .spyOn(applies, "ensureQueues")
      .mockImplementationOnce(async () => {
        await moveIn(`imp-trio-skip-c-${suffix}`, firstName);
        await ensureQueues();
      });
    try {
      const response = await applyImport(cookie, sessionId, {
        "1": { action: "skip" },
      });
      expect(response.statusCode).toBe(202);
    } finally {
      paused.mockRestore();
    }

    const run = await waitForRun(
      cookie,
      sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
    );
    expect(run).toMatchObject({
      status: "APPLIED",
      result: { personsCreated: 0, personsUpdated: 0, skipped: 1 },
    });
    expect(
      await prisma.person.count({ where: { firstName, lastName: surname } }),
    ).toBe(3);
  }, 60_000);

  it("writes a decided row whose candidates are the ones the board saw", async () => {
    // The same file, and nobody moves in: the check stops nothing it should
    // not.
    const { cookie, sessionId, firstName, personIds } =
      await twoOfAName("unchanged");

    const response = await applyImport(
      cookie,
      sessionId,
      decision("create", personIds),
    );
    expect(response.statusCode).toBe(202);

    const run = await waitForRun(
      cookie,
      sessionId,
      (candidate) =>
        candidate.status !== "QUEUED" && candidate.status !== "APPLYING",
    );
    expect(run).toMatchObject({
      status: "APPLIED",
      result: { personsCreated: 1 },
    });
    expect(
      await prisma.person.count({ where: { firstName, lastName: surname } }),
    ).toBe(3);
  }, 60_000);
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
        rows.push(row("2103", twinFirstName, email, twinsMovedInOn));
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
      const response = await previewImport(cookie, session.sessionId, {
        mapping: session.suggestedMapping,
        decisions,
      });
      return response;
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

  it("is refused at the apply when the decision creates a person", async () => {
    // Row 10 has the address of a person already in the register and another
    // name, and the board makes it a person of its own - who then has that
    // address too. Row 150, in the second chunk, is the register person's own
    // row: an update in the preview, but two people share its address once row
    // 10 is written.
    const cookie = await signIn(actors.board.email);
    const email = `imp-created-${suffix}@exempel.se`;
    const registered = {
      personId: `imp-created-${suffix}`,
      firstName: "Registrerad",
      email,
    };
    await createPerson(registered);
    const total = IMPORT_CHUNK_ROWS + 60;
    const row = (firstName: string, address: string, movedInOn: string) => [
      addressLabel,
      "2102",
      firstName,
      surname,
      "Boende",
      address,
      "",
      movedInOn,
    ];

    const rows: string[][] = [HEADERS];
    for (let rowNumber = 1; rowNumber <= total; rowNumber++) {
      if (rowNumber === 10) {
        rows.push(row("Nyskapad", email, "2021-04-01"));
      } else if (rowNumber === 150) {
        rows.push(row("Registrerad", email, "2021-04-01"));
      } else {
        rows.push(row(`Skapad${String(rowNumber)}`, "", "01/03/2020"));
      }
    }

    const session = await upload(
      cookie,
      "skapad-rad.csv",
      encode(writeCsv(rows)),
    );
    const preview = async (decisions: Record<string, unknown>) => {
      const response = await previewImport(cookie, session.sessionId, {
        mapping: session.suggestedMapping,
        decisions,
      });
      return response;
    };

    const first = await preview({});
    expect(first.summary.ambiguous).toBe(1);
    expect(first.rows[9]).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "email",
      mismatch: "name",
    });
    expect(first.rows[149]).toMatchObject({
      outcome: "update",
      matchedPersonId: registered.personId,
    });

    const decided = { "10": { action: "create" } };
    const refused = await applyImport(cookie, session.sessionId, decided);
    expect(refused.statusCode).toBe(400);
    expect(reasonOf(refused)).toBe("ambiguous-rows-undecided");

    // Nothing was queued and nothing was written.
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
    expect(
      await prisma.person.count({
        where: { lastName: surname, firstName: "Nyskapad" },
      }),
    ).toBe(0);
    expect(
      await prisma.residency.count({
        where: { personId: registered.personId },
      }),
    ).toBe(0);

    // Previewed again with the decision, row 150 needs one too. The person row
    // 10 creates has no id yet, so the register person is the one offered.
    const second = await preview(decided);
    expect(second.summary.ambiguous).toBe(2);
    expect(second.rows[149]).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "email",
      candidates: [
        { personId: registered.personId, name: `Registrerad ${surname}` },
      ],
    });

    const accepted = await applyImport(cookie, session.sessionId, {
      ...decided,
      "150": { action: "use-person", personId: registered.personId },
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
      await prisma.residency.count({
        where: { personId: registered.personId },
      }),
    ).toBe(1);
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

  it("is refused when a decision settles a row left without one", async () => {
    // As above, but the board answers row 1 only. Row 2 is no longer asking
    // once row 1 is a new person, so that is what is refused - not the lack of
    // an answer for a row that has stopped needing one.
    const cookie = await signIn(actors.board.email);
    const email = `imp-unanswered-${suffix}@exempel.se`;
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
    const session = await upload(
      cookie,
      "obesvarad-rad.csv",
      encode(writeCsv([HEADERS, row, row])),
    );
    const previewed = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
    });
    expect(previewed.rows.map((planned) => planned.outcome)).toEqual([
      "ambiguous",
      "ambiguous",
    ]);

    const dubbels = () =>
      prisma.person.count({
        where: { lastName: surname, firstName: twinFirstName },
      });
    const before = await dubbels();

    const response = await applyImport(cookie, session.sessionId, {
      "1": { action: "create" },
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("preview-outdated");
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
    expect(await dubbels()).toBe(before);
  });

  it("is refused when the people a row matches are not the ones the preview named", async () => {
    // The preview asked about row 1 with the two Dubbels as its candidates.
    // The stored candidates are rewritten to stand in for a register that
    // has changed since then: the board's answer names a person the row no
    // longer has to choose between, so it must be asked again.
    const cookie = await signIn(actors.board.email);
    const session = await uploadAndPreview(cookie, "andrade-kandidater.csv", [
      HEADERS,
      [
        addressLabel,
        "2103",
        twinFirstName,
        surname,
        "Boende",
        `imp-changed-${suffix}@exempel.se`,
        "",
        "2021-04-01",
      ],
    ]);
    await prisma.importSession.update({
      where: { id: session.sessionId },
      data: {
        ambiguousRows: { "1": [actors.twinA.personId, actors.board.personId] },
      },
    });

    const before = await prisma.person.findUniqueOrThrow({
      where: { id: actors.twinA.personId },
      select: { emailIndex: true },
    });

    const response = await applyImport(cookie, session.sessionId, {
      "1": { action: "use-person", personId: actors.twinA.personId },
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("preview-outdated");
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
    expect(
      await prisma.person.findUniqueOrThrow({
        where: { id: actors.twinA.personId },
        select: { emailIndex: true },
      }),
    ).toEqual(before);
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
      apartment === "2103" ? twinsMovedInOn : "2021-04-01",
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
    const previewed = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
      decisions: decided,
    });
    expect(previewed.rows.map((planned) => planned.outcome)).toEqual([
      "ambiguous",
      "ambiguous",
    ]);

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

  it("is refused when a changed decision turns a row shown as an update into a new person", async () => {
    // Previewed with row 1 given to a Dubbel, row 2 - the same name in another
    // apartment, with the address row 1 gives that twin - is an update of
    // them, and nothing asks about it. Changed to a skip, row 1 gives nobody
    // that address, and row 2 would be created: a person the preview never
    // showed.
    const cookie = await signIn(actors.board.email);
    const email = `imp-changed-${suffix}-decision@exempel.se`;
    const row = (apartment: string) => [
      addressLabel,
      apartment,
      twinFirstName,
      surname,
      "Boende",
      email,
      "",
      apartment === "2103" ? twinsMovedInOn : "2021-04-01",
    ];
    const session = await upload(
      cookie,
      "andrat-beslut.csv",
      encode(writeCsv([HEADERS, row("2103"), row("2102")])),
    );
    const previewed = await previewImport(cookie, session.sessionId, {
      mapping: session.suggestedMapping,
      decisions: {
        "1": { action: "use-person", personId: actors.twinB.personId },
      },
    });
    expect(
      previewed.rows.map(({ outcome, matchedPersonId }) => ({
        outcome,
        matchedPersonId,
      })),
    ).toEqual([
      { outcome: "ambiguous", matchedPersonId: null },
      { outcome: "update", matchedPersonId: actors.twinB.personId },
    ]);

    const dubbels = () =>
      prisma.person.count({
        where: { lastName: surname, firstName: twinFirstName },
      });
    const before = await dubbels();

    const response = await applyImport(cookie, session.sessionId, {
      "1": { action: "skip" },
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("preview-outdated");
    expect(await readRun(cookie, session.sessionId)).toMatchObject({
      status: "MAPPING",
      rowsDone: 0,
    });
    expect(await dubbels()).toBe(before);
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
