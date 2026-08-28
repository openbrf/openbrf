import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 * interrupted between chunks, and writes nothing twice when it resumes.
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
}): Promise<void> {
  const email =
    input.email === undefined
      ? null
      : await encryption.encrypt("person.email", input.email);
  await prisma.person.create({
    data: {
      id: input.personId,
      firstName: input.firstName,
      lastName: input.lastName ?? surname,
      emailCipher: email?.cipher ?? null,
      emailIndex: email?.index ?? null,
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
    where: { id: { in: [apartments.b, apartments.c] } },
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

/**
 * Synthetic personal identity numbers, checksum-valid so the planner treats
 * them as indexable. Built rather than listed: what matters is how many
 * distinct ones the file carries.
 */
function identityNumbers(count: number): string[] {
  const numbers: string[] = [];
  for (let serial = 0; numbers.length < count; serial++) {
    const nine = `900101${String(serial).padStart(3, "0")}`;
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
