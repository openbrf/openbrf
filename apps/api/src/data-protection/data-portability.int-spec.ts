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
import { I18nService } from "../i18n/i18n.service";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import {
  BUSY_RETRY_AFTER_SECONDS,
  MAX_CONCURRENT_EXPORTS,
} from "../retention/export-slots";
import { holdReports } from "../testing/held-reports";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runSuffix,
} from "../testing/integration-env";
import { SCOPE_NOTE_KEY, type DataPortabilityExport } from "./data-portability";
import { EXPORTS_PER_PERSON_PER_MINUTE } from "./data-portability-rate-limit";
import { PORTABLE_SECTIONS } from "./section-processing";

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

/** Spends a whole budget in the test of the limit, and is used for nothing else. */
const hammerer = {
  personId: `dpo-hammerer-${suffix}`,
  email: `dpo-hammerer-${suffix}@exempel.se`,
};

/** Asks while every slot is taken, in the test of the slots only. */
const waiter = {
  personId: `dpo-waiter-${suffix}`,
  email: `dpo-waiter-${suffix}@exempel.se`,
};

/** Asks for a second export while the first is still being prepared. */
const impatient = {
  personId: `dpo-impatient-${suffix}`,
  email: `dpo-impatient-${suffix}@exempel.se`,
};

/** Exports while the impatient person's first export is being prepared. */
const bystander = {
  personId: `dpo-bystander-${suffix}`,
  email: `dpo-bystander-${suffix}@exempel.se`,
};

const actors = [resident, neighbour, hammerer, waiter, impatient, bystander];
const personIds = actors.map((actor) => actor.personId);

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.62.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.62.${String(subnet)}.${String(host + 1)}`;
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
let hammererCookie: string;
let waiterCookie: string;
let impatientCookie: string;
let bystanderCookie: string;

/**
 * The resident's export, asked for once however many tests read it.
 *
 * Every ask spends from a per-person budget, so a suite that asked once per
 * assertion would meet the limit it is not testing. The file is the same each
 * time, and what each test checks about it is separate.
 */
let residentExport: ReturnType<typeof inject> | undefined;
function exportAsResident() {
  residentExport ??= inject({
    method: "POST",
    url: "/api/data-portability/mine",
    headers: { cookie: residentCookie },
  });
  return residentExport;
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

  await prisma.person.createMany({
    data: [
      { id: hammerer.personId, firstName: "Hampus" },
      { id: impatient.personId, firstName: "Ingrid" },
      { id: bystander.personId, firstName: "Bertil" },
    ].map((person) => ({ ...person, lastName: `Portabel${suffix}` })),
  });
  await prisma.person.create({
    data: {
      id: waiter.personId,
      firstName: "Vera",
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
  for (const actor of actors) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  residentCookie = await signIn(resident.email);
  neighbourCookie = await signIn(neighbour.email);
  hammererCookie = await signIn(hammerer.email);
  waiterCookie = await signIn(waiter.email);
  impatientCookie = await signIn(impatient.email);
  bystanderCookie = await signIn(bystander.email);
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
    const own = await exportAsResident();
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
    const response = await exportAsResident();

    expect(response.body).not.toContain(runIdentityNumber(suffix));
    expect(response.body).not.toContain("personalIdentityNumber");
  });

  it("says in the file itself why it is a file rather than a transfer", async () => {
    const response = await exportAsResident();

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

  it("carries only what rests on a consent or a contract", async () => {
    /*
     * The sections the map marks carried, and nothing else: what rests on the
     * association's legitimate interest or on a legal obligation stays on the
     * access report. Asserted on what the route sends, so a section added to
     * the projection past its type fails here too.
     */
    const response = await exportAsResident();

    expect(
      Object.keys(response.json<Record<string, unknown>>()).filter(
        (key) => key !== "about",
      ),
    ).toEqual([...PORTABLE_SECTIONS]);
  });

  it("says in the file where everything else is", async () => {
    // In the person's own language, like the sentence about transmission: the
    // file outlives the screen, and names the access report as the rest.
    const response = await exportAsResident();

    const exported = response.json<DataPortabilityExport>();
    expect(exported.about.scope).toBe(
      app.get(I18nService).translatorFor(exported.person.preferredLocale)(
        SCOPE_NOTE_KEY,
      ),
    );
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
    // And how much the file disclosed, named the way the access report names
    // its own sections: field names, never what they held.
    expect(
      (entry?.context as { sections?: string[] } | null)?.sections,
    ).toEqual([...PORTABLE_SECTIONS]);
  });
});

describe("asking for an export too often", () => {
  const exportAsHammerer = () =>
    inject({
      method: "POST",
      url: "/api/data-portability/mine",
      headers: { cookie: hammererCookie },
    });

  it("refuses with a 429 once the person's budget is spent, and says when to retry", async () => {
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect((await exportAsHammerer()).statusCode).toBe(200);
    }

    const refused = await exportAsHammerer();

    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ reason: string }>().reason).toBe(
      "export-rate-limited",
    );
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    // Nothing of the file went out with the refusal.
    expect(refused.body).not.toContain("preferredLocale");
  });

  it("leaves every other person's budget alone", async () => {
    // The hammerer has spent theirs by now, whichever order the file runs in.
    for (let ask = 0; ask <= EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      await exportAsHammerer();
    }

    const neighbours = await inject({
      method: "POST",
      url: "/api/data-portability/mine",
      headers: { cookie: neighbourCookie },
    });

    expect(neighbours.statusCode).toBe(200);
  });

  it("writes no audit entry for a refused request", async () => {
    // Spends the budget itself, so it holds when run alone with `-t`.
    for (let ask = 0; ask <= EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      await exportAsHammerer();
    }
    const entriesBefore = await prisma.auditLogEntry.count({
      where: {
        action: "DATA_PORTABILITY_EXPORTED",
        targetPersonId: hammerer.personId,
      },
    });
    expect((await exportAsHammerer()).statusCode).toBe(429);

    expect(
      await prisma.auditLogEntry.count({
        where: {
          action: "DATA_PORTABILITY_EXPORTED",
          targetPersonId: hammerer.personId,
        },
      }),
    ).toBe(entriesBefore);
  });
});

/**
 * An export asked for while every slot the report is gathered in is taken.
 *
 * The slots are shared with the board's access report, so here the board's
 * reports are what hold them, produced through the service the board's route
 * calls. Each is held at the door of its transaction, so the slots are full
 * while no connection is.
 */
describe("asking for an export while every slot is taken", () => {
  const exportAsWaiter = () =>
    inject({
      method: "POST",
      url: "/api/data-portability/mine",
      headers: { cookie: waiterCookie },
    });

  it("refuses with a 429 and a Retry-After, writes no entry, and charges the person nothing", async () => {
    const hold = holdReports(app);
    try {
      const reports = app.get(DataSubjectReportService);
      const running = Array.from({ length: MAX_CONCURRENT_EXPORTS }, () =>
        reports.generate({
          personId: neighbour.personId,
          actorPersonId: resident.personId,
        }),
      );
      await hold.held(MAX_CONCURRENT_EXPORTS);

      // More often than the person's own budget, every one refused as busy.
      for (let ask = 0; ask <= EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
        const refused = await exportAsWaiter();
        expect(refused.statusCode).toBe(429);
        expect(refused.json<{ reason: string }>().reason).toBe("export-busy");
        expect(refused.headers["retry-after"]).toBe(
          String(BUSY_RETRY_AFTER_SECONDS),
        );
      }
      expect(
        await prisma.auditLogEntry.count({
          where: {
            action: "DATA_PORTABILITY_EXPORTED",
            targetPersonId: waiter.personId,
          },
        }),
      ).toBe(0);

      hold.release();
      await Promise.all(running);
    } finally {
      hold.restore();
    }

    // In the same minute, the person still has the whole of their own budget.
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect((await exportAsWaiter()).statusCode).toBe(200);
    }
  });
});

/*
 * Shares the instance's budget of EXPORTS_PER_MINUTE_OVERALL exports a minute
 * with the rest of this file, which has spent all twelve by the time it ends
 * (this test spends the last three): a test added here, or above, will tip the
 * instance into a 429 that has nothing to do with what it checks. Refusals
 * for a busy instance or an export in progress spend nothing.
 */
describe("asking for a second export while the first is being prepared", () => {
  const exportWith = (cookie: string) =>
    inject({
      method: "POST",
      url: "/api/data-portability/mine",
      headers: { cookie },
    });

  it("refuses the second as busy, and lets another person's export through meanwhile", async () => {
    /*
     * The first export is held open in the gathering, through the route and the
     * limiter it goes through, until the test lets it finish. Otherwise a
     * database quick enough to finish it before the second request arrived
     * would let both through, and the test would depend on timing.
     */
    const reports = app.get(DataSubjectReportService);
    const gather = reports.portable.bind(reports);
    let gathering!: () => void;
    const started = new Promise<void>((resolve) => {
      gathering = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const held = vi
      .spyOn(reports, "portable")
      .mockImplementationOnce(async (personId) => {
        gathering();
        await finished;
        return gather(personId);
      });

    try {
      // A request is sent once something waits on it.
      const first = Promise.resolve(exportWith(impatientCookie));
      // A first request that is refused never reaches the gathering, so
      // `started` would never settle; the refusal is what to report then.
      const early = await Promise.race([started.then(() => null), first]);
      if (early) {
        throw new Error(
          `the first export was answered ${early.statusCode} before it was held open`,
        );
      }

      const second = await exportWith(impatientCookie);
      expect(second.statusCode).toBe(429);
      expect(second.json<{ reason: string }>().reason).toBe("export-busy");
      expect(Number(second.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(second.body).not.toContain("preferredLocale");

      const bystanders = await exportWith(bystanderCookie);
      expect(bystanders.statusCode).toBe(200);
      expect(bystanders.json<DataPortabilityExport>().person.personId).toBe(
        bystander.personId,
      );

      finish();
      const firstResponse = await first;
      expect(firstResponse.statusCode).toBe(200);
      expect(firstResponse.json<DataPortabilityExport>().person.personId).toBe(
        impatient.personId,
      );
    } finally {
      finish();
      held.mockRestore();
    }

    // Once the first is done the person may ask again.
    expect((await exportWith(impatientCookie)).statusCode).toBe(200);
  });
});
