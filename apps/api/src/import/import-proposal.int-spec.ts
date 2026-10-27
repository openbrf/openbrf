import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  ImportProposalRefusedError,
  type PluginHost,
  type PluginManifest,
  type PluginPermission,
} from "@openbrf/plugin-sdk";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  createPluginHost,
  PluginHostBinding,
  type PluginHostServices,
} from "../plugins/plugin-host";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { writeCsv } from "./csv";
import { ImportApplyService } from "./import-apply.service";
import { ImportPreviewService } from "./import-preview.service";
import {
  ImportProposalService,
  type ImportProposalSessionView,
  type ImportProposalView,
  PROPOSAL_RECORD_RETENTION_MS,
} from "./import-proposal.service";
import type { ImportPreviewRun } from "./import-preview.service";
import type { ImportRunView } from "./import-run";

/**
 * Import proposals (ADR 0043), from the plugin's host object to the register,
 * against a real database and a real job queue.
 *
 * What matters is what the plugin cannot do: a proposal writes nothing until a
 * board member previews and applies it, one plugin has one waiting, and every
 * way a proposal ends without being applied drops its rows. And what the
 * plugin is told: its receipt, a refusal's reason, and the state of its own
 * proposals - never anybody else's.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let proposals: ImportProposalService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const surname = `Propman${suffix}`;
const addressId = `prop-address-${suffix}`;
const addressLabel = `Propgatan ${suffix}`;
const apartmentId = `prop-apartment-${suffix}`;

const actors = {
  board: {
    personId: `prop-board-${suffix}`,
    email: `prop-board-${suffix}@exempel.se`,
  },
  resident: {
    personId: `prop-resident-${suffix}`,
    email: `prop-resident-${suffix}@exempel.se`,
  },
} as const;

/** Each case its own plugin, so one plugin's waiting proposal is its own. */
let pluginCounter = 0;
const pluginIds: string[] = [];
function nextPluginId(): string {
  pluginCounter += 1;
  const id = `prop-${suffix}-${String(pluginCounter)}`;
  pluginIds.push(id);
  return id;
}

const PROPOSER: Omit<PluginManifest, "id"> = {
  apiVersion: 1,
  personRecords: [],
  entry: { server: "./dist/server.cjs" },
  permissions: ["addressBook:proposeImport"],
  personalData: [
    "name",
    "apartment",
    "residency",
    "email",
    "phone",
    "personalIdentityNumber",
    "protected",
  ],
  recipients: [],
  actions: [],
  deviceRoutes: [],
  residentRoutes: [],
  extensionPoints: [],
  extends: [],
  ai: false,
  blocks: [],
};

/**
 * The host object a plugin with addressBook:proposeImport alone is given,
 * bound to the application's own proposal service and address book.
 */
function hostFor(
  pluginId: string,
  consented: PluginPermission[] = ["addressBook:proposeImport"],
): PluginHost {
  const binding = new PluginHostBinding();
  binding.bind({
    importProposals: proposals,
    addressBook: {
      apartments: () => {
        throw new Error("read the register");
      },
      residents: () => {
        throw new Error("read the register");
      },
      summary: () => {
        throw new Error("read the register");
      },
    },
  } as unknown as PluginHostServices);
  return createPluginHost(binding, {
    manifest: { ...PROPOSER, id: pluginId },
    consented,
    serving: true,
    bufferedActions: [],
    bufferedBlocks: [],
    bufferedExtensionPoints: [],
    bufferedContributions: [],
  });
}

const HEADERS = [
  "Adress",
  "Lägenhetsnummer",
  "Förnamn",
  "Efternamn",
  "Roll",
  "Inflyttningsdatum",
];

/** A file of residents only, so an apply leaves no member register entry. */
function memberList(...firstNames: string[]): Uint8Array {
  return new TextEncoder().encode(
    writeCsv([
      HEADERS,
      ...firstNames.map((firstName) => [
        addressLabel,
        "3101",
        firstName,
        surname,
        "Boende",
        "2021-04-01",
      ]),
    ]),
  );
}

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
        "x-forwarded-for": `10.9.0.${String(ipCounter % 250)}`,
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

function reasonOf(response: { body: string }): string {
  return (JSON.parse(response.body) as { reason: string }).reason;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ImportProposalRefusedError);
  return (error as ImportProposalRefusedError).reason;
}

async function listed(cookie: string): Promise<ImportProposalView[]> {
  const response = await inject({
    method: "GET",
    url: "/api/import/proposals",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return (JSON.parse(response.body) as { proposals: ImportProposalView[] })
    .proposals;
}

async function open(
  cookie: string,
  proposalId: string,
): Promise<ImportProposalSessionView> {
  const response = await inject({
    method: "GET",
    url: `/api/import/proposals/${proposalId}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as ImportProposalSessionView;
}

/** Previews a proposal with the mapping it was opened with, until ready. */
async function preview(
  cookie: string,
  session: ImportProposalSessionView,
): Promise<string> {
  const asked = await inject({
    method: "POST",
    url: `/api/import/sessions/${session.sessionId}/preview`,
    payload: {
      mapping: session.savedMapping?.mapping ?? session.suggestedMapping,
    },
    headers: { cookie },
  });
  expect(asked.statusCode).toBe(202);
  const { previewId } = JSON.parse(asked.body) as ImportPreviewRun;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await inject({
      method: "GET",
      url: `/api/import/sessions/${session.sessionId}/preview/${previewId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const run = JSON.parse(response.body) as ImportPreviewRun;
    if (run.status === "READY" && run.preview !== null) {
      return run.preview.previewToken;
    }
    expect(run.status).toBe("PLANNING");
    if (Date.now() > deadline) {
      throw new Error(`Preview ${previewId} did not finish`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function apply(cookie: string, sessionId: string, previewToken: string) {
  return inject({
    method: "POST",
    url: `/api/import/sessions/${sessionId}/apply`,
    payload: { previewToken, decisions: {} },
    headers: { cookie },
  });
}

async function waitForApplied(
  cookie: string,
  sessionId: string,
): Promise<ImportRunView> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await inject({
      method: "GET",
      url: `/api/import/sessions/${sessionId}/run`,
      headers: { cookie },
    });
    const run = JSON.parse(response.body) as ImportRunView;
    if (run.status === "APPLIED" || run.status === "FAILED") {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`Import ${sessionId} stayed ${run.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function rowsOf(sessionId: string) {
  return prisma.importSession.findUnique({
    where: { id: sessionId },
    select: {
      rowsCipher: true,
      columns: true,
      previewCipher: true,
      proposalOutcome: true,
      status: true,
    },
  });
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
  proposals = app.get(ImportProposalService);
  await app.get(ImportPreviewService).startPreviewWorker();
  await app.get(ImportApplyService).startApplyWorker();

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Propgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 940,
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "3101", floor: 1 },
  });

  for (const [actor, firstName] of [
    [actors.board, "Bea"],
    [actors.resident, "Rita"],
  ] as const) {
    const email = await encryption.encrypt("person.email", actor.email);
    await prisma.person.create({
      data: {
        id: actor.personId,
        firstName,
        lastName: `${surname}Actor`,
        emailCipher: email.cipher,
        emailIndex: email.index,
        preferredLocale: "sv",
      },
    });
  }
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
}, 120_000);

// One import runs at a time in this database: an apply a failed assertion left
// running would refuse every later one, here and in the next suite.
afterEach(async () => {
  await prisma.importSession.updateMany({
    where: {
      proposedByPluginId: { in: pluginIds },
      status: { in: ["QUEUED", "APPLYING"] },
    },
    data: {
      status: "FAILED",
      failureReason: "apply-interrupted",
      finishedAt: new Date(),
    },
  });
});

afterAll(async () => {
  const personIds = [actors.board.personId, actors.resident.personId];
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.importSession.deleteMany({
    where: { proposedByPluginId: { in: pluginIds } },
  });
  await prisma.importSource.deleteMany({
    where: { pluginId: { in: pluginIds } },
  });
  await prisma.residency.deleteMany({ where: { apartmentId } });
  await prisma.person.deleteMany({
    where: {
      OR: [{ id: { in: personIds } }, { lastName: surname }],
    },
  });
  await prisma.apartment.deleteMany({ where: { id: apartmentId } });
  await prisma.address.deleteMany({ where: { id: addressId } });
  await app.close();
});

describe("a plugin proposing an import", () => {
  it("is stored for the board, audited without the file, and writes nothing", async () => {
    const pluginId = nextPluginId();
    const host = hostFor(pluginId);
    const before = await prisma.person.count({ where: { lastName: surname } });

    const receipt = await host.imports.propose({
      fileName: "medlemmar.csv",
      content: memberList("Ada", "Bo"),
      sender: "styrelsen@exempel.se",
    });

    expect(receipt).toEqual({
      proposalId: expect.any(String) as string,
      rowCount: 2,
      expiresAt: expect.any(String) as string,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      "expiresAt",
      "proposalId",
      "rowCount",
    ]);
    await expect(host.imports.status(receipt.proposalId)).resolves.toEqual({
      state: "pending",
      decidedAt: null,
    });
    expect(await prisma.person.count({ where: { lastName: surname } })).toBe(
      before,
    );

    const stored = await prisma.importSession.findUniqueOrThrow({
      where: { id: receipt.proposalId },
      select: {
        createdById: true,
        senderCipher: true,
        status: true,
        previewStatus: true,
      },
    });
    // Nobody uploaded it, and nothing is planned until somebody opens it.
    expect(stored).toMatchObject({
      createdById: null,
      status: "MAPPING",
      previewStatus: null,
    });
    expect(stored.senderCipher).not.toContain("styrelsen");

    const entries = await prisma.auditLogEntry.findMany({
      where: { targetId: receipt.proposalId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "IMPORT_PROPOSED",
      channel: "PLUGIN",
      actorPersonId: null,
      targetKind: "importSession",
      context: { pluginId, rowCount: 2 },
    });
    expect(JSON.stringify(entries[0]?.context)).not.toMatch(
      /medlemmar|styrelsen/,
    );

    const cookie = await signIn(actors.board.email);
    const view = (await listed(cookie)).find(
      (proposal) => proposal.proposalId === receipt.proposalId,
    );
    expect(view).toMatchObject({
      plugin: { id: pluginId, name: null },
      fileName: "medlemmar.csv",
      sender: "styrelsen@exempel.se",
      rowCount: 2,
      state: "pending",
    });
  });

  it("is refused, with nothing stored, for every reason an upload is", async () => {
    const pluginId = nextPluginId();
    const host = hostFor(pluginId);

    expect(
      await refusal(
        host.imports.propose({ fileName: "a.csv", content: new Uint8Array() }),
      ),
    ).toBe("file-empty");
    expect(
      await refusal(
        host.imports.propose({
          fileName: "a.csv",
          content: new TextEncoder().encode(writeCsv([HEADERS])),
        }),
      ),
    ).toBe("file-empty");
    // Saved without its title row: the first member's row is where the
    // titles belong, and would be stored as the proposal's columns.
    expect(
      await refusal(
        host.imports.propose({
          fileName: "a.csv",
          content: new TextEncoder().encode(
            writeCsv([
              [addressLabel, "3101", "Ada", surname, "Boende", "2021-04-01"],
              [addressLabel, "3101", "Bo", surname, "Boende", "2021-04-01"],
            ]),
          ),
        }),
      ),
    ).toBe("header-row-missing");
    expect(
      await refusal(
        host.imports.propose({
          fileName: "a.csv",
          content: memberList("Ada"),
          sender: "x".repeat(321),
        }),
      ),
    ).toBe("sender-too-long");
    expect(
      await refusal(
        host.imports.propose({ fileName: "  ", content: memberList("Ada") }),
      ),
    ).toBe("file-name-invalid");

    expect(
      await prisma.importSession.count({
        where: { proposedByPluginId: pluginId },
      }),
    ).toBe(0);
  });

  it("refuses a file holding the rows of the one still waiting", async () => {
    const host = hostFor(nextPluginId());
    const first = await host.imports.propose({
      fileName: "a.csv",
      content: memberList("Ada"),
    });

    expect(
      await refusal(
        host.imports.propose({ fileName: "b.csv", content: memberList("Ada") }),
      ),
    ).toBe("file-unchanged");
    await expect(host.imports.status(first.proposalId)).resolves.toMatchObject({
      state: "pending",
    });
  });

  it("keeps one proposal waiting: a newer file supersedes the one before, which drops its rows", async () => {
    const pluginId = nextPluginId();
    const host = hostFor(pluginId);
    const first = await host.imports.propose({
      fileName: "a.csv",
      content: memberList("Ada"),
    });
    const second = await host.imports.propose({
      fileName: "b.csv",
      content: memberList("Ada", "Bo"),
    });

    const superseded = await host.imports.status(first.proposalId);
    expect(superseded.state).toBe("superseded");
    expect(superseded.decidedAt).not.toBeNull();
    await expect(host.imports.status(second.proposalId)).resolves.toEqual({
      state: "pending",
      decidedAt: null,
    });
    expect(await rowsOf(first.proposalId)).toMatchObject({
      rowsCipher: null,
      columns: [],
      proposalOutcome: "SUPERSEDED",
    });
    // Not audited on its own: the next proposal's entry is.
    expect(
      await prisma.auditLogEntry.count({
        where: { targetId: first.proposalId },
      }),
    ).toBe(1);
  });

  it("leaves one waiting when two files arrive at once", async () => {
    const pluginId = nextPluginId();
    const host = hostFor(pluginId);

    const settled = await Promise.allSettled([
      host.imports.propose({ fileName: "a.csv", content: memberList("Ada") }),
      host.imports.propose({ fileName: "b.csv", content: memberList("Bo") }),
    ]);

    expect(settled.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(
      await prisma.importSession.count({
        where: {
          proposedByPluginId: pluginId,
          status: "MAPPING",
          proposalOutcome: null,
        },
      }),
    ).toBe(1);
  });

  it("answers unknown for another plugin's proposal, and withdraws only its own", async () => {
    const owner = hostFor(nextPluginId());
    const other = hostFor(nextPluginId());
    const { proposalId } = await owner.imports.propose({
      fileName: "a.csv",
      content: memberList("Ada"),
    });

    await expect(other.imports.status(proposalId)).resolves.toEqual({
      state: "unknown",
      decidedAt: null,
    });
    await expect(other.imports.withdraw(proposalId)).resolves.toBe(false);
    await expect(owner.imports.status("no-such-proposal")).resolves.toEqual({
      state: "unknown",
      decidedAt: null,
    });

    await expect(owner.imports.withdraw(proposalId)).resolves.toBe(true);
    await expect(owner.imports.withdraw(proposalId)).resolves.toBe(false);
    await expect(owner.imports.status(proposalId)).resolves.toMatchObject({
      state: "withdrawn",
    });
    expect(await rowsOf(proposalId)).toMatchObject({ rowsCipher: null });
  });

  it("cannot read the register, whatever it proposes", async () => {
    const host = hostFor(nextPluginId());

    await expect(host.addressBook.residents()).rejects.toThrow(
      'requiring the "addressBook:read" permission',
    );
    await expect(
      host.finances.charges({ from: "2026-01-01", to: "2026-12-31" }),
    ).rejects.toThrow('requiring the "finances:read" permission');
  });
});

describe("the board deciding a proposal", () => {
  it("opens it at the mapping step, previews and applies it, and the register gets the rows", async () => {
    const pluginId = nextPluginId();
    const host = hostFor(pluginId);
    const cookie = await signIn(actors.board.email);
    const { proposalId } = await host.imports.propose({
      fileName: "medlemmar.csv",
      content: memberList("Cilla"),
      sender: "styrelsen@exempel.se",
    });

    const session = await open(cookie, proposalId);
    expect(session).toMatchObject({
      sessionId: proposalId,
      rowCount: 1,
      columns: HEADERS,
      savedMapping: null,
      columnsChanged: false,
      proposal: { state: "pending", sender: "styrelsen@exempel.se" },
    });
    expect(session.sample[0]).toContain("Cilla");

    const token = await preview(cookie, session);
    const started = await apply(cookie, proposalId, token);
    expect(started.statusCode).toBe(202);
    await expect(host.imports.status(proposalId)).resolves.toMatchObject({
      state: expect.stringMatching(/^(applying|applied)$/) as string,
    });
    const run = await waitForApplied(cookie, proposalId);
    expect(run.status).toBe("APPLIED");
    expect(run.result.personsCreated).toBe(1);

    const applied = await host.imports.status(proposalId);
    expect(applied.state).toBe("applied");
    expect(applied.decidedAt).not.toBeNull();
    // The ended import drops its rows; the record stays, for the history.
    expect(await rowsOf(proposalId)).toMatchObject({
      rowsCipher: null,
      previewCipher: null,
      columns: [],
      status: "APPLIED",
    });
    expect(
      await prisma.person.count({
        where: { firstName: "Cilla", lastName: surname },
      }),
    ).toBe(1);

    // The same rows again are the file the board last applied from it.
    expect(
      await refusal(
        host.imports.propose({
          fileName: "again.csv",
          content: memberList("Cilla"),
        }),
      ),
    ).toBe("file-unchanged");

    // The next file with the same titles is offered the mapping started with.
    const next = await host.imports.propose({
      fileName: "next.csv",
      content: memberList("Cilla", "Dan"),
    });
    const reopened = await open(cookie, next.proposalId);
    expect(reopened.savedMapping?.mapping).toEqual(session.suggestedMapping);
    expect(reopened.columnsChanged).toBe(false);

    // One with other titles is not, and the screen says the columns changed.
    const changed = await host.imports.propose({
      fileName: "changed.csv",
      content: new TextEncoder().encode(
        writeCsv([
          [...HEADERS, "Telefon"],
          [addressLabel, "3101", "Dan", surname, "Boende", "2021-04-01", ""],
        ]),
      ),
    });
    const remapped = await open(cookie, changed.proposalId);
    expect(remapped.savedMapping).toBeNull();
    expect(remapped.columnsChanged).toBe(true);
  });

  it("refuses the apply of a proposal the plugin replaced while it was previewed", async () => {
    const host = hostFor(nextPluginId());
    const cookie = await signIn(actors.board.email);
    const first = await host.imports.propose({
      fileName: "a.csv",
      content: memberList("Eva"),
    });
    const session = await open(cookie, first.proposalId);
    const token = await preview(cookie, session);

    await host.imports.propose({
      fileName: "b.csv",
      content: memberList("Eva", "Fia"),
    });
    const refused = await apply(cookie, first.proposalId, token);

    expect(refused.statusCode).toBe(409);
    expect(reasonOf(refused)).toBe("proposal-superseded");
    expect(
      await prisma.person.count({
        where: { firstName: "Eva", lastName: surname },
      }),
    ).toBe(0);
  });

  it("answers proposal-expired to a preview or apply once the proposal has run out, before the purge marks it", async () => {
    const host = hostFor(nextPluginId());
    const cookie = await signIn(actors.board.email);
    const { proposalId } = await host.imports.propose({
      fileName: "a.csv",
      content: memberList("Gunnel"),
    });
    const session = await open(cookie, proposalId);
    const token = await preview(cookie, session);

    // Run out by the clock; the nightly purge has not marked it.
    await prisma.importSession.update({
      where: { id: proposalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const previewed = await inject({
      method: "POST",
      url: `/api/import/sessions/${proposalId}/preview`,
      payload: { mapping: session.suggestedMapping },
      headers: { cookie },
    });
    expect(previewed.statusCode).toBe(409);
    expect(reasonOf(previewed)).toBe("proposal-expired");

    const applied = await apply(cookie, proposalId, token);
    expect(applied.statusCode).toBe(409);
    expect(reasonOf(applied)).toBe("proposal-expired");

    expect((await rowsOf(proposalId))?.proposalOutcome).toBeNull();
    expect(
      await prisma.person.count({
        where: { firstName: "Gunnel", lastName: surname },
      }),
    ).toBe(0);
  });

  it("keeps the import started from a proposal on the screen for a day after it ended, not until the proposal's own days run out", async () => {
    const host = hostFor(nextPluginId());
    const cookie = await signIn(actors.board.email);
    const { proposalId } = await host.imports.propose({
      fileName: "sent.csv",
      content: memberList("Kerstin"),
    });
    const session = await open(cookie, proposalId);
    await apply(cookie, proposalId, await preview(cookie, session));
    await waitForApplied(cookie, proposalId);

    const readActive = async (): Promise<ImportRunView | null> => {
      const response = await inject({
        method: "GET",
        url: "/api/import/sessions/active",
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body) as ImportRunView | null;
    };

    // Applied on the last hours of its fourteen days: the proposal has run
    // out, the import ended a moment ago.
    await prisma.importSession.update({
      where: { id: proposalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await readActive())?.sessionId).toBe(proposalId);

    // Ended longer ago than an upload's import would be shown.
    await prisma.importSession.update({
      where: { id: proposalId },
      data: { finishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    expect((await readActive())?.sessionId).not.toBe(proposalId);
  });

  it("rejects it on the board member's channel, and drops its rows", async () => {
    const pluginId = nextPluginId();
    const host = hostFor(pluginId);
    const cookie = await signIn(actors.board.email);
    const { proposalId } = await host.imports.propose({
      fileName: "a.csv",
      content: memberList("Gun"),
    });

    const rejected = await inject({
      method: "POST",
      url: `/api/import/proposals/${proposalId}/reject`,
      headers: { cookie },
    });
    expect(rejected.statusCode).toBe(204);

    await expect(host.imports.status(proposalId)).resolves.toMatchObject({
      state: "rejected",
    });
    expect(await rowsOf(proposalId)).toMatchObject({ rowsCipher: null });
    const entry = await prisma.auditLogEntry.findFirst({
      where: { targetId: proposalId, action: "IMPORT_PROPOSAL_REJECTED" },
    });
    expect(entry).toMatchObject({
      channel: "WEB",
      actorPersonId: actors.board.personId,
      context: { pluginId },
    });

    const again = await inject({
      method: "POST",
      url: `/api/import/proposals/${proposalId}/reject`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(409);
    expect(reasonOf(again)).toBe("proposal-rejected");
    const reopened = await inject({
      method: "GET",
      url: `/api/import/proposals/${proposalId}`,
      headers: { cookie },
    });
    expect(reasonOf(reopened)).toBe("proposal-rejected");
  });

  it("is not for a resident", async () => {
    const cookie = await signIn(actors.resident.email);

    const response = await inject({
      method: "GET",
      url: "/api/import/proposals",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("the purge", () => {
  it("expires a proposal nobody decided, and deletes its record 90 days after", async () => {
    const pluginId = nextPluginId();
    const host = hostFor(pluginId);
    const { proposalId } = await host.imports.propose({
      fileName: "a.csv",
      content: memberList("Hans"),
    });
    await prisma.importSession.update({
      where: { id: proposalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // Expired by the clock before the purge has run.
    await expect(host.imports.status(proposalId)).resolves.toMatchObject({
      state: "expired",
    });
    await proposals.purge();
    expect(await rowsOf(proposalId)).toMatchObject({
      rowsCipher: null,
      proposalOutcome: "EXPIRED",
    });

    // Decided longer ago than the record is kept. Moved on the row rather
    // than by purging at a later clock, which would reach every proposal in
    // the database.
    await prisma.importSession.update({
      where: { id: proposalId },
      data: {
        decidedAt: new Date(Date.now() - PROPOSAL_RECORD_RETENTION_MS - 60_000),
      },
    });
    await proposals.purge();
    expect(await rowsOf(proposalId)).toBeNull();
    await expect(host.imports.status(proposalId)).resolves.toEqual({
      state: "unknown",
      decidedAt: null,
    });
  });

  it("marks an expired one that was not purged yet when the plugin proposes again", async () => {
    const host = hostFor(nextPluginId());
    const { proposalId } = await host.imports.propose({
      fileName: "a.csv",
      content: memberList("Jonna"),
    });
    await prisma.importSession.update({
      where: { id: proposalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // The same rows are not "unchanged": the waiting one has run out.
    const next = await host.imports.propose({
      fileName: "b.csv",
      content: memberList("Jonna"),
    });

    expect(next.proposalId).not.toBe(proposalId);
    expect(await rowsOf(proposalId)).toMatchObject({
      rowsCipher: null,
      proposalOutcome: "EXPIRED",
    });
    await expect(host.imports.status(proposalId)).resolves.toMatchObject({
      state: "expired",
    });
    await expect(host.imports.status(next.proposalId)).resolves.toMatchObject({
      state: "pending",
    });
  });

  it("leaves a waiting proposal alone, however old its arrival", async () => {
    const host = hostFor(nextPluginId());
    const { proposalId } = await host.imports.propose({
      fileName: "a.csv",
      content: memberList("Ivar"),
    });

    await proposals.purge();

    await expect(host.imports.status(proposalId)).resolves.toMatchObject({
      state: "pending",
    });
    expect((await rowsOf(proposalId))?.rowsCipher).not.toBeNull();
  });
});
