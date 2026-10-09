import { Logger } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { hashOpaqueToken } from "../auth/opaque-token";
import { PrismaService } from "../database/prisma.service";
import {
  BASE_URL_VARIABLE,
  maintenanceUrl,
  quoteIdentifier,
  templateDatabaseName,
  withDatabase,
  workerDatabaseName,
} from "../testing/integration-database";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { SetupClaimService } from "./setup-claim.service";

/**
 * First-boot setup, against a real database and the real HTTP stack.
 *
 * The property under test is the one that protects a live instance: the public
 * "create an administrator" route must be shut once the instance is claimed. The
 * unit tests cover the decision itself with fakes; only this suite proves that
 * the decision is actually reached through the guard, the routing and the
 * exception filter, and that `@Public()` on the setup controller does not leak
 * to the completion controller that shares its path prefix.
 *
 * The suite establishes the claimed state itself rather than relying on a seeded
 * database, because CI runs migrations without the seed: there, auth_user is
 * empty and the association row does not exist, so an ambient-state suite would
 * find setup legitimately open and fail on every assertion. It records what it
 * changed and puts it back afterwards, and beforeAll GATES on the claim having
 * taken: on an open instance the administrator POST below would succeed, so
 * that request must be unreachable rather than merely expected to fail.
 *
 * The *open* path - claiming an unclaimed instance with the setup link (ADR
 * 0023) - runs only against databases this suite clones from the migrated
 * template for the purpose and drops afterwards. A worker's own database is
 * shared with the suites before this one, whose accounts make it claimed, and
 * emptying auth_user to open it again is not something a test should do to any
 * database.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

/**
 * What `setupCompletedAt` held before this suite claimed the instance, so
 * afterAll can put it back. `undefined` means the association row did not exist
 * at all and this suite created it - the state CI starts from.
 */
let previousSetupCompletedAt: Date | null | undefined;

/**
 * A distinct forwarded address per request, inside this suite's own block.
 *
 * Distinct because the sign-in rate limiter buckets by forwarded address, and a
 * repeat would make one test's requests count against another's budget. The
 * counter walks the third octet as well as the fourth rather than wrapping
 * inside one of them, so the sequence does not come back round onto itself
 * however many requests the suite grows to make. 10.4.0.0/16 is this suite's:
 * the other integration suites each hold their own second octet.
 */
let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return `10.4.${String(subnet)}.${String(host + 1)}`;
}

function inject(
  options: {
    method: "GET" | "POST" | "PUT";
    url: string;
    payload?: object;
    headers?: Record<string, string>;
  },
  target: NestFastifyApplication = app,
) {
  return target
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

  /*
   * Claim the instance. `setupCompletedAt` is the half of the rule that can be
   * set without creating an account, and upserting the singleton is the same
   * pattern the other integration suites use to get an association row.
   */
  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { setupCompletedAt: true },
  });
  previousSetupCompletedAt =
    existing === null ? undefined : existing.setupCompletedAt;

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet", setupCompletedAt: new Date() },
    update: { setupCompletedAt: new Date() },
  });

  /*
   * A gate, not an assertion. Every expectation below is a refusal, and a
   * refusal proves nothing on an instance that is legitimately open - the suite
   * would report success while testing the opposite state. Worse, one of those
   * cases POSTs to the public administrator route, which on an unclaimed
   * instance SUCCEEDS: it would claim this shared database under a name and a
   * password that are both in a public repository, and leave the rows behind.
   *
   * Thrown here rather than checked in an `it()`, because a failing test does
   * not stop the ones after it in Vitest, so an assertion cannot keep that POST
   * from running. A throw in beforeAll does: the suite reports one cause
   * instead of a pile of consequences, and the destructive request is never
   * reached.
   */
  const [accounts, claimed] = await Promise.all([
    prisma.user.count(),
    prisma.association.findUnique({
      where: { id: 1 },
      select: { setupCompletedAt: true },
    }),
  ]);
  if (!(accounts > 0 || claimed?.setupCompletedAt != null)) {
    throw new Error(
      "the setup suite could not claim the instance, so its refusals would " +
        "prove nothing and its administrator POST would succeed",
    );
  }
});

afterAll(async () => {
  if (prisma !== undefined) {
    if (previousSetupCompletedAt === undefined) {
      // This suite created the row, so removing it is the restore.
      await prisma.association.deleteMany({ where: { id: 1 } });
    } else {
      await prisma.association.update({
        where: { id: 1 },
        data: { setupCompletedAt: previousSetupCompletedAt },
      });
    }
  }
  await app?.close();
});

describe("first-boot setup on a claimed instance", () => {
  // The claimed state is a precondition of this whole describe and is enforced
  // by the gate in beforeAll, so there is no case for it here: a test that
  // failed would not stop the ones below from running against an open instance.

  it("reports that setup is not required", async () => {
    const response = await inject({ method: "GET", url: "/api/setup/state" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ setupRequired: false });
  });

  it("tells an anonymous caller nothing except that one fact", async () => {
    const response = await inject({ method: "GET", url: "/api/setup/state" });

    /*
     * An exact-key assertion, not a property check. This endpoint is reachable
     * without a session, so any field added to its payload later - the
     * cooperative's name, an address count, whether SMTP is configured - would
     * be published to the internet. Adding one has to break this test.
     */
    expect(Object.keys(response.json() as object)).toEqual(["setupRequired"]);
  });

  it("refuses to create another administrator", async () => {
    const before = await prisma.user.count();

    const response = await inject({
      method: "POST",
      url: "/api/setup/administrator",
      payload: {
        firstName: "Ovalkommen",
        lastName: "Besokare",
        email: `intruder-${process.hrtime.bigint().toString(36)}@exempel.se`,
        password: "a-long-enough-password",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(await prisma.user.count()).toBe(before);
  });

  it("does not let the public setup routes open the completion route", async () => {
    /*
     * `SetupController` carries @Public() and `SetupCompletionController` carries
     * @RequireCapability, on the same "api/setup" prefix. They are separate
     * classes precisely so neither decorator can be applied to the other's
     * routes by accident; this is the assertion that the separation holds.
     */
    const response = await inject({
      method: "POST",
      url: "/api/setup/complete",
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("settings without a session", () => {
  it.each([
    { method: "GET" as const, url: "/api/settings" },
    { method: "PUT" as const, url: "/api/settings/housing-cooperative" },
    { method: "PUT" as const, url: "/api/settings/branding" },
    { method: "PUT" as const, url: "/api/settings/smtp" },
    { method: "POST" as const, url: "/api/settings/smtp/test" },
    { method: "PUT" as const, url: "/api/settings/retention" },
    { method: "PUT" as const, url: "/api/settings/self-signup" },
    { method: "POST" as const, url: "/api/addresses" },
  ])("refuses $method $url", async ({ method, url }) => {
    const response = await inject({ method, url, payload: {} });

    // 401 rather than 400: authorization is decided before the body is read, so
    // a malformed payload can never be the reason an anonymous caller is told
    // about a route.
    expect(response.statusCode).toBe(401);
  });
});

/**
 * An unclaimed instance of its own, on a database cloned from the migrated
 * template: no account, no association, nothing any other suite wrote.
 *
 * The application is built with `digest` as OPENBRF_SETUP_TOKEN_DIGEST, or
 * with none. ConfigModule reads process.env while the module compiles, so the
 * two variables are set for that moment and put back straight after.
 */
async function unclaimedInstance(
  label: string,
  digest: string | null,
): Promise<{
  app: NestFastifyApplication;
  prisma: PrismaService;
  close: () => Promise<void>;
}> {
  const baseUrl = process.env[BASE_URL_VARIABLE];
  if (baseUrl === undefined) {
    throw new Error(
      `${BASE_URL_VARIABLE} is not set: the worker's setup file did not run`,
    );
  }
  const poolId = Number(process.env.VITEST_POOL_ID ?? "1");
  const database = `${workerDatabaseName(baseUrl, poolId)}_claim_${label}`;

  const maintenance = new Client({ connectionString: maintenanceUrl(baseUrl) });
  await maintenance.connect();
  try {
    await maintenance.query(
      `drop database if exists ${quoteIdentifier(database)} with (force)`,
    );
    await maintenance.query(
      `create database ${quoteIdentifier(database)} template ${quoteIdentifier(
        templateDatabaseName(baseUrl),
      )}`,
    );
  } finally {
    await maintenance.end();
  }

  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_RUNTIME: process.env.DATABASE_URL_RUNTIME,
    OPENBRF_SETUP_TOKEN_DIGEST: process.env.OPENBRF_SETUP_TOKEN_DIGEST,
  };
  process.env.DATABASE_URL = withDatabase(baseUrl, database);
  if (
    saved.DATABASE_URL_RUNTIME !== undefined &&
    saved.DATABASE_URL_RUNTIME !== ""
  ) {
    process.env.DATABASE_URL_RUNTIME = withDatabase(
      saved.DATABASE_URL_RUNTIME,
      database,
    );
  }
  // Empty rather than deleted when there is none: the environment file is
  // loaded again while the module compiles and fills in only what is unset,
  // and the schema reads an empty value as absent.
  process.env.OPENBRF_SETUP_TOKEN_DIGEST = digest ?? "";

  let built: NestFastifyApplication;
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    built = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await built.init();
    await built.getHttpAdapter().getInstance().ready();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }

  return {
    app: built,
    prisma: built.get(PrismaService),
    close: async () => {
      await built.close();
      const dropping = new Client({
        connectionString: maintenanceUrl(baseUrl),
      });
      await dropping.connect();
      try {
        await dropping.query(
          `drop database if exists ${quoteIdentifier(database)} with (force)`,
        );
      } finally {
        await dropping.end();
      }
    },
  };
}

/** A first administrator, with whatever token the case presents. */
function administrator(claimToken?: string): Record<string, string> {
  return {
    firstName: "Ingrid",
    lastName: "Forsberg",
    email: `ingrid-${process.hrtime.bigint().toString(36)}@exempel.se`,
    password: "a-long-enough-password",
    ...(claimToken === undefined ? {} : { claimToken }),
  };
}

/** The grant the claim logged, read back from the audit log. */
async function grantEntryContext(prisma: PrismaService): Promise<unknown> {
  const entries = await prisma.auditLogEntry.findMany({
    where: { action: "SYSTEM_ROLE_GRANTED" },
    select: { context: true },
  });
  expect(entries).toHaveLength(1);
  return entries[0]?.context;
}

describe("claiming an instance whose host set the link's digest", () => {
  /** The token the host handed the board; the instance holds its digest. */
  const TOKEN = "host-minted-setup-token-for-this-suite-0001";

  let instance: Awaited<ReturnType<typeof unclaimedInstance>>;

  beforeAll(async () => {
    instance = await unclaimedInstance("environment", hashOpaqueToken(TOKEN));
    expect(
      (
        await inject({ method: "GET", url: "/api/setup/state" }, instance.app)
      ).json(),
    ).toEqual({ setupRequired: true });
  });

  afterAll(async () => {
    await instance?.close();
  });

  it.each([
    ["no token", undefined],
    ["a wrong token", `${TOKEN}-guessed`],
    ["the digest itself", hashOpaqueToken(TOKEN)],
  ])("refuses %s with 403 claim-token-invalid", async (_what, claimToken) => {
    const response = await inject(
      {
        method: "POST",
        url: "/api/setup/administrator",
        payload: administrator(claimToken),
      },
      instance.app,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "claim-token-invalid" });
    // Nothing was written: no person, no account and no audit entry, since
    // nobody and no association exists to write a refusal against.
    expect(await instance.prisma.user.count()).toBe(0);
    expect(await instance.prisma.person.count()).toBe(0);
    expect(await instance.prisma.auditLogEntry.count()).toBe(0);
  });

  it("creates the first administrator for the token, and then closes", async () => {
    const response = await inject(
      {
        method: "POST",
        url: "/api/setup/administrator",
        payload: administrator(TOKEN),
      },
      instance.app,
    );

    expect(response.statusCode).toBe(201);
    expect(await instance.prisma.user.count()).toBe(1);
    expect(await grantEntryContext(instance.prisma)).toEqual({
      role: "ADMIN",
      grantedBy: "setup-wizard",
      claimedWith: "environment",
    });

    // Claimed: the same link opens nothing more.
    const again = await inject(
      {
        method: "POST",
        url: "/api/setup/administrator",
        payload: administrator(TOKEN),
      },
      instance.app,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: "already-claimed" });
  });
});

describe("two first-administrator submissions at the same instant", () => {
  const TOKEN = "host-minted-setup-token-for-this-suite-0002";

  let instance: Awaited<ReturnType<typeof unclaimedInstance>>;

  beforeAll(async () => {
    instance = await unclaimedInstance("concurrent", hashOpaqueToken(TOKEN));
  });

  afterAll(async () => {
    await instance?.close();
  });

  it("lets exactly one of them create an administrator", async () => {
    // Both pass the claimed check before either has written anything, and the
    // account of the first is only created after its transaction, so only the
    // grant it committed can turn the second away.
    const responses = await Promise.all(
      [0, 1, 2].map(() =>
        inject(
          {
            method: "POST",
            url: "/api/setup/administrator",
            payload: administrator(TOKEN),
          },
          instance.app,
        ),
      ),
    );

    expect(responses.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([
      201, 409, 409,
    ]);
    expect(
      await instance.prisma.systemRole.count({ where: { role: "ADMIN" } }),
    ).toBe(1);
    expect(await instance.prisma.person.count()).toBe(1);
    expect(await instance.prisma.user.count()).toBe(1);
  });
});

describe("claiming an instance that printed its own link", () => {
  let instance: Awaited<ReturnType<typeof unclaimedInstance>>;
  let link: URL;

  beforeAll(async () => {
    instance = await unclaimedInstance("log", null);

    // What main.ts does once the server listens, read back from the log the
    // way an operator reads it.
    const logged = vi.spyOn(Logger.prototype, "log");
    try {
      await instance.app.get(SetupClaimService).announce();
      const line = logged.mock.calls
        .map((call) => String(call[0]))
        .find((message) => message.includes("#claim="));
      const printed = line?.match(/(\S+\/app\/setup#claim=\S+) /)?.[1];
      if (printed === undefined) {
        throw new Error("the unclaimed instance printed no setup link");
      }
      link = new URL(printed);
    } finally {
      logged.mockRestore();
    }
  });

  afterAll(async () => {
    await instance?.close();
  });

  it("prints a link on the instance's own address", () => {
    const env = loadEnvForIntegrationTests();
    expect(link.origin).toBe(new URL(env.APP_URL).origin);
    expect(link.pathname).toBe("/app/setup");
  });

  it("refuses a token it did not print", async () => {
    const response = await inject(
      {
        method: "POST",
        url: "/api/setup/administrator",
        payload: administrator("not-the-printed-token"),
      },
      instance.app,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "claim-token-invalid" });
    expect(await instance.prisma.user.count()).toBe(0);
  });

  it("creates the first administrator for the printed token", async () => {
    const token = new URLSearchParams(link.hash.slice(1)).get("claim") ?? "";

    const response = await inject(
      {
        method: "POST",
        url: "/api/setup/administrator",
        payload: administrator(token),
      },
      instance.app,
    );

    expect(response.statusCode).toBe(201);
    expect(await instance.prisma.user.count()).toBe(1);
    expect(await grantEntryContext(instance.prisma)).toEqual({
      role: "ADMIN",
      grantedBy: "setup-wizard",
      claimedWith: "log",
    });
    // Spent: the token is worth nothing now even to a caller that could get
    // past the claimed check.
    expect(instance.app.get(SetupClaimService).matches(token)).toBe(false);
  });
});
