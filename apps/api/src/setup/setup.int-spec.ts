import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

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
 * The suite deliberately does not exercise the *open* path. Doing so would mean
 * emptying auth_user on a database that may hold a real register - and, for the
 * duration, standing up an instance with an open admin-creation form. The
 * refusal direction is the one a mistake would make dangerous.
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

function inject(options: {
  method: "GET" | "POST" | "PUT";
  url: string;
  payload?: object;
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
