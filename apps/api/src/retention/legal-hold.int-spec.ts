import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { LegalHoldView } from "./legal-hold.service";

/**
 * Legal hold over HTTP, per principal, against a real database.
 *
 * A hold is the one lawful way to suspend the association's own retention
 * promise, so the two questions worth a real database are who may place one and
 * what is left behind when it is lifted. Both are answered here: the capability
 * gate is exercised as three different people, and the released hold is read
 * back off the row rather than inferred from the absence of one.
 *
 * The purge suite proves the other half - that a standing hold actually stops
 * the erasure - because that needs a driven clock.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `hold-address-${suffix}`;
const apartmentId = `hold-apartment-${suffix}`;

const board = {
  personId: `hold-board-${suffix}`,
  email: `hold-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `hold-resident-${suffix}`,
  email: `hold-resident-${suffix}@exempel.se`,
};
/** The person the holds are placed on. */
const subject = { personId: `hold-subject-${suffix}` };

const actors = [board, resident];
const personIds = [board.personId, resident.personId, subject.personId];

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.21.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.21.${String(subnet)}.${String(host + 1)}`;
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

let boardCookie: string;
let residentCookie: string;

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

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Hallgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });

  await prisma.person.createMany({
    data: [
      { id: board.personId, firstName: "Bo", lastName: `Hall${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Hall${suffix}` },
      { id: subject.personId, firstName: "Siv", lastName: `Hall${suffix}` },
    ],
  });

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: resident.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: subject.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2020-01-01"),
        movedOutOn: new Date("2026-01-31"),
      },
    ],
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

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
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
      "The legal hold suite could not clean up after itself.",
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
          prisma.legalHold.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.boardPosition.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
        () => prisma.apartment.deleteMany({ where: { id: apartmentId } }),
        () => prisma.address.deleteMany({ where: { id: addressId } }),
      ]);
      // Audit entries stay: the table is append-only, and only the audit
      // suite's own teardown disables the trigger that makes it so.
    }
  } finally {
    await app?.close();
  }
});

describe("who may place a legal hold", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${subject.personId}`,
      payload: { reason: "Tvist" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident, who may not write the register", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${subject.personId}`,
      payload: { reason: "Tvist" },
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses a hold with no reason", async () => {
    // An exception to the association's own retention promise has to be
    // reviewable, and one with no reason is indistinguishable from data
    // nobody got round to erasing.
    const response = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${subject.personId}`,
      payload: { reason: "   " },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ reason: "invalid-body" });
  });

  it("answers 404 for somebody the register does not hold", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/nobody-${suffix}`,
      payload: { reason: "Tvist" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ reason: "person-not-found" });
  });
});

describe("placing and releasing", () => {
  it("places a hold and records the act naming the hold, not its reason", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${subject.personId}`,
      payload: { reason: "Tvist om andrahandsuthyrning" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    const hold = response.json() as LegalHoldView;
    expect(hold.reason).toBe("Tvist om andrahandsuthyrning");
    expect(hold.releasedAt).toBeNull();
    expect(hold.placedByPersonId).toBe(board.personId);

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "LEGAL_HOLD_PLACED",
        targetPersonId: subject.personId,
      },
      orderBy: [{ createdAt: "desc" }],
    });
    expect(entry.actorPersonId).toBe(board.personId);
    expect(entry.targetKind).toBe("legalHold");
    expect(entry.targetId).toBe(hold.holdId);
    // The reason is on the hold row this entry names. Copying it here would
    // keep the board's words about a person after the row was corrected or
    // erased, in a table that cannot be corrected.
    expect(JSON.stringify(entry.context)).not.toContain("andrahandsuthyrning");
  });

  it("shows the standing hold on the person the board reads", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/address-book/persons/${subject.personId}`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const person = response.json() as {
      legalHold: LegalHoldView | null;
      residencies: { purgeOn: string | null }[];
    };
    // Beside the purge date, which is what makes the panel honest: the date is
    // what the policy promises and the hold is why it is not going to happen.
    expect(person.legalHold?.reason).toBe("Tvist om andrahandsuthyrning");
    // An ISO date on the one residency, not merely something that is not null:
    // `?.` answers undefined for an empty list or a dropped field, and
    // not.toBeNull() accepts undefined, so the assertion could not fail for the
    // regression it is here to catch.
    expect(person.residencies).toHaveLength(1);
    expect(person.residencies[0]?.purgeOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses a second hold while the first stands", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${subject.personId}`,
      payload: { reason: "Ett annat skal" },
      headers: { cookie: boardCookie },
    });

    // Two open holds would make "released" ambiguous, and the board's question
    // is whether the person is held rather than how many reasons there are.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "already-held" });
  });

  it("releases the hold with a date, keeping the row", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${subject.personId}/release`,
      payload: { reason: "Tvisten avgjord" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const hold = response.json() as LegalHoldView;
    expect(hold.releasedAt).not.toBeNull();
    expect(hold.releaseReason).toBe("Tvisten avgjord");
    expect(hold.releasedByPersonId).toBe(board.personId);

    // That a hold stood between two dates is the whole explanation for why the
    // purge did not run in that period. Deleting it would leave the gap
    // unexplained.
    const rows = await prisma.legalHold.findMany({
      where: { personId: subject.personId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("Tvist om andrahandsuthyrning");

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "LEGAL_HOLD_RELEASED",
        targetPersonId: subject.personId,
      },
      orderBy: [{ createdAt: "desc" }],
    });
    expect(entry.targetId).toBe(hold.holdId);
  });

  it("refuses a release when nothing is held", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${subject.personId}/release`,
      payload: {},
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "not-held" });
  });

  it("allows a new hold once the first was released, and keeps both on file", async () => {
    const placed = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${subject.personId}`,
      payload: { reason: "Nytt forsakringsarende" },
      headers: { cookie: boardCookie },
    });
    expect(placed.statusCode).toBe(201);

    const history = await inject({
      method: "GET",
      url: `/api/legal-holds/persons/${subject.personId}`,
      headers: { cookie: boardCookie },
    });
    expect(history.statusCode).toBe(200);
    const holds = history.json() as LegalHoldView[];
    expect(holds).toHaveLength(2);
    // Newest first, and the released one still carries its dates.
    expect(holds[0]?.releasedAt).toBeNull();
    expect(holds[1]?.releasedAt).not.toBeNull();
  });
});
