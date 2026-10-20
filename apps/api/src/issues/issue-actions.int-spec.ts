import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { ActionContext } from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * The reads of the issue queue and the contact form inbox (ADR 0040), against
 * a real instance.
 *
 * Two promises only a real register can show.
 *
 * Each action answers to its own capability and nothing else: the board and
 * the property manager read the queue, a resident who files reports does not,
 * and the inbox is the board's and not the property manager's. The capability
 * is re-derived from the register on every call, so these are the register's
 * answers rather than a stub's.
 *
 * And an issue a reporter with protected personal data filed leaves no trace
 * beyond the instance: not on any page of the queue, under any filter, and not
 * when asked for by its identifier, which is answered exactly as an identifier
 * that does not exist. The `ai` surface is checked by calling the registered
 * handler as the AI package would reach it, because nothing mints an `ai`
 * caller yet (ADR 0038); it is the same handler the `mcp` call goes through.
 * The board's own screen still shows the issue, which is the control case.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let registry: ActionRegistryService;
let callers: ActionCallerFactory;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const board = {
  personId: `ia-board-${suffix}`,
  email: `ia-board-${suffix}@exempel.se`,
};
const manager = {
  personId: `ia-manager-${suffix}`,
  email: `ia-manager-${suffix}@exempel.se`,
};
const resident = {
  personId: `ia-resident-${suffix}`,
  email: `ia-resident-${suffix}@exempel.se`,
};
/** Recorded with protected personal data, and reports from her own home. */
const shielded = {
  personId: `ia-shielded-${suffix}`,
  email: `ia-shielded-${suffix}@exempel.se`,
};
const personIds = [
  board.personId,
  manager.personId,
  resident.personId,
  shielded.personId,
];

const addressId = `ia-address-${suffix}`;
const residentApartmentId = `ia-apartment-resident-${suffix}`;
const shieldedApartmentId = `ia-apartment-shielded-${suffix}`;
/** The shielded reporter's apartment number, which must appear nowhere. */
const SHIELDED_APARTMENT_NUMBER = `9${suffix.slice(-3)}`;

const typeIds = {
  member: `ia-type-member-${suffix}`,
  boardInternal: `ia-type-board-${suffix}`,
};

/** What the shielded reporter wrote, which must appear nowhere either. */
const SHIELDED_TEXT = `Fukt i badrummet hos mig ${suffix}`;
const SHIELDED_LOCATION = `Badrummet ${suffix}`;

const issueIds = {
  first: `ia-issue-first-${suffix}`,
  shielded: `ia-issue-shielded-${suffix}`,
  second: `ia-issue-second-${suffix}`,
  internal: `ia-issue-internal-${suffix}`,
  external: `ia-issue-external-${suffix}`,
};

const contactId = `ia-contact-${suffix}`;
const CONTACT_EMAIL = `avsandare-${suffix}@exempel.se`;

let associationCreatedHere = false;
let boardCookie = "";

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
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
        // 10.75.0.0/16 is this suite's; every other suite holds its own.
        "x-forwarded-for": `10.75.${String(subnet)}.${String(host + 1)}`,
        ...options.headers,
      },
    });
}

/**
 * A caller as a connected app acting for this person, built where the
 * authorization guard stands, as `action-personal-data.int-spec.ts` builds it.
 * The capabilities on the request are empty on purpose: the registry reads the
 * register, not the request.
 */
function connectedApp(personId: string): ActionCaller {
  const request = {
    id: `request-${suffix}`,
    principal: { personId, capabilities: new Set<string>() },
    token: {
      clientId: `client-${suffix}`,
      clientHost: "app.example",
      scopes: ["mcp:read"],
    },
  } as unknown as RequestWithToken;
  markAuthenticated(request);
  return callers.forRequest(request);
}

/** The same person in the web interface: a session and no token. */
function webInterface(personId: string): ActionCaller {
  const request = {
    id: `request-web-${suffix}`,
    principal: { personId, capabilities: new Set<string>() },
  } as unknown as RequestWithToken;
  markAuthenticated(request);
  return callers.forRequest(request);
}

interface PublishedIssue {
  id: string;
  type: { id: string; audience: string };
  reporter: Record<string, unknown>;
  apartment: { id: string; number: string } | null;
  photoCount: number;
}

interface IssuePage {
  issues: PublishedIssue[];
  nextCursor: string | null;
}

/** Every page of the queue under one filter, as one list and as raw text. */
async function readWholeQueue(
  read: (input: Record<string, unknown>) => Promise<IssuePage>,
  filter: Record<string, unknown>,
): Promise<{ issues: PublishedIssue[]; text: string; pages: number }> {
  const issues: PublishedIssue[] = [];
  let text = "";
  let pages = 0;
  let after: string | null = null;
  do {
    const page: IssuePage = await read({
      ...filter,
      ...(after === null ? {} : { after }),
    });
    issues.push(...page.issues);
    text += JSON.stringify(page);
    pages += 1;
    after = page.nextCursor;
  } while (after !== null && pages < 500);
  return { issues, text, pages };
}

/** Through the registry, as a connected app arriving on `mcp`. */
function overMcp(personId: string) {
  return (input: Record<string, unknown>) =>
    registry.invoke<IssuePage>(connectedApp(personId), "issue_list", input);
}

/**
 * The registered handler as the AI package would reach it, with its output
 * held to the action's own schema exactly as `invoke()` holds it.
 */
async function overAi<Output>(
  name: string,
  input: Record<string, unknown>,
): Promise<Output> {
  const held = registry.get(name);
  if (held === null) {
    throw new Error(`${name} is not registered`);
  }
  const { definition } = held;
  expect(definition.surfaces).toContain("ai");
  const parsed = await definition.input["~standard"].validate(input);
  if (parsed.issues !== undefined) {
    throw new Error(`${name} refused its input`);
  }
  const context: ActionContext = {
    principal: { personId: board.personId, capabilities: ["issues:handle"] },
    channel: "ai",
    requestId: `request-ai-${suffix}`,
    now: new Date(),
  };
  const output = await definition.handler(parsed.value, context);
  const validated = await definition.output["~standard"].validate(output);
  expect(validated.issues).toBeUndefined();
  return output as Output;
}

/** Whatever a refusal carries, for comparing two of them. */
async function refusalOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (cause) {
    const held = cause as { reason?: unknown; message?: unknown };
    return { reason: held.reason, message: held.message };
  }
  throw new Error("The call was not refused.");
}

/** Every trace of the shielded reporter's issue a document could carry. */
function expectNoTraceOfShielded(text: string): void {
  for (const trace of [
    issueIds.shielded,
    shielded.personId,
    shieldedApartmentId,
    SHIELDED_APARTMENT_NUMBER,
    SHIELDED_TEXT,
    SHIELDED_LOCATION,
    "Skyddad",
  ]) {
    expect(text, `the answer carries ${trace}`).not.toContain(trace);
  }
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
  registry = app.get(ActionRegistryService);
  callers = app.get(ActionCallerFactory);
  const encryption = app.get(FieldEncryptionService);

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

  await prisma.person.createMany({
    data: [
      { id: board.personId, firstName: "Bea", lastName: `Atgard${suffix}` },
      { id: manager.personId, firstName: "Frida", lastName: `Atgard${suffix}` },
      { id: resident.personId, firstName: "Rune", lastName: `Atgard${suffix}` },
      {
        id: shielded.personId,
        firstName: "Skyddad",
        lastName: `Atgard${suffix}`,
        protectedPersonalData: true,
      },
    ],
  });
  for (const person of [board, manager, resident, shielded]) {
    await app.get(AuthService).createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Atgardsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: [
          { id: residentApartmentId, number: "1001", floor: 0 },
          {
            id: shieldedApartmentId,
            number: SHIELDED_APARTMENT_NUMBER,
            floor: 1,
          },
        ],
      },
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: resident.personId,
        apartmentId: residentApartmentId,
        role: "MEMBER",
        movedInOn: new Date("2020-01-01"),
      },
      {
        personId: shielded.personId,
        apartmentId: shieldedApartmentId,
        role: "MEMBER",
        movedInOn: new Date("2020-01-01"),
      },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  await prisma.issueType.createMany({
    data: [
      {
        id: typeIds.member,
        name: `Fel i lagenheten ${suffix}`,
        audience: "MEMBER",
        sortOrder: 1,
      },
      {
        id: typeIds.boardInternal,
        name: `Internt ${suffix}`,
        audience: "BOARD",
        sortOrder: 2,
      },
    ],
  });

  /*
   * The shielded report between two ordinary ones, so a page boundary can
   * fall on either side of it. Dated apart, so the order is the one written
   * here rather than the one the database happens to answer in.
   */
  const external = await encryption.encrypt(
    "issue.reporterEmail",
    `forbipasserande-${suffix}@exempel.se`,
  );
  const externalName = await encryption.encrypt(
    "issue.reporterName",
    "Gunnar Forbipasserande",
  );
  await prisma.issue.createMany({
    data: [
      {
        id: issueIds.first,
        typeId: typeIds.member,
        reporterPersonId: resident.personId,
        apartmentId: residentApartmentId,
        description: "Kranen droppar.",
        createdAt: new Date("2026-03-01T08:00:00.000Z"),
      },
      {
        id: issueIds.shielded,
        typeId: typeIds.member,
        reporterPersonId: shielded.personId,
        apartmentId: shieldedApartmentId,
        location: SHIELDED_LOCATION,
        description: SHIELDED_TEXT,
        createdAt: new Date("2026-03-02T08:00:00.000Z"),
      },
      {
        id: issueIds.second,
        typeId: typeIds.member,
        reporterPersonId: resident.personId,
        apartmentId: residentApartmentId,
        description: "Elementet ar kallt.",
        createdAt: new Date("2026-03-03T08:00:00.000Z"),
      },
      {
        id: issueIds.internal,
        typeId: typeIds.boardInternal,
        reporterPersonId: board.personId,
        description: "Besiktning av taket.",
        createdAt: new Date("2026-03-04T08:00:00.000Z"),
      },
      {
        id: issueIds.external,
        typeId: typeIds.member,
        reporterPersonId: null,
        reporterNameCipher: externalName.cipher,
        reporterEmailCipher: external.cipher,
        reporterEmailIndex: external.index,
        description: "Porten star och slar.",
        createdAt: new Date("2026-03-05T08:00:00.000Z"),
      },
    ],
  });

  const contactEmail = await encryption.encrypt(
    "contactSubmission.email",
    CONTACT_EMAIL,
  );
  await prisma.contactSubmission.create({
    data: {
      id: contactId,
      name: "Gunnar",
      emailCipher: contactEmail.cipher,
      emailIndex: contactEmail.index,
      message: `Hur stall jag mig i kon? ${suffix}`,
    },
  });

  const signedIn = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: board.email, password: PASSWORD },
  });
  const setCookie = signedIn.headers["set-cookie"];
  boardCookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
    .map((value) => value.split(";")[0])
    .join("; ");
}, 180_000);

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await prisma.contactSubmission.deleteMany({ where: { id: contactId } });
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
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.apartment.deleteMany({
        where: { id: { in: [residentApartmentId, shieldedApartmentId] } },
      });
      await prisma.address.deleteMany({ where: { id: addressId } });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
      if (associationCreatedHere) {
        await prisma.association.deleteMany({ where: { id: 1 } });
      }
    }
  } finally {
    await app?.close();
  }
});

describe("who may read the queue and the inbox", () => {
  it("lets the board and the property manager read the queue", async () => {
    for (const personId of [board.personId, manager.personId]) {
      const page = await overMcp(personId)({ typeId: typeIds.member });
      expect(
        page.issues.map((issue) => issue.id),
        personId,
      ).toContain(issueIds.first);

      const issue = await registry.invoke<PublishedIssue>(
        connectedApp(personId),
        "issue_get",
        { id: issueIds.first },
      );
      expect(issue.id).toBe(issueIds.first);
    }
  });

  it("refuses the queue to a resident who files reports", async () => {
    await expect(overMcp(resident.personId)({})).rejects.toMatchObject({
      reason: "forbidden-capability",
    });
    await expect(
      registry.invoke(connectedApp(resident.personId), "issue_get", {
        id: issueIds.first,
      }),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
  });

  it("lets the board read the inbox and refuses it to the property manager", async () => {
    const page = await registry.invoke<{
      messages: { id: string }[];
    }>(connectedApp(board.personId), "contact_message_list", { limit: 20 });
    expect(page.messages.length).toBeGreaterThan(0);

    for (const personId of [manager.personId, resident.personId]) {
      await expect(
        registry.invoke(connectedApp(personId), "contact_message_list", {}),
      ).rejects.toMatchObject({ reason: "forbidden-capability" });
    }
  });

  it("is not offered in the web interface, whoever asks", async () => {
    for (const name of ["issue_list", "issue_get", "contact_message_list"]) {
      await expect(
        registry.invoke(webInterface(board.personId), name, {
          id: issueIds.first,
        }),
      ).rejects.toMatchObject({ reason: "forbidden-surface" });
    }
  });
});

describe("what the queue carries beyond the instance", () => {
  it("narrows by status, type and audience", async () => {
    const internal = await readWholeQueue(overMcp(board.personId), {
      audience: "BOARD",
    });
    const ids = internal.issues.map((issue) => issue.id);
    expect(ids).toContain(issueIds.internal);
    expect(ids).not.toContain(issueIds.first);

    const done = await overMcp(board.personId)({
      typeId: typeIds.member,
      status: "DONE",
    });
    expect(done.issues).toEqual([]);
  });

  it("gives an external reporter's name and never the address they left", async () => {
    const issue = await registry.invoke<PublishedIssue>(
      connectedApp(manager.personId),
      "issue_get",
      { id: issueIds.external },
    );

    expect(issue.reporter).toEqual({
      kind: "external",
      name: "Gunnar Forbipasserande",
    });
    expect(JSON.stringify(issue)).not.toContain(`forbipasserande-${suffix}`);
  });

  it("gives a contact message's sender by name and never their address", async () => {
    let found: Record<string, unknown> | undefined;
    let text = "";
    let after: string | null = null;
    do {
      const page: {
        messages: Record<string, unknown>[];
        nextCursor: string | null;
      } = await registry.invoke(
        connectedApp(board.personId),
        "contact_message_list",
        { limit: 20, ...(after === null ? {} : { after }) },
      );
      text += JSON.stringify(page);
      found ??= page.messages.find((message) => message.id === contactId);
      after = page.nextCursor;
    } while (after !== null);

    expect(found).toMatchObject({
      name: "Gunnar",
      message: `Hur stall jag mig i kon? ${suffix}`,
      handled: false,
    });
    expect(text).not.toContain(CONTACT_EMAIL);
  });
});

describe("an issue a reporter with protected personal data filed", () => {
  it("is on the board's own screen, which is the control case", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/issue-queue",
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const shown = response
      .json<{ id: string; reporter: { kind: string } }[]>()
      .find((issue) => issue.id === issueIds.shielded);
    expect(shown?.reporter.kind).toBe("protected");
  });

  it.each([
    ["the whole queue", {}],
    ["its status", { status: "NEW" }],
    ["its type", { typeId: typeIds.member }],
    ["its audience", { audience: "MEMBER" }],
  ])(
    "leaves no trace on mcp, read under %s",
    async (_name, filter: Record<string, unknown>) => {
      for (const personId of [board.personId, manager.personId]) {
        const { issues, text } = await readWholeQueue(
          overMcp(personId),
          filter,
        );
        expect(issues.length, personId).toBeGreaterThan(0);
        expectNoTraceOfShielded(text);
      }
    },
  );

  it("leaves no trace on ai", async () => {
    const { text } = await readWholeQueue(
      (input) => overAi<IssuePage>("issue_list", input),
      {},
    );
    expectNoTraceOfShielded(text);

    await expect(
      overAi("issue_get", { id: issueIds.shielded }),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
  });

  it("leaves no gap in the pages it is left out of", async () => {
    /*
     * One issue to a page, so a page boundary falls on both sides of the
     * shielded report. The pages are not short for it and do not repeat a
     * neighbour of it: every other issue of the type arrives once, in order.
     */
    const { issues, pages } = await readWholeQueue(overMcp(board.personId), {
      typeId: typeIds.member,
      limit: 1,
    });

    expect(issues.map((issue) => issue.id)).toEqual([
      issueIds.first,
      issueIds.second,
      issueIds.external,
    ]);
    expect(pages).toBe(3);
  });

  it("is answered by its identifier as an issue that does not exist", async () => {
    const withheld = await refusalOf(
      registry.invoke(connectedApp(board.personId), "issue_get", {
        id: issueIds.shielded,
      }),
    );
    const missing = await refusalOf(
      registry.invoke(connectedApp(board.personId), "issue_get", {
        id: `ia-issue-never-${suffix}`,
      }),
    );

    expect(withheld.reason).toBe("issue-not-found");
    expect(withheld).toEqual(missing);
  });
});
