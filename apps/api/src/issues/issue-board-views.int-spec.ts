import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  addLocalDays,
  dateColumnOf,
  type IssuePriority,
  type IssueStatusMeaning,
  localDayOf,
} from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { IssueService } from "./issue.service";

/**
 * The board's views of the issue queue over HTTP, against a real database
 * (decision 15 of the issue module plan): Mina, Ej tilldelade, Försenade and
 * Alla, the filter and the search, and the counts the views and the board's
 * front page carry.
 *
 * The suite shares its worker's database with every other suite that ran there
 * before it, so each read that could reach their issues is narrowed to this
 * run's types, or reads a view only this run's people are in (Mina), or
 * compares a count with a list read at the same moment rather than with a
 * number of its own.
 */

// Refuses to run without a configured environment, before anything connects.
loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `bv-${key}-${suffix}`,
    email: `bv-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const colleague = person("colleague", "Carl", "Kollega");
const manager = person("manager", "Frida", "Forvaltare");
const resident = person("resident", "Rune", "Boende");
/** A property manager whose board seat the authorization tests end. */
const seated = person("seated", "Gunnar", "Ledamot");
/** A resident with protected personal data, as a reporter. */
const shielded = person("shielded", "Sara", "Skyddad");
const people = [board, colleague, manager, resident, shielded, seated];
const personIds = people.map((entry) => entry.personId);

const addressId = `bv-address-${suffix}`;
const apartment = { id: `bv-apartment-${suffix}`, number: `R${suffix}` };
const shieldedApartment = {
  id: `bv-apartment-shielded-${suffix}`,
  number: `S${suffix}`,
};

const typeIds = {
  water: `bv-type-water-${suffix}`,
  lift: `bv-type-lift-${suffix}`,
  insurance: `bv-type-insurance-${suffix}`,
  search: `bv-type-search-${suffix}`,
  snapshot: `bv-type-snapshot-${suffix}`,
  backslash: `bv-type-backslash-${suffix}`,
};
let water: IssueTypeFixture;
let lift: IssueTypeFixture;
let insurance: IssueTypeFixture;
let searched: IssueTypeFixture;

/** The association's calendar day, as the service reads a target date. */
function dayFromToday(days: number): Date {
  return dateColumnOf(addLocalDays(localDayOf(new Date()), days));
}

let ipCounter = 0;
/** Whether this suite made the association row, and so removes it again. */
let associationCreatedHere = false;
function inject(options: {
  url: string;
  cookie?: string;
  method?: "GET" | "POST";
  payload?: object;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method ?? "GET",
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        // 10.181.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.181.${String(subnet)}.${String(host + 1)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
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

const cookies: Record<string, string> = {};

interface QueuedRow {
  id: string;
  overdue: boolean;
  description: string;
  reporter: { kind: string; personId?: string; name?: string };
  apartment: { id: string; number: string } | null;
  assignee: { kind: string; personId?: string } | null;
}

type Counts = Record<"mine" | "unassigned" | "overdue" | "all", number>;

function query(params: Record<string, string>): string {
  const text = new URLSearchParams(params).toString();
  return text === "" ? "" : `?${text}`;
}

async function list(
  who: { personId: string },
  params: Record<string, string> = {},
): Promise<QueuedRow[]> {
  const response = await inject({
    url: `/api/issue-queue${query(params)}`,
    cookie: cookies[who.personId],
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<QueuedRow[]>();
}

async function counts(
  who: { personId: string },
  params: Record<string, string> = {},
): Promise<Counts> {
  const response = await inject({
    url: `/api/issue-queue/counts${query(params)}`,
    cookie: cookies[who.personId],
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Counts>();
}

interface Snapshot {
  issues: QueuedRow[];
  counts: Counts;
}

async function snapshot(
  who: { personId: string },
  params: Record<string, string> = {},
): Promise<Snapshot> {
  const response = await inject({
    url: `/api/issue-queue/snapshot${query(params)}`,
    cookie: cookies[who.personId],
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Snapshot>();
}

/** Text in code-unit order, so two lists of identifiers compare as sets. */
const byText = (first: string, second: string): number =>
  first < second ? -1 : first > second ? 1 : 0;

const ids = (rows: readonly { id: string }[]) =>
  rows.map((row) => row.id).toSorted(byText);

/** An issue written directly, as the queue would hold it. */
async function issue(
  type: IssueTypeFixture,
  key: string,
  extra: {
    meaning?: IssueStatusMeaning;
    assignee?: { personId: string } | null;
    priority?: IssuePriority;
    targetDate?: Date | null;
    reporter?: { personId: string } | null;
    apartmentId?: string | null;
    location?: string | null;
    description?: string;
    boardOnly?: boolean;
  } = {},
): Promise<string> {
  const id = `bv-issue-${key}-${suffix}`;
  const meaning = extra.meaning ?? "NEW";
  await prisma.issue.create({
    data: {
      id,
      typeId: type.id,
      statusId: type.statusIds[meaning],
      ...(meaning === "WAITING" ? { waitingReason: "PARTS" as const } : {}),
      ...(meaning === "DONE"
        ? { outcome: "FIXED" as const, closedAt: new Date() }
        : {}),
      reporterPersonId:
        extra.reporter === null ? null : (extra.reporter ?? resident).personId,
      assigneePersonId: extra.assignee?.personId ?? null,
      priority: extra.priority ?? "NORMAL",
      targetDate: extra.targetDate ?? null,
      apartmentId: extra.apartmentId ?? null,
      location: extra.location ?? null,
      description: extra.description ?? `Beskrivning ${key}`,
      boardOnly: extra.boardOnly ?? false,
    },
  });
  return id;
}

/** The issues of the views suite, by what makes each one count. */
type Filed =
  | "boardOnly"
  | "closedToBoard"
  | "colleagues"
  | "dueAhead"
  | "dueToday"
  | "internal"
  | "leak"
  | "mineDone"
  | "mineNew"
  | "mineWaiting"
  | "overdue"
  | "overdueDone"
  | "shieldedReport"
  | "unassigned"
  | "unassignedDone";
const filed = {} as Record<Filed, string>;

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

  associationCreatedHere =
    (await prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    })) === null;
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: "Vygatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartment.id, addressId, number: apartment.number, floor: 2 },
      {
        id: shieldedApartment.id,
        addressId,
        number: shieldedApartment.number,
        floor: 3,
      },
    ],
  });

  for (const entry of people) {
    const email = await encryption.encrypt("person.email", entry.email);
    await prisma.person.create({
      data: {
        id: entry.personId,
        firstName: entry.firstName,
        lastName: entry.lastName,
        emailCipher: email.cipher,
        emailIndex: email.index,
        protectedPersonalData: entry === shielded,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: entry.personId,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`,
      password: PASSWORD,
    });
  }
  await prisma.boardPosition.createMany({
    data: [board, colleague].map((entry) => ({
      personId: entry.personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2025-05-15"),
    })),
  });
  await prisma.systemRole.createMany({
    data: [manager, seated].map((entry) => ({
      personId: entry.personId,
      role: "PROPERTY_MANAGER" as const,
    })),
  });
  // Held until a test ends it: the reader who is a property manager too.
  await prisma.boardPosition.create({
    data: {
      personId: seated.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: resident.personId,
        apartmentId: apartment.id,
        role: "MEMBER" as const,
        movedInOn: new Date("2024-01-01"),
      },
      {
        personId: shielded.personId,
        apartmentId: shieldedApartment.id,
        role: "MEMBER" as const,
        movedInOn: new Date("2024-01-01"),
      },
    ],
  });

  water = await createIssueTypeFixture(prisma, {
    id: typeIds.water,
    name: `Vattenläcka ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  lift = await createIssueTypeFixture(prisma, {
    id: typeIds.lift,
    name: `Hiss ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  insurance = await createIssueTypeFixture(prisma, {
    id: typeIds.insurance,
    name: `Försäkring ${suffix}`,
    reporters: ["HANDLERS"],
    handledBy: "BOARD",
  });
  searched = await createIssueTypeFixture(prisma, {
    id: typeIds.search,
    name: `Sökbar ${suffix}`,
    reporters: ["RESIDENTS"],
  });

  // Mina for the board member: open in each meaning, and one closed.
  filed.mineNew = await issue(water, "mine-new", { assignee: board });
  filed.mineWaiting = await issue(lift, "mine-waiting", {
    assignee: board,
    meaning: "WAITING",
    priority: "URGENT",
  });
  filed.mineDone = await issue(water, "mine-done", {
    assignee: board,
    meaning: "DONE",
  });
  // A colleague's, open.
  filed.colleagues = await issue(water, "colleagues", {
    assignee: colleague,
    meaning: "IN_PROGRESS",
  });
  // Unassigned: open, and closed.
  filed.unassigned = await issue(lift, "unassigned", { priority: "LOW" });
  filed.unassignedDone = await issue(lift, "unassigned-done", {
    meaning: "DONE",
  });
  // Target dates: passed, today, ahead; passed and closed.
  filed.overdue = await issue(water, "overdue", {
    assignee: colleague,
    targetDate: dayFromToday(-1),
  });
  filed.dueToday = await issue(water, "due-today", {
    assignee: colleague,
    targetDate: dayFromToday(0),
  });
  filed.dueAhead = await issue(water, "due-ahead", {
    targetDate: dayFromToday(7),
  });
  filed.overdueDone = await issue(water, "overdue-done", {
    meaning: "DONE",
    targetDate: dayFromToday(-3),
  });
  // The board's own, overdue and unassigned: never the property manager's.
  filed.boardOnly = await issue(insurance, "board-only", {
    targetDate: dayFromToday(-2),
    reporter: null,
    description: `Försäkringsärende hemligt${suffix}`,
  });
  filed.closedToBoard = await issue(water, "closed-to-board", {
    boardOnly: true,
    description: `Stängt för förvaltaren hemligt${suffix}`,
  });

  // The search's issues.
  filed.leak = await issue(searched, "leak", {
    description: `Det droppar från taket i badrummet blåslampa${suffix}`,
    location: `Källaren gång ${suffix}`,
    apartmentId: apartment.id,
  });
  filed.shieldedReport = await issue(searched, "shielded-report", {
    reporter: shielded,
    apartmentId: shieldedApartment.id,
    description: `Elementet är kallt kylskåp${suffix}`,
  });
  filed.internal = await issue(searched, "internal", {
    reporter: null,
    // "fläkt" decomposed: an "a" and a combining diaeresis, as some
    // keyboards and pasted text send it.
    description: `Ingen anmälare alls fla\u0308kt takränna${suffix}`,
  });

  // Text the search reaches only in the conversation or the notes: a word
  // each that no description, place, type, apartment or name holds. None ends
  // in an "r" or an "s" before the suffix, or it would hold an apartment's
  // designation (`R` and `S` and the suffix) as well.
  await prisma.issueMessage.createMany({
    data: [
      {
        issueId: filed.leak,
        side: "REPORTER",
        authorPersonId: resident.personId,
        body: `Nu rinner det KRANVATTEN${suffix} på golvet`,
      },
      {
        issueId: filed.shieldedReport,
        side: "HANDLER",
        authorPersonId: board.personId,
        signature: "BOARD",
        // Stored decomposed, as `filed.internal`'s description is.
        body: `Vi skickar en ro\u0308rmokare${suffix} på tisdag`,
      },
      // The board's own, and one on an issue the property manager handles.
      {
        issueId: filed.closedToBoard,
        side: "HANDLER",
        authorPersonId: board.personId,
        signature: "BOARD",
        body: `Svar om dolt${suffix} i meddelandet`,
      },
      {
        issueId: filed.colleagues,
        side: "HANDLER",
        authorPersonId: colleague.personId,
        signature: "BOARD",
        body: `Svar om dolt${suffix} till den boende`,
      },
    ],
  });
  await prisma.issueNote.createMany({
    data: [
      {
        issueId: filed.internal,
        authorPersonId: board.personId,
        body: `Ring firman om stupröret${suffix} i morgon`,
      },
      {
        issueId: filed.boardOnly,
        authorPersonId: board.personId,
        body: `Anteckning om dolt${suffix} för styrelsen`,
      },
      {
        issueId: filed.closedToBoard,
        authorPersonId: board.personId,
        body: `Anteckning om anteckningsord${suffix} för styrelsen`,
      },
    ],
  });

  for (const entry of [board, colleague, manager, resident]) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
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
    where: { id: { in: [apartment.id, shieldedApartment.id] } },
  });
  await prisma.address.deleteMany({ where: { id: addressId } });
  // A row this suite made has no organisation number, and the register export's
  // suite reuses whatever row it finds: leaving it would fail that suite.
  if (associationCreatedHere) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  }
  await app.close();
});

/** This run's water and lift types, which the views below are narrowed to. */
const viewTypes = () => [water.id, lift.id];

/** One view, read once per type of this run and put together. */
async function viewOf(
  who: { personId: string },
  view: string,
  params: Record<string, string> = {},
): Promise<string[]> {
  const rows: QueuedRow[] = [];
  for (const typeId of [...viewTypes(), insurance.id]) {
    rows.push(...(await list(who, { view, typeId, ...params })));
  }
  return ids(rows);
}

describe("Mina", () => {
  it("is exactly the signed-in handler's open issues", async () => {
    const rows = await list(board, { view: "MINE", meaning: "OPEN" });

    expect(ids(rows)).toEqual(
      [filed.mineNew, filed.mineWaiting].toSorted(byText),
    );
    for (const row of rows) {
      expect(row.assignee).toMatchObject({ personId: board.personId });
    }
  });

  it("is another handler's own for them", async () => {
    expect(
      ids(await list(colleague, { view: "MINE", meaning: "OPEN" })),
    ).toEqual(
      [filed.colleagues, filed.overdue, filed.dueToday].toSorted(byText),
    );
  });

  it("reaches the handler's closed issues only when the filter asks for them", async () => {
    expect(ids(await list(board, { view: "MINE", meaning: "DONE" }))).toEqual([
      filed.mineDone,
    ]);
    expect(ids(await list(board, { view: "MINE" }))).toEqual(
      [filed.mineNew, filed.mineWaiting, filed.mineDone].toSorted(byText),
    );
  });
});

describe("Ej tilldelade", () => {
  it("is the open issues nobody is assigned", async () => {
    expect(await viewOf(board, "UNASSIGNED", { meaning: "OPEN" })).toEqual(
      [
        filed.unassigned,
        filed.dueAhead,
        filed.closedToBoard,
        filed.boardOnly,
      ].toSorted(byText),
    );
  });
});

describe("Försenade", () => {
  it("is the open issues whose target date has passed, never today's or a closed one", async () => {
    const rows: QueuedRow[] = [];
    for (const typeId of [...viewTypes(), insurance.id]) {
      rows.push(...(await list(board, { view: "OVERDUE", typeId })));
    }

    expect(ids(rows)).toEqual(
      [filed.overdue, filed.boardOnly].toSorted(byText),
    );
    // The list and the mark on each row read the same day the same way.
    expect(rows.every((row) => row.overdue)).toBe(true);
  });

  it("holds no closed issue whatever the filter asks", async () => {
    expect(await viewOf(board, "OVERDUE", { meaning: "DONE" })).toEqual([]);
  });
});

describe("Alla", () => {
  it("is every open issue under the open filter, and every issue without one", async () => {
    const open = await viewOf(board, "ALL", { meaning: "OPEN" });
    const every = await viewOf(board, "ALL");

    expect(open).not.toContain(filed.mineDone);
    expect(open).toContain(filed.closedToBoard);
    expect(every).toEqual(
      [
        ...open,
        filed.mineDone,
        filed.unassignedDone,
        filed.overdueDone,
      ].toSorted(byText),
    );
  });
});

describe("the filter", () => {
  it("narrows by type, status and priority together", async () => {
    expect(
      ids(
        await list(board, {
          view: "ALL",
          typeId: lift.id,
          meaning: "WAITING",
          priority: "URGENT",
        }),
      ),
    ).toEqual([filed.mineWaiting]);
    expect(
      ids(await list(board, { view: "ALL", typeId: lift.id, priority: "LOW" })),
    ).toEqual([filed.unassigned]);
  });

  it("refuses a parameter it does not read, and a view or meaning that is not one", async () => {
    for (const url of [
      "/api/issue-queue?veiw=MINE",
      "/api/issue-queue?view=MINA",
      "/api/issue-queue?meaning=CLOSED",
      "/api/issue-queue?priority=HIGH",
      "/api/issue-queue/counts?view=MINE",
      `/api/issue-queue?q=${"a".repeat(101)}`,
    ]) {
      const response = await inject({ url, cookie: cookies[board.personId] });
      expect(response.statusCode, url).toBe(400);
    }
  });
});

describe("the counts", () => {
  it("are the lengths of the lists, view by view, under the same filter", async () => {
    for (const filter of [
      { meaning: "OPEN" },
      {},
      { meaning: "DONE" },
      { priority: "URGENT" },
      { meaning: "NEW", priority: "NORMAL" },
    ] as Record<string, string>[]) {
      for (const typeId of [...viewTypes(), insurance.id]) {
        const params = { ...filter, typeId };
        const counted = await counts(board, params);
        expect(counted, JSON.stringify(params)).toEqual({
          mine: (await list(board, { view: "MINE", ...params })).length,
          unassigned: (await list(board, { view: "UNASSIGNED", ...params }))
            .length,
          overdue: (await list(board, { view: "OVERDUE", ...params })).length,
          all: (await list(board, { view: "ALL", ...params })).length,
        });
      }
    }
  });

  it("are the front page's open, overdue and unassigned, across the whole queue", async () => {
    // Nothing else writes to this worker's database while the suite runs, so
    // the whole queue holds still between the reads.
    for (const who of [board, manager]) {
      const counted = await counts(who, { meaning: "OPEN" });
      expect(counted).toEqual({
        mine: (await list(who, { view: "MINE", meaning: "OPEN" })).length,
        unassigned: (await list(who, { view: "UNASSIGNED", meaning: "OPEN" }))
          .length,
        overdue: (await list(who, { view: "OVERDUE", meaning: "OPEN" })).length,
        all: (await list(who, { view: "ALL", meaning: "OPEN" })).length,
      });
    }
  });

  it("leave out what the board keeps to itself for the property manager", async () => {
    const forBoard = await counts(board, { typeId: insurance.id });
    const forManager = await counts(manager, { typeId: insurance.id });

    expect(forBoard).toEqual({ mine: 0, unassigned: 1, overdue: 1, all: 1 });
    expect(forManager).toEqual({ mine: 0, unassigned: 0, overdue: 0, all: 0 });
    expect(
      (await counts(manager, { typeId: water.id, meaning: "OPEN" })).all,
    ).toBe(
      (await counts(board, { typeId: water.id, meaning: "OPEN" })).all - 1,
    );
  });

  it("are closed to a resident, as the queue is", async () => {
    const response = await inject({
      url: "/api/issue-queue/counts",
      cookie: cookies[resident.personId],
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("the snapshot", () => {
  it("is the view's list and every view's count, as the two reads answer them", async () => {
    for (const filter of [
      { meaning: "OPEN" },
      {},
      { meaning: "DONE", view: "OVERDUE" },
      { priority: "URGENT", view: "MINE" },
      { view: "UNASSIGNED", q: `Beskrivning` },
    ] as Record<string, string>[]) {
      for (const typeId of [...viewTypes(), insurance.id]) {
        const { view, ...rest } = filter;
        const params = { ...rest, typeId };
        const read = await snapshot(board, { ...params, view: view ?? "ALL" });
        expect(read.counts, JSON.stringify(filter)).toEqual(
          await counts(board, params),
        );
        expect(ids(read.issues), JSON.stringify(filter)).toEqual(
          ids(await list(board, { ...params, view: view ?? "ALL" })),
        );
      }
    }
  });

  it("reads the list and the counts at one moment, whatever is written between them", async () => {
    const type = await createIssueTypeFixture(prisma, {
      id: typeIds.snapshot,
      name: `Ögonblick ${suffix}`,
      reporters: ["RESIDENTS"],
    });
    const taken = await issue(type, "taken");
    const params = { view: "UNASSIGNED", typeId: type.id, meaning: "OPEN" };

    /*
     * Another handler takes the issue once the list is read and before the
     * first count is: on its own connection, outside the read's transaction,
     * and committed before the read goes on.
     */
    const transaction = prisma.$transaction.bind(prisma);
    let written = false;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
      first: unknown,
      options?: unknown,
    ) => {
      if (
        typeof first !== "function" ||
        (options as { isolationLevel?: string } | undefined)?.isolationLevel !==
          "RepeatableRead"
      ) {
        return transaction(first as never, options as never);
      }
      const run = first as (tx: Prisma.TransactionClient) => Promise<unknown>;
      return transaction(
        (tx: Prisma.TransactionClient) =>
          run(
            new Proxy(tx, {
              get(target, property, receiver) {
                const value: unknown = Reflect.get(target, property, receiver);
                if (property !== "issue") {
                  return value;
                }
                const delegate = value as Prisma.TransactionClient["issue"];
                return new Proxy(delegate, {
                  get(model, name, inner) {
                    if (name === "count" && !written) {
                      written = true;
                      return async (...args: unknown[]) => {
                        await prisma.issue.update({
                          where: { id: taken },
                          data: { assigneePersonId: colleague.personId },
                        });
                        return (model.count as (...rest: unknown[]) => unknown)(
                          ...args,
                        );
                      };
                    }
                    return Reflect.get(model, name, inner) as unknown;
                  },
                });
              },
            }),
          ),
        options as never,
      );
    }) as never);
    try {
      const read = await snapshot(board, params);
      expect(written).toBe(true);
      expect(ids(read.issues)).toEqual([taken]);
      expect(read.counts).toEqual({
        mine: 0,
        unassigned: 1,
        overdue: 0,
        all: 1,
      });
    } finally {
      spy.mockRestore();
    }

    // Read again, the issue has left the view, and its count with it.
    const after = await snapshot(board, params);
    expect(after.issues).toEqual([]);
    expect(after.counts).toEqual({
      mine: 0,
      unassigned: 0,
      overdue: 0,
      all: 1,
    });
  });

  it("is closed to a resident, as the queue is", async () => {
    const response = await inject({
      url: "/api/issue-queue/snapshot",
      cookie: cookies[resident.personId],
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("the queue's authorization", () => {
  /**
   * Ends the reader's board seat once the queue's transaction is asked for and
   * before it begins: the moment a scope read ahead of it would already have
   * answered "board", and one read inside it must not. The seat is held again,
   * and the spy removed, whatever the read does.
   */
  async function withSeatEndedAtTransactionEntry<T>(
    read: () => Promise<T>,
  ): Promise<T> {
    const transaction = prisma.$transaction.bind(prisma);
    let ended = false;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (
      first: unknown,
      options?: unknown,
    ) => {
      if (
        typeof first === "function" &&
        (options as { isolationLevel?: string } | undefined)?.isolationLevel ===
          "RepeatableRead" &&
        !ended
      ) {
        ended = true;
        await prisma.boardPosition.updateMany({
          where: { personId: seated.personId },
          data: {
            endedOn: dateColumnOf(addLocalDays(localDayOf(new Date()), -1)),
          },
        });
      }
      return transaction(first as never, options as never);
    }) as never);
    try {
      const result = await read();
      expect(ended).toBe(true);
      return result;
    } finally {
      spy.mockRestore();
      await prisma.boardPosition.updateMany({
        where: { personId: seated.personId },
        data: { endedOn: null },
      });
    }
  }

  const service = () => app.get(IssueService);
  const open = { meaning: "OPEN" } as const;

  it("lets the reader in as the board while the seat is held", async () => {
    expect(
      ids(
        await service().listQueue(seated.personId, "ALL", {
          typeId: insurance.id,
        }),
      ),
    ).toEqual([filed.boardOnly]);
    expect(
      ids(
        await service().listQueue(seated.personId, "ALL", {
          typeId: water.id,
        }),
      ),
    ).toContain(filed.closedToBoard);
  });

  it("lists only what the property manager handles when the seat ends as the read begins", async () => {
    const kept = await withSeatEndedAtTransactionEntry(() =>
      service().listQueue(seated.personId, "ALL", { typeId: insurance.id }),
    );
    expect(ids(kept)).toEqual([]);

    const waterRows = await withSeatEndedAtTransactionEntry(() =>
      service().listQueue(seated.personId, "ALL", { typeId: water.id }),
    );
    expect(ids(waterRows)).not.toContain(filed.closedToBoard);
    expect(ids(waterRows)).toContain(filed.mineNew);
  });

  it("counts only what the property manager handles when the seat ends as the count begins", async () => {
    const insuranceCounts = await withSeatEndedAtTransactionEntry(() =>
      service().countQueue(seated.personId, { typeId: insurance.id }),
    );
    expect(insuranceCounts).toEqual({
      mine: 0,
      unassigned: 0,
      overdue: 0,
      all: 0,
    });

    const waterCounts = await withSeatEndedAtTransactionEntry(() =>
      service().countQueue(seated.personId, { typeId: water.id, ...open }),
    );
    expect(waterCounts).toEqual(
      await counts(manager, { typeId: water.id, ...open }),
    );
  });

  it("reads the snapshot's list and counts as the property manager when the seat ends as the read begins", async () => {
    const insuranceRead = await withSeatEndedAtTransactionEntry(() =>
      service().readQueueSnapshot(seated.personId, "ALL", {
        typeId: insurance.id,
      }),
    );
    expect(insuranceRead.issues).toEqual([]);
    expect(insuranceRead.counts.all).toBe(0);

    const waterRead = await withSeatEndedAtTransactionEntry(() =>
      service().readQueueSnapshot(seated.personId, "ALL", {
        typeId: water.id,
      }),
    );
    expect(ids(waterRead.issues)).not.toContain(filed.closedToBoard);
    expect(waterRead.counts).toEqual(
      await counts(manager, { typeId: water.id }),
    );
  });
});

describe("the search", () => {
  const search = async (
    who: { personId: string },
    q: string,
    params: Record<string, string> = {},
  ) => ids(await list(who, { view: "ALL", typeId: searched.id, q, ...params }));

  it("matches the description, the place, the type, the apartment and the reporter's name, case aside", async () => {
    expect(await search(board, `BLÅSLAMPA${suffix}`)).toEqual([filed.leak]);
    expect(await search(board, `källaren gång ${suffix}`)).toEqual([
      filed.leak,
    ]);
    expect(await search(board, apartment.number.toLowerCase())).toEqual([
      filed.leak,
    ]);
    expect(await search(board, `Rune ${resident.lastName}`)).toEqual([
      filed.leak,
    ]);
    expect(await search(board, `Sökbar ${suffix}`)).toEqual(
      [filed.leak, filed.shieldedReport, filed.internal].toSorted(byText),
    );
  });

  it("needs every word to match somewhere", async () => {
    expect(await search(board, `blåslampa${suffix} takränna${suffix}`)).toEqual(
      [],
    );
    expect(await search(board, `badrummet Rune`)).toEqual([filed.leak]);
  });

  it("takes a percent sign, an underscore and a backslash as the characters they are", async () => {
    // As wildcards, either would match the leak's description.
    expect(await search(board, `blåslamp_${suffix}`)).toEqual([]);
    expect(await search(board, `blå%${suffix}`)).toEqual([]);
    expect(await search(board, `%${suffix}`)).toEqual([]);
    expect(await search(board, `_`)).toEqual([]);
    // As LIKE's escape character, `\s` would match a plain `s`.
    expect(await search(board, `blå\\slampa${suffix}`)).toEqual([]);
  });

  it("finds a description that holds a backslash when it is searched for", async () => {
    // A type of its own, so no other test's set of issues changes. Were every
    // backslash refused, the query above would pass and this would not.
    const type = await createIssueTypeFixture(prisma, {
      id: typeIds.backslash,
      name: `Bakstreck ${suffix}`,
      reporters: ["RESIDENTS"],
    });
    const backslashed = await issue(type, "backslashed", {
      description: `Sökvägen C:\\skrivbord\\kvitto${suffix}`,
    });

    expect(
      ids(
        await list(board, {
          view: "ALL",
          typeId: type.id,
          q: `C:\\skrivbord\\kvitto${suffix}`,
        }),
      ),
    ).toEqual([backslashed]);
    // The characters either side of the backslash are not stand-ins for it.
    expect(
      ids(
        await list(board, {
          view: "ALL",
          typeId: type.id,
          q: `C:skrivbordkvitto${suffix}`,
        }),
      ),
    ).toEqual([]);
  });

  it("drops an invisible character pasted into a word", async () => {
    expect(await search(board, `blås\u200Blampa${suffix}`)).toEqual([
      filed.leak,
    ]);
  });

  it("matches text stored in either Unicode form, whichever form is typed", async () => {
    // Stored decomposed, typed composed.
    expect(await search(board, `FLÄKT takränna${suffix}`)).toEqual([
      filed.internal,
    ]);
    // Stored composed, typed decomposed.
    expect(await search(board, `bla\u030Aslampa${suffix}`)).toEqual([
      filed.leak,
    ]);
  });

  it("never matches a protected reporter by name or apartment, and masks the row a description matches", async () => {
    expect(await search(board, shielded.lastName)).toEqual([]);
    expect(await search(board, shielded.firstName)).toEqual([]);
    expect(await search(board, `Sara ${shielded.lastName}`)).toEqual([]);
    expect(await search(board, shieldedApartment.number)).toEqual([]);

    const [row] = await list(board, {
      view: "ALL",
      typeId: searched.id,
      q: `kylskåp${suffix}`,
    });
    expect(row?.id).toBe(filed.shieldedReport);
    expect(row?.reporter).toEqual({ kind: "protected" });
    expect(row?.apartment).toBeNull();
    expect(JSON.stringify(row)).not.toContain(shielded.lastName);
    expect(JSON.stringify(row)).not.toContain(shieldedApartment.number);
  });

  it("counts what it finds as it lists it", async () => {
    const q = `Sökbar ${suffix}`;
    expect(await counts(board, { typeId: searched.id, q })).toEqual({
      mine: 0,
      unassigned: 3,
      overdue: 0,
      all: 3,
    });
    expect(
      await counts(board, { typeId: searched.id, q: shielded.lastName }),
    ).toEqual({
      mine: 0,
      unassigned: 0,
      overdue: 0,
      all: 0,
    });
  });

  it("never finds for the property manager what the board keeps to itself", async () => {
    const q = `hemligt${suffix}`;
    expect(ids(await list(board, { view: "ALL", q }))).toEqual(
      [filed.boardOnly, filed.closedToBoard].toSorted(byText),
    );
    expect(await list(manager, { view: "ALL", q })).toEqual([]);
    expect(await counts(manager, { q })).toEqual({
      mine: 0,
      unassigned: 0,
      overdue: 0,
      all: 0,
    });
  });

  it("matches a message in the conversation with the reporter, case aside", async () => {
    expect(await search(board, `kranvatten${suffix}`)).toEqual([filed.leak]);
    expect(await search(manager, `Kranvatten${suffix}`)).toEqual([filed.leak]);
    // A handler's message, stored decomposed and typed composed.
    expect(await search(board, `RÖRMOKARE${suffix}`)).toEqual([
      filed.shieldedReport,
    ]);
  });

  it("matches an internal note", async () => {
    expect(await search(board, `STUPRÖRET${suffix}`)).toEqual([filed.internal]);
    expect(await search(manager, `stupröret${suffix}`)).toEqual([
      filed.internal,
    ]);
  });

  it("finds each word in its own place, the conversation and the notes among them", async () => {
    // One word in a message, the other in the description.
    expect(await search(board, `kranvatten${suffix} badrummet`)).toEqual([
      filed.leak,
    ]);
    // One word in a note, the other in the description.
    expect(await search(board, `stupröret${suffix} takränna${suffix}`)).toEqual(
      [filed.internal],
    );
    // A message's word and a note's word on two different issues.
    expect(
      await search(board, `kranvatten${suffix} stupröret${suffix}`),
    ).toEqual([]);
  });

  it("counts what the conversation and the notes match as it lists it", async () => {
    for (const q of [`kranvatten${suffix}`, `stupröret${suffix}`]) {
      const listed = await list(board, { view: "ALL", typeId: searched.id, q });
      expect(listed).toHaveLength(1);
      expect(await counts(board, { typeId: searched.id, q })).toEqual({
        mine: 0,
        unassigned: 1,
        overdue: 0,
        all: listed.length,
      });
    }
  });

  it("never finds for the property manager by a message or a note the board keeps to itself", async () => {
    const q = `dolt${suffix}`;
    // The board's own: by a note on an issue of a board-only type, and by a
    // message on an issue kept to the board; the property manager's colleague
    // wrote the same word on an issue both handle.
    expect(ids(await list(board, { view: "ALL", q }))).toEqual(
      [filed.boardOnly, filed.closedToBoard, filed.colleagues].toSorted(byText),
    );
    expect(await counts(board, { q })).toEqual({
      mine: 0,
      unassigned: 2,
      overdue: 1,
      all: 3,
    });
    expect(ids(await list(manager, { view: "ALL", q }))).toEqual([
      filed.colleagues,
    ]);
    expect(await counts(manager, { q })).toEqual({
      mine: 0,
      unassigned: 0,
      overdue: 0,
      all: 1,
    });
    const read = await snapshot(manager, { view: "ALL", q });
    expect(ids(read.issues)).toEqual([filed.colleagues]);
    expect(read.counts.all).toBe(1);

    // A word only a note on an issue kept to the board holds.
    const noted = `anteckningsord${suffix}`;
    expect(ids(await list(board, { view: "ALL", q: noted }))).toEqual([
      filed.closedToBoard,
    ]);
    expect(await list(manager, { view: "ALL", q: noted })).toEqual([]);
    expect((await counts(manager, { q: noted })).all).toBe(0);
  });

  it("is no search when blank", async () => {
    expect(await search(board, "   ")).toEqual(
      [filed.leak, filed.shieldedReport, filed.internal].toSorted(byText),
    );
  });
});
