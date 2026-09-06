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
import { I18nService } from "../i18n/i18n.service";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runSuffix,
} from "../testing/integration-env";
import type { DataPortabilityExport } from "./data-portability";

/**
 * A person taking their own data with them (GDPR art. 20), over HTTP.
 *
 * Two things need a real database here. The route reads the person from the
 * session and from nowhere else, so what proves it is one account asking and
 * getting its own file rather than a fixture saying so. And the personal
 * identity number is on the register row for real, encrypted, so its absence
 * from the export is the projection's doing rather than the fixture's.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `dpo-address-${suffix}`;
const apartmentId = `dpo-apartment-${suffix}`;

const resident = {
  personId: `dpo-resident-${suffix}`,
  email: `dpo-resident-${suffix}@exempel.se`,
};
const neighbour = {
  personId: `dpo-neighbour-${suffix}`,
  email: `dpo-neighbour-${suffix}@exempel.se`,
};

const personIds = [resident.personId, neighbour.personId];

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.43.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.43.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
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

let residentCookie: string;
let neighbourCookie: string;

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
  const encryption = app.get(FieldEncryptionService);

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Portabilitetsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });

  const identity = await encryption.encrypt(
    "person.personalIdentityNumber",
    runIdentityNumber(suffix),
  );
  const email = await encryption.encrypt(
    "person.email",
    `dpo-register-${suffix}@exempel.se`,
  );

  await prisma.person.create({
    data: {
      id: resident.personId,
      firstName: "Astrid",
      lastName: `Portabel${suffix}`,
      postalStreet: "Storgatan 1",
      postalCode: "11122",
      postalCity: "Stockholm",
      emailCipher: email.cipher,
      emailIndex: email.index,
      // On the register for real, so its absence from the export is the
      // projection's doing rather than the fixture's.
      personalIdentityNumberCipher: identity.cipher,
      personalIdentityNumberIndex: identity.index,
    },
  });
  await prisma.person.create({
    data: {
      id: neighbour.personId,
      firstName: "Nils",
      lastName: `Portabel${suffix}`,
    },
  });

  await prisma.residency.createMany({
    data: personIds.map((personId) => ({
      personId,
      apartmentId,
      role: "MEMBER" as const,
      movedInOn: new Date("2020-01-01"),
    })),
  });

  const auth = app.get(AuthService);
  for (const actor of [resident, neighbour]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  residentCookie = await signIn(resident.email);
  neighbourCookie = await signIn(neighbour.email);
}, 180_000);

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
      "The data portability suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
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
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
        () => prisma.apartment.deleteMany({ where: { id: apartmentId } }),
        () => prisma.address.deleteMany({ where: { id: addressId } }),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("exporting your own data", () => {
  it("refuses without a session", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/data-portability/mine",
    });

    expect(response.statusCode).toBe(401);
  });

  it("answers the person who is signed in, and nobody else", async () => {
    /*
     * The route takes no path parameter, deliberately: one that did would be a
     * route where a missing check hands one resident another's file, and the
     * safest version of that check is not having the parameter.
     */
    const own = await inject({
      method: "POST",
      url: "/api/data-portability/mine",
      headers: { cookie: residentCookie },
    });
    const theirs = await inject({
      method: "POST",
      url: "/api/data-portability/mine",
      headers: { cookie: neighbourCookie },
    });

    expect(own.statusCode).toBe(200);
    expect(own.json<DataPortabilityExport>().person.personId).toBe(
      resident.personId,
    );
    expect(theirs.json<DataPortabilityExport>().person.personId).toBe(
      neighbour.personId,
    );
  });

  it("carries no personal identity number, although the person gave it", async () => {
    // Confidential apartment register content under BRL 9 kap., held on a legal
    // obligation rather than on consent or contract. It leaves the register
    // only through the audited reveal, never into a file a browser downloads.
    const response = await inject({
      method: "POST",
      url: "/api/data-portability/mine",
      headers: { cookie: residentCookie },
    });

    expect(response.body).not.toContain(runIdentityNumber(suffix));
    expect(response.body).not.toContain("personalIdentityNumber");
  });

  it("says in the file itself why it is a file rather than a transfer", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/data-portability/mine",
      headers: { cookie: residentCookie },
    });

    const exported = response.json<DataPortabilityExport>();
    // The article citation is a legal identifier and reads the same in both
    // languages; the sentence beside it does not.
    expect(exported.about.right).toBe("GDPR art. 20");
    /*
     * Art. 20(2) applies where technically feasible, and Recital 68 creates no
     * obligation to build a compatible system. Asserted in the recipient's own
     * language, which is what the file is written in: the fixture person's
     * locale is the register's, and the Swedish record cites the paragraph the
     * Swedish way.
     */
    expect(exported.about.transmission).toBe(
      app.get(I18nService).translatorFor(exported.person.preferredLocale)(
        "dataProtection.portability.transmission",
      ),
    );
    expect(exported.about.transmission).toContain("art. 20");
  });

  it("writes an entry naming the person as both actor and subject", async () => {
    /*
     * Which is what distinguishes a person taking their own data from a board
     * producing the access report about them - the same distinction the two
     * audit actions draw.
     */
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "DATA_PORTABILITY_EXPORTED",
        targetPersonId: resident.personId,
      },
      orderBy: [{ createdAt: "desc" }],
    });

    expect(entry).not.toBeNull();
    expect(entry?.actorPersonId).toBe(resident.personId);
  });
});
