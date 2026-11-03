import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { formatLocalDay, localDayOf } from "@openbrf/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { backendPid, waitersBehind } from "../testing/lock-waiters";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { lockResponsibilityGuide } from "./issue-lock";
import { ResponsibilityGuideService } from "./responsibility-guide.service";

/**
 * The client a guide reader is given, which runs `between` to its end after
 * the reader's first read of the guide's tables and before any further read
 * of them starts - on the client itself or in a transaction it opens.
 *
 * Whatever shape the reader takes, two reads in sequence or two at once, the
 * second is held until `between` has committed, so a test sees what a reader
 * makes of a write that lands in the gap.
 */
function betweenTheFirstReadAndTheNext(
  client: PrismaService,
  between: () => Promise<void>,
): PrismaService {
  const tables = new Set(["responsibilityGuide", "responsibilityGuideItem"]);
  let first: Promise<unknown> | null = null;

  function delegate(target: object): object {
    return new Proxy(target, {
      get(table, method) {
        const query: unknown = Reflect.get(table, method, table);
        if (typeof query !== "function") {
          return query;
        }
        return async (...args: unknown[]) => {
          const run = () =>
            (query as (...a: unknown[]) => unknown).apply(table, args);
          if (first === null) {
            first = (async () => {
              const result = await run();
              await between();
              return result;
            })();
            return first;
          }
          await first;
          return run();
        };
      },
    });
  }

  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(db, property) {
        const value: unknown = Reflect.get(db, property, db);
        if (property === "$transaction" && typeof value === "function") {
          return (work: unknown, options?: unknown) =>
            (value as (w: unknown, o?: unknown) => unknown).call(
              db,
              typeof work === "function"
                ? (tx: object) => (work as (t: object) => unknown)(wrap(tx))
                : work,
              options,
            );
        }
        if (typeof property === "string" && tables.has(property)) {
          return delegate(value as object);
        }
        return typeof value === "function" ? value.bind(db) : value;
      },
    });
  }

  return wrap(client);
}

/**
 * Who pays for an issue, the charge made from it, and the association's
 * responsibility guide, over HTTP against a real database (decisions 26 and
 * 27 of the issue module plan).
 *
 * The properties these defend are the task's acceptance: the property manager
 * never sees an amount, deleting a charge leaves the issue as it was, and the
 * guide's example is never shown to a reporter as the association's answer.
 */

// Refuses to run without a configured environment, before anything connects.
loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
/**
 * The association row is a singleton the other suites on this worker read, and
 * one of them takes its absence or its organisation number as given. Removed
 * after the run only when this suite was the one to create it.
 */
let associationCreatedHere = false;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `ir-${key}-${suffix}`,
    email: `ir-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const manager = person("manager", "Frida", "Forvaltare");
const resident = person("resident", "Rune", "Boende");
/** Reports one issue, and is given protected personal data after it. */
const shielded = person("shielded", "Siv", "Skyddad");
const people = [board, manager, resident, shielded];
const personIds = people.map((entry) => entry.personId);

const addressId = `ir-address-${suffix}`;
const apartmentId = `ir-apartment-${suffix}`;
const typeId = `ir-type-${suffix}`;
let type: IssueTypeFixture;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        // 10.178.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.178.${String(subnet)}.${String(host + 1)}`,
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

/** An issue a resident filed against their apartment, written directly. */
async function filed(
  key: string,
  reporterPersonId: string = resident.personId,
): Promise<string> {
  const id = `ir-issue-${key}-${suffix}`;
  await prisma.issue.create({
    data: {
      id,
      typeId: type.id,
      statusId: type.statusIds.NEW,
      reporterPersonId,
      apartmentId,
      description: `Beskrivning ${key}`,
    },
  });
  return id;
}

function today(): string {
  return formatLocalDay(localDayOf(new Date()));
}

/**
 * Records a charge from an issue as the board, and answers with the row. On
 * the apartment unless a person is named.
 */
async function chargeFrom(
  issueId: string,
  amount = "1250.00",
  party: { personId: string } | { apartmentId: string } = { apartmentId },
) {
  const response = await inject({
    method: "POST",
    url: "/api/member-charges",
    cookie: cookies[board.personId],
    payload: {
      ...party,
      chargedOn: today(),
      amount,
      reason: "Ärende: Vattenläcka",
      vatTreatment: "EXEMPT",
      issueId,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ chargeId: string; amount: string; issueId: string }>();
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

  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { id: true },
  });
  associationCreatedHere = existing === null;
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: "Betalargatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1601", floor: 6 },
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
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: entry.personId,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`,
      password: PASSWORD,
    });
  }
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });
  for (const entry of [resident, shielded]) {
    await prisma.residency.create({
      data: {
        personId: entry.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2024-01-01"),
      },
    });
  }

  type = await createIssueTypeFixture(prisma, {
    id: typeId,
    name: `Vattenläcka ${suffix}`,
    reporters: ["RESIDENTS"],
  });

  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  try {
    await prisma.memberCharge.deleteMany({
      where: { recordedByPersonId: { in: personIds } },
    });
    await prisma.issue.deleteMany({ where: { typeId } });
    await prisma.issueType.deleteMany({ where: { id: typeId } });
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
    await prisma.residency.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.boardPosition.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.apartment.deleteMany({ where: { id: apartmentId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
  } finally {
    try {
      if (associationCreatedHere) {
        await prisma.association.deleteMany({ where: { id: 1 } });
      }
    } finally {
      await app.close();
    }
  }
});

describe("who pays", () => {
  it("is recorded by any handler, the property manager included, with the value either side and on the timeline", async () => {
    const issueId = await filed("who-pays");

    const set = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/cost-responsibility`,
      cookie: cookies[manager.personId],
      payload: { costResponsibility: "UNCLEAR" },
    });
    expect(set.statusCode).toBe(201);
    expect(set.json<{ costResponsibility: string }>().costResponsibility).toBe(
      "UNCLEAR",
    );

    const moved = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/cost-responsibility`,
      cookie: cookies[board.personId],
      payload: { costResponsibility: "TENANT_OWNER" },
    });
    expect(moved.statusCode).toBe(201);

    // The same value again records nothing.
    await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/cost-responsibility`,
      cookie: cookies[board.personId],
      payload: { costResponsibility: "TENANT_OWNER" },
    });

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_COST_RESPONSIBILITY_CHANGED",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { actorPersonId: true, context: true },
    });
    expect(entries).toEqual([
      {
        actorPersonId: manager.personId,
        context: { from: null, to: "UNCLEAR" },
      },
      {
        actorPersonId: board.personId,
        context: { from: "UNCLEAR", to: "TENANT_OWNER" },
      },
    ]);

    const timeline = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/timeline`,
      cookie: cookies[board.personId],
    });
    expect(
      timeline
        .json<{ kind: string; from?: string | null; to?: string | null }[]>()
        .filter((step) => step.kind === "costResponsibility")
        .map((step) => [step.from, step.to]),
    ).toEqual([
      [null, "UNCLEAR"],
      ["UNCLEAR", "TENANT_OWNER"],
    ]);

    // A decision about the reporter's own matter, so it is on their report.
    const report = await app
      .get(DataSubjectReportService)
      .portable(resident.personId);
    expect(
      report.issues.find((entry) => entry.issueId === issueId)
        ?.costResponsibility,
    ).toBe("TENANT_OWNER");
  });

  it("is refused to a resident, who handles nothing, and takes no amount", async () => {
    const issueId = await filed("who-pays-refused");

    const resident_ = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/cost-responsibility`,
      cookie: cookies[resident.personId],
      payload: { costResponsibility: "ASSOCIATION" },
    });
    expect(resident_.statusCode).toBe(403);

    const withAmount = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/cost-responsibility`,
      cookie: cookies[board.personId],
      payload: { costResponsibility: "TENANT_OWNER", amount: "500.00" },
    });
    expect(withAmount.statusCode).toBe(400);
    expect(
      (await prisma.issue.findUniqueOrThrow({ where: { id: issueId } }))
        .costResponsibility,
    ).toBeNull();
  });
});

describe("a charge made from an issue", () => {
  it("starts from the issue's apartment, links back to it, and shows the amount to the board", async () => {
    const issueId = await filed("charged");

    const before = await inject({
      method: "GET",
      url: `/api/member-charges/issues/${issueId}`,
      cookie: cookies[board.personId],
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      issue: {
        issueId,
        typeName: `Vattenläcka ${suffix}`,
        costResponsibility: null,
        party: { kind: "apartment", apartmentId },
      },
      charges: [],
    });

    const charge = await chargeFrom(issueId);
    expect(charge.issueId).toBe(issueId);

    const after = await inject({
      method: "GET",
      url: `/api/member-charges/issues/${issueId}`,
      cookie: cookies[board.personId],
    });
    expect(
      after
        .json<{ charges: { chargeId: string; amount: string }[] }>()
        .charges.map((row) => [row.chargeId, row.amount]),
    ).toEqual([[charge.chargeId, "1250.00"]]);

    // The entry says the charge came from an issue, by identifier only.
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "MEMBER_CHARGE_RECORDED",
        targetId: charge.chargeId,
      },
      select: { context: true },
    });
    expect(entry.context).toMatchObject({ issueId });
  });

  it("never shows the property manager an amount", async () => {
    const issueId = await filed("manager-blind");
    await chargeFrom(issueId, "987.65");

    const charges = await inject({
      method: "GET",
      url: `/api/member-charges/issues/${issueId}`,
      cookie: cookies[manager.personId],
    });
    expect(charges.statusCode).toBe(403);

    const list = await inject({
      method: "GET",
      url: `/api/member-charges?from=${today()}&to=${today()}`,
      cookie: cookies[manager.personId],
    });
    expect(list.statusCode).toBe(403);

    // Everything the property manager reads about the issue, read whole.
    const reads = await Promise.all(
      [
        "/api/issue-queue",
        `/api/issue-queue/${issueId}/timeline`,
        "/api/issue-queue/responsibility-guide",
      ].map((url) =>
        inject({ method: "GET", url, cookie: cookies[manager.personId] }),
      ),
    );
    for (const read of reads) {
      expect(read.statusCode).toBe(200);
      expect(read.body).not.toContain("987.65");
      expect(read.body).not.toContain("987,65");
      expect(read.body).not.toContain('"amount"');
    }
  });

  it("refuses to link an issue that does not exist, and records nothing", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/member-charges",
      cookie: cookies[board.personId],
      payload: {
        apartmentId,
        chargedOn: today(),
        amount: "10.00",
        reason: `Ingen sådan ${suffix}`,
        vatTreatment: "EXEMPT",
        issueId: `ir-issue-nowhere-${suffix}`,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe("issue-not-found");
    expect(
      await prisma.memberCharge.count({
        where: { reason: `Ingen sådan ${suffix}` },
      }),
    ).toBe(0);
  });

  it("leaves the issue intact when the charge is removed", async () => {
    const issueId = await filed("charge-removed");
    await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/cost-responsibility`,
      cookie: cookies[board.personId],
      payload: { costResponsibility: "TENANT_OWNER" },
    });
    const issueBefore = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
    });
    const charge = await chargeFrom(issueId);

    const removed = await inject({
      method: "DELETE",
      url: `/api/member-charges/${charge.chargeId}`,
      cookie: cookies[board.personId],
    });
    expect(removed.statusCode).toBe(204);

    const issueAfter = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
    });
    expect(issueAfter).toEqual(issueBefore);
    const read = await inject({
      method: "GET",
      url: `/api/member-charges/issues/${issueId}`,
      cookie: cookies[board.personId],
    });
    expect(read.json<{ charges: unknown[] }>().charges).toEqual([]);
  });

  it("withholds the link once the reporter has protected personal data, for a charge on the person and on the apartment, on both reads", async () => {
    const issueId = await filed("shielded", shielded.personId);
    const onApartment = await chargeFrom(issueId, "410.00");
    const onPerson = await chargeFrom(issueId, "420.00", {
      personId: shielded.personId,
    });
    const chargeIds = [onApartment.chargeId, onPerson.chargeId];

    async function readBoth() {
      const forIssue = await inject({
        method: "GET",
        url: `/api/member-charges/issues/${issueId}`,
        cookie: cookies[board.personId],
      });
      const list = await inject({
        method: "GET",
        url: `/api/member-charges?from=${today()}&to=${today()}`,
        cookie: cookies[board.personId],
      });
      expect(forIssue.statusCode).toBe(200);
      expect(list.statusCode).toBe(200);
      return {
        forIssue,
        rows: list
          .json<{
            rows: {
              chargeId: string;
              issueId: string | null;
              chargedTo: { kind: string; personId?: string };
            }[];
          }>()
          .rows.filter((row) => chargeIds.includes(row.chargeId)),
      };
    }

    // Linked both ways while the reporter is not protected.
    const before = await readBoth();
    expect(
      before.forIssue
        .json<{ charges: { chargeId: string }[] }>()
        .charges.map((row) => row.chargeId),
    ).toEqual(chargeIds);
    expect(before.rows.map((row) => [row.chargeId, row.issueId])).toEqual([
      [onApartment.chargeId, issueId],
      [onPerson.chargeId, issueId],
    ]);

    await prisma.person.update({
      where: { id: shielded.personId },
      data: { protectedPersonalData: true },
    });

    const after = await readBoth();

    // The issue says its charges are withheld, and names neither party.
    expect(after.forIssue.json()).toEqual({
      issue: {
        issueId,
        typeName: `Vattenläcka ${suffix}`,
        costResponsibility: null,
        party: null,
      },
      charges: null,
    });
    for (const withheld of [
      shielded.personId,
      shielded.lastName,
      apartmentId,
      ...chargeIds,
    ]) {
      expect(after.forIssue.body).not.toContain(withheld);
    }

    // The list still states both charges and whom they are on, without the
    // issue.
    expect(
      after.rows.map((row) => [row.chargeId, row.chargedTo.kind, row.issueId]),
    ).toEqual([
      [onApartment.chargeId, "apartment", null],
      [onPerson.chargeId, "person", null],
    ]);
    expect(after.rows[1]?.chargedTo.personId).toBe(shielded.personId);
    for (const row of after.rows) {
      expect(JSON.stringify(row)).not.toContain(issueId);
    }

    // What is withheld is the reading: the stored link is untouched.
    const stored = await prisma.memberCharge.findMany({
      where: { id: { in: chargeIds } },
      select: { issueId: true },
    });
    expect(stored.map((row) => row.issueId)).toEqual([issueId, issueId]);
  });

  it("keeps the charge when the issue it names is gone", async () => {
    const issueId = await filed("issue-removed");
    const charge = await chargeFrom(issueId);

    // As a purge or a merge takes an issue away: no key stands in the way.
    await prisma.issue.delete({ where: { id: issueId } });

    const kept = await prisma.memberCharge.findUniqueOrThrow({
      where: { id: charge.chargeId },
      select: { issueId: true, amount: true },
    });
    expect(kept.issueId).toBe(issueId);
    expect(kept.amount.toFixed(2)).toBe("1250.00");

    const list = await inject({
      method: "GET",
      url: `/api/member-charges?from=${today()}&to=${today()}`,
      cookie: cookies[board.personId],
    });
    expect(
      list
        .json<{ rows: { chargeId: string }[] }>()
        .rows.some((row) => row.chargeId === charge.chargeId),
    ).toBe(true);

    // And the issue route answers as for an issue that never was.
    const read = await inject({
      method: "GET",
      url: `/api/member-charges/issues/${issueId}`,
      cookie: cookies[board.personId],
    });
    expect(read.statusCode).toBe(404);
  });
});

describe("the responsibility guide", () => {
  const LINES = [
    { part: "Golvbrunn, rensning", responsibility: "TENANT_OWNER", note: null },
    {
      part: "  Stammar  ",
      responsibility: "ASSOCIATION",
      note: "  Tjänar fler än en lägenhet  ",
    },
  ];

  async function save(adopted: boolean, items: object[] = LINES) {
    return inject({
      method: "PUT",
      url: "/api/responsibility-guide",
      cookie: cookies[board.personId],
      payload: { items, adopted },
    });
  }

  /**
   * The guide is one per instance, so each test hands back the one it found:
   * its lines and its adoption, as they were, whatever the test left.
   */
  let found: {
    guide: { adoptedAt: Date | null } | null;
    items: {
      part: string;
      responsibility: "ASSOCIATION" | "TENANT_OWNER";
      note: string | null;
      sortOrder: number;
    }[];
  } = { guide: null, items: [] };

  beforeEach(async () => {
    found = {
      guide: await prisma.responsibilityGuide.findUnique({
        where: { id: 1 },
        select: { adoptedAt: true },
      }),
      items: await prisma.responsibilityGuideItem.findMany({
        select: {
          part: true,
          responsibility: true,
          note: true,
          sortOrder: true,
        },
      }),
    };
  });

  async function restore(): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.responsibilityGuideItem.deleteMany({});
      await tx.responsibilityGuideItem.createMany({ data: found.items });
      if (found.guide === null) {
        await tx.responsibilityGuide.deleteMany({ where: { id: 1 } });
      } else {
        await tx.responsibilityGuide.upsert({
          where: { id: 1 },
          create: { id: 1, adoptedAt: found.guide.adoptedAt },
          update: { adoptedAt: found.guide.adoptedAt },
        });
      }
    });
  }

  /** The guide's lines now, to compare with what the test found. */
  async function lines(): Promise<string[]> {
    return (
      await prisma.responsibilityGuideItem.findMany({
        orderBy: { sortOrder: "asc" },
        select: { part: true },
      })
    ).map((line) => line.part);
  }

  async function reporterGuide() {
    const response = await inject({
      method: "GET",
      url: "/api/issues/responsibility-guide",
      cookie: cookies[resident.personId],
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ guide: { items: unknown[] } | null }>().guide;
  }

  it("shows a reporter nothing until the board adopts it, and the handlers the example either way", async () => {
    try {
      await prisma.responsibilityGuide.deleteMany({ where: { id: 1 } });
      expect(await reporterGuide()).toBeNull();

      const example = await save(false);
      expect(example.statusCode).toBe(200);
      expect(example.json()).toEqual({
        adoptedAt: null,
        items: [
          {
            part: "Golvbrunn, rensning",
            responsibility: "TENANT_OWNER",
            note: null,
          },
          {
            part: "Stammar",
            responsibility: "ASSOCIATION",
            note: "Tjänar fler än en lägenhet",
          },
        ],
      });
      expect(await reporterGuide()).toBeNull();

      const handler = await inject({
        method: "GET",
        url: "/api/issue-queue/responsibility-guide",
        cookie: cookies[manager.personId],
      });
      expect(handler.statusCode).toBe(200);
      expect(handler.json<{ adoptedAt: string | null }>().adoptedAt).toBeNull();

      const adopted = await save(true);
      const adoptedAt = adopted.json<{ adoptedAt: string | null }>().adoptedAt;
      expect(adoptedAt).not.toBeNull();
      expect((await reporterGuide())?.items).toHaveLength(2);

      // Correcting a line in an adopted guide keeps the day it was adopted.
      const corrected = await save(true, [LINES[0] as object]);
      expect(corrected.json<{ adoptedAt: string | null }>().adoptedAt).toBe(
        adoptedAt,
      );
      expect((await reporterGuide())?.items).toHaveLength(1);

      const withdrawn = await save(false);
      expect(
        withdrawn.json<{ adoptedAt: string | null }>().adoptedAt,
      ).toBeNull();
      expect(await reporterGuide()).toBeNull();
    } finally {
      await restore();
    }
  });

  it("saves one guide at a time, so two saves never leave both sets of lines", async () => {
    /*
     * A save deletes every line and writes its own. Two at once, unserialised,
     * would each delete only what existed when it began and both leave their
     * lines behind. Held here as `save` holds it, the save has to wait behind
     * the lock rather than answer first - which is what fails if the save
     * stops taking it.
     */
    let reached: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const other = prisma.$transaction(
        async (tx) => {
          await lockResponsibilityGuide(tx);
          await tx.responsibilityGuideItem.create({
            data: {
              part: "Den andra sparningen",
              responsibility: "ASSOCIATION",
              sortOrder: 0,
            },
          });
          reached(await backendPid(tx));
          await gate;
        },
        { timeout: 30_000 },
      );
      const holder = await holding;

      let answered = false;
      const request = save(false).finally(() => {
        answered = true;
      });
      let waited = false;
      try {
        await waitFor(
          async () => answered || (await waitersBehind(prisma, holder)) > 0,
        );
        waited = !answered;
      } finally {
        release();
        await other;
      }
      expect(waited, "the save waits for the guide's lock").toBe(true);

      expect((await request).statusCode).toBe(200);
      const parts = await prisma.responsibilityGuideItem.findMany({
        orderBy: { sortOrder: "asc" },
        select: { part: true },
      });
      expect(parts.map((line) => line.part)).toEqual([
        "Golvbrunn, rensning",
        "Stammar",
      ]);
    } finally {
      release();
      await restore();
    }
  });

  it("reads the adoption and the lines as of one moment, so a withdrawal is never read half", async () => {
    /*
     * The adoption and the lines are two reads. Here a save that replaces the
     * lines and withdraws the adoption commits after the reader's first read
     * and before its second, which is the overlap a reporter's request and a
     * board's save can have. Read on one snapshot, the reporter gets the
     * adopted guide as it stood before the save; read each on its own, they
     * would get the old adoption date over the new lines, and be shown an
     * example as the association's answer.
     */
    const guides = app.get(ResponsibilityGuideService);
    try {
      expect((await save(true)).statusCode).toBe(200);
      const before = await guides.read();

      const replacement = [
        {
          part: `Exempelrad ${suffix}`,
          responsibility: "ASSOCIATION" as const,
          note: null,
        },
      ];
      let saved = false;
      const reader = new ResponsibilityGuideService(
        betweenTheFirstReadAndTheNext(prisma, async () => {
          await guides.save({ items: replacement, adopted: false });
          saved = true;
        }),
      );

      const shown = await reader.readForReporter();

      expect(saved, "the save committed while the guide was read").toBe(true);
      expect(shown).toEqual(before);
      expect(await guides.readForReporter()).toBeNull();
      expect(await guides.read()).toEqual({
        adoptedAt: null,
        items: replacement,
      });
    } finally {
      await restore();
    }
  });

  it("refuses a personal identity number, naming where and never what", async () => {
    try {
      const response = await save(true, [
        {
          part: "Golvbrunn",
          responsibility: "TENANT_OWNER",
          note: "Fråga 19121212-1212 om nyckeln",
        },
      ]);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        reason: "personal-identity-number",
        locations: [{ item: 0, field: "note", offset: 6 }],
      });
      expect(response.body).not.toContain("19121212");
      expect(await lines()).toEqual(found.items.map((line) => line.part));
    } finally {
      await restore();
    }
  });

  it("is the board's to change, and not the property manager's or a resident's", async () => {
    const before = await lines();
    for (const reader of [manager, resident]) {
      const response = await inject({
        method: "PUT",
        url: "/api/responsibility-guide",
        cookie: cookies[reader.personId],
        payload: {
          items: [{ ...LINES[0], part: `Inte ${suffix}` }],
          adopted: true,
        },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(await lines()).toEqual(before);
  });
});
