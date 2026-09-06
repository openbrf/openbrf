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
import type { SubletApplicationStatus } from "../generated/prisma/enums";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { SubletPurgeService } from "./sublet-purge.service";
import type { SubletIntakeView, SubletQueueView } from "./sublet.service";

/**
 * Subletting applications against a real database.
 *
 * Seven properties, none of which a unit test can show.
 *
 * The act belongs to the bostadsrattshavare. BRL 7 kap. 10 § forsta stycket
 * lets one let "sin lagenhet" in andra hand only with the board's consent, so a
 * resident who holds no tenant-ownership is refused - and so is an
 * administrator, who holds every capability in the model and no residency at
 * all. That second refusal is the one the capability model alone cannot make,
 * and it is asserted here because the whole statutory claim rests on it.
 *
 * The apartment has to be the applicant's own. A member of this association who
 * names a flat they do not hold is refused exactly as one that is not in the
 * register, so the endpoint cannot be used to enumerate the building.
 *
 * The audiences are split at the controller. A member cannot read the queue and
 * the property manager cannot reach the module at all.
 *
 * An application closes with a date and a status and is never deleted, closes
 * exactly once whichever way, and a member cannot take back a request the board
 * has already answered.
 *
 * The personnummer scan refuses on the way in *and on a later revision*, names
 * where the number is, and does not echo it - and it holds against the board's
 * own note as well as against the applicant's reason.
 *
 * The rent tribunal permission (7 kap. 11 §) is recordable only against a
 * refusal, and recording one changes no status: the association did not consent,
 * the tribunal permitted, and the row says both.
 *
 * And the purge, which is what makes the retention promise real: it erases
 * applications past their window, leaves an open one alone however old, leaves a
 * closed one alone while the letting it consented to is still running, and a
 * legal hold stops it for the person it stands against.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: SubletPurgeService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `su-address-${suffix}`;
const apartmentId = `su-apartment-${suffix}`;
const otherApartmentId = `su-other-apartment-${suffix}`;

const member = {
  personId: `su-member-${suffix}`,
  email: `su-member-${suffix}@exempel.se`,
};
const lodger = {
  personId: `su-lodger-${suffix}`,
  email: `su-lodger-${suffix}@exempel.se`,
};
const board = {
  personId: `su-board-${suffix}`,
  email: `su-board-${suffix}@exempel.se`,
};
const administrator = {
  personId: `su-admin-${suffix}`,
  email: `su-admin-${suffix}@exempel.se`,
};
const manager = {
  personId: `su-manager-${suffix}`,
  email: `su-manager-${suffix}@exempel.se`,
};
const actors = [member, lodger, board, administrator, manager];
const personIds = actors.map((actor) => actor.personId);

/** Every application this run created, so afterAll can clear what it shares. */
const createdApplicationIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The clock the purge is driven at, and the window it is driven with.
 *
 * Now rather than a date in the future, deliberately, for the reason
 * `bookings.int-spec.ts` gives: the purge is a query over the whole table and
 * this database is shared between suites, so a run driven from a date years
 * ahead would reach any application another suite had left standing. Anchored
 * here, the cutoff is thirty days back and every application this suite does not
 * own is far too recent to be in scope.
 */
const NOW = new Date();
const RETENTION_DAYS = 30;

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** A `@db.Date` value: midnight UTC of the day this many days from now. */
function dayColumn(daysFromNow: number): Date {
  const at = new Date(NOW.getTime() + daysFromNow * DAY_MS);
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

/** "YYYY-MM-DD" for the day this many days from now, as a request states it. */
function dayText(daysFromNow: number): string {
  return dayColumn(daysFromNow).toISOString().slice(0, 10);
}

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 100;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        /*
         * 10.43.0.0/16 is this feature's, and the lower hundred of its second
         * octet is this suite's - `key-orders.int-spec.ts` takes 10.43.100 and
         * up. The authentication endpoints are rate-limited per client address,
         * so two suites sharing one would make each other's requests spend the
         * other's budget. 10.40.0.1 to 10.40.0.4 are reserved for the screenshot
         * walk's four actors and are never taken here.
         */
        "x-forwarded-for": `10.43.${String(subnet)}.${String(host + 1)}`,
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

/** Applies as the given account, and remembers the row for the cleanup. */
async function apply(
  cookie: string,
  payload: {
    apartmentId?: string;
    periodFrom?: string;
    periodTo?: string;
    reason?: string;
  } = {},
) {
  const response = await inject({
    method: "POST",
    url: "/api/sublet-applications",
    payload: {
      apartmentId: payload.apartmentId ?? apartmentId,
      periodFrom: payload.periodFrom ?? dayText(30),
      periodTo: payload.periodTo ?? dayText(200),
      reason: payload.reason ?? "Provbo pa annan ort under ett halvar.",
    },
    headers: { cookie },
  });
  if (response.statusCode === 201) {
    createdApplicationIds.push(response.json<{ id: string }>().id);
  }
  return response;
}

/** The member's own half of the module. */
async function intake(cookie: string): Promise<SubletIntakeView> {
  const response = await inject({
    method: "GET",
    url: "/api/sublet-applications/mine",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<SubletIntakeView>();
}

/** The board's half. */
async function queue(cookie: string): Promise<SubletQueueView> {
  const response = await inject({
    method: "GET",
    url: "/api/sublet-queue",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<SubletQueueView>();
}

/**
 * How many transactions hold, or are queued behind, this person's hold key.
 *
 * `hashtext` gives a signed int4 and the advisory lock space addresses it as two
 * halves of a bigint, which is what the shifting reassembles.
 */
async function holdLockCount(
  personId: string,
  granted: boolean,
): Promise<bigint> {
  const key = `legal-hold:${personId}`;
  const [row] = await prisma.$queryRaw<{ locks: bigint }[]>`
    SELECT count(*) AS locks
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND granted = ${granted}
      AND objsubid = 1
      AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
      AND objid = (hashtext(${key})::bigint & 4294967295)::oid`;
  return row?.locks ?? 0n;
}

/** Polls until the condition holds, or gives up so a failure is a failure. */
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the purge to block or finish.");
}

/** Writes an application straight to the database, with dates of its own. */
async function seedApplication(input: {
  id: string;
  personId: string;
  closedAt: Date | null;
  periodTo: Date;
  status: SubletApplicationStatus;
}): Promise<void> {
  await prisma.subletApplication.create({
    data: {
      id: input.id,
      appliedByPersonId: input.personId,
      apartmentId,
      periodFrom: dayColumn(-400),
      periodTo: input.periodTo,
      reason: "Arbete pa annan ort.",
      status: input.status,
      closedAt: input.closedAt,
      closedByPersonId: input.closedAt === null ? null : board.personId,
    },
  });
  createdApplicationIds.push(input.id);
}

let memberCookie = "";
let lodgerCookie = "";
let boardCookie = "";
let adminCookie = "";
let managerCookie = "";
let associationCreatedHere = false;

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
  purge = app.get(SubletPurgeService);
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

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Andrahandsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1301", floor: 3 },
  });
  /*
   * A second apartment nobody in this suite lives in.
   *
   * It exists so the "sin lagenhet" refusal can be asserted against an apartment
   * that really is in the register: an identifier nobody ever wrote would be
   * refused by a service that had no check at all.
   */
  await prisma.apartment.create({
    data: { id: otherApartmentId, addressId, number: "1302", floor: 3 },
  });

  for (const person of [
    { ...member, firstName: "Maja", lastName: "Medlem" },
    { ...lodger, firstName: "Lars", lastName: "Inneboende" },
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...administrator, firstName: "Adam", lastName: "Administrator" },
    { ...manager, firstName: "Frida", lastName: "Forvaltare" },
  ]) {
    const email = await encryption.encrypt("person.email", person.email);
    await prisma.person.create({
      data: {
        id: person.personId,
        firstName: person.firstName,
        lastName: person.lastName,
        emailCipher: email.cipher,
        emailIndex: email.index,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: `${person.firstName} ${person.lastName}`,
      password: PASSWORD,
    });
  }

  /*
   * The member holds the tenant-ownership; the lodger lives in the same
   * apartment without one.
   *
   * That is the statutory distinction this suite exists to assert: BRL 7 kap.
   * 10 § gives the act to the bostadsrattshavare, so two people at the same
   * address get different answers from the same endpoint.
   */
  await prisma.residency.create({
    data: {
      personId: member.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2025-01-01"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: lodger.personId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2025-01-01"),
    },
  });

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2026-05-15"),
    },
  });
  /*
   * The administrator holds no residency, which is the point of the account.
   *
   * They hold every capability the model defines, `sublets:apply` among them,
   * and the statute still does not give them the act - so this account is what
   * proves the check in the service is doing something the capability model
   * cannot.
   */
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  memberCookie = await signIn(member.email);
  lodgerCookie = await signIn(lodger.email);
  boardCookie = await signIn(board.email);
  adminCookie = await signIn(administrator.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

/*
 * Cleanup in a try, and the close in a finally.
 *
 * Every statement below is reachable with the setup half-done: a beforeAll that
 * fails partway leaves rows this suite has to remove and rows it never wrote,
 * and one throw here would take the rest of the cleanup with it and never reach
 * app.close(). The Nest application, its Prisma pool and its Fastify server
 * would then stay open for the rest of the worker, and the suites that follow in
 * it would fail for a reason that has nothing to do with them.
 */
afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await prisma.subletApplication.deleteMany({
        where: {
          OR: [
            { id: { in: createdApplicationIds } },
            // Anything a test created and did not get to record, e.g. because an
            // assertion failed before its own cleanup line.
            { appliedByPersonId: { in: personIds } },
          ],
        },
      });
      await prisma.legalHold.deleteMany({
        where: { personId: { in: personIds } },
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
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
      await prisma.apartment.deleteMany({
        where: { id: { in: [apartmentId, otherApartmentId] } },
      });
      await prisma.address.deleteMany({ where: { id: addressId } });

      // Audit entries stay: the table is append-only by trigger, and every
      // assertion below selects on this run's target ids rather than on a count.
      if (associationCreatedHere) {
        await prisma.association.deleteMany({ where: { id: 1 } });
      }
    }
  } finally {
    // Unassigned when the module never built, which is a setup failure the
    // runner reports on its own.
    if (app !== undefined) {
      await app.close();
    }
  }
});

describe("who may ask for the board's consent", () => {
  it("takes an application from the member who holds the apartment", async () => {
    const response = await apply(memberCookie);

    expect(response.statusCode).toBe(201);

    const mine = await intake(memberCookie);
    const application = mine.applications.find(
      (row) => row.id === response.json<{ id: string }>().id,
    );
    expect(application?.status).toBe("SUBMITTED");
    expect(application?.apartment?.number).toBe("1301");
    expect(application?.periodFrom).toBe(dayText(30));
    expect(application?.periodTo).toBe(dayText(200));
  });

  it("offers the member their own apartment and no other", async () => {
    // The only list of apartments this module ever discloses. A picker over the
    // register would enumerate the building to whoever loaded the form.
    const mine = await intake(memberCookie);

    expect(mine.apartments.map((flat) => flat.id)).toEqual([apartmentId]);
  });

  it("refuses a resident of the same apartment who holds no tenant-ownership", async () => {
    /*
     * The statutory assertion of this file. BRL 7 kap. 10 § lets a
     * bostadsrattshavare let "sin lagenhet" in andra hand with the board's
     * consent; the lodger lives at the same address and holds none, so the
     * capability derived from membership never lets him reach the route.
     */
    const response = await apply(lodgerCookie);

    expect(response.statusCode).toBe(403);
  });

  it("refuses an administrator, who holds every capability and no tenant-ownership", async () => {
    /*
     * The refusal the capability model cannot make. An administrator holds
     * `sublets:apply` by definition, so the guard lets them through and the
     * service asks the register about the apartment they named - which is not
     * theirs, and is answered exactly as an apartment that does not exist.
     */
    const response = await apply(adminCookie);

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );
  });

  it("refuses a member naming an apartment that is not theirs", async () => {
    // A real apartment in the register, so this asserts the check rather than
    // the absence of a row - and the answer is the same one a missing apartment
    // gets, because a distinguishable answer would enumerate the building.
    const response = await apply(memberCookie, {
      apartmentId: otherApartmentId,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );
  });

  it("refuses a period that ends before it begins", async () => {
    const response = await apply(memberCookie, {
      periodFrom: dayText(200),
      periodTo: dayText(30),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("invalid-period");
  });
});

describe("who may read which half", () => {
  it("keeps the queue away from the member who applies to it", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/sublet-queue",
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("keeps the whole module away from the property manager", async () => {
    // Decision 11: an external contractor handles issues and nothing else. What
    // a member does with their own tenant-ownership is not their business.
    for (const url of ["/api/sublet-applications/mine", "/api/sublet-queue"]) {
      const response = await inject({
        method: "GET",
        url,
        headers: { cookie: managerCookie },
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it("names the applicant to the board", async () => {
    const created = await apply(memberCookie);
    expect(created.statusCode).toBe(201);

    const queued = await queue(boardCookie);
    const row = queued.applications.find(
      (application) => application.id === created.json<{ id: string }>().id,
    );

    expect(row?.applicant).toEqual({
      kind: "member",
      personId: member.personId,
      name: "Maja Medlem",
    });
  });
});

describe("the personal identity number guardrail", () => {
  /*
   * Shaped like a personal identity number and valid by its checksum, so the
   * scan recognises it - a string that merely looked like one would let this
   * whole describe block pass against a service that scanned nothing. Belongs to
   * nobody: the same number `news-comments.int-spec.ts` uses.
   */
  const WITH_A_NUMBER = "Jag hyr ut till Erik, 19811218-9876, under tiden.";

  it("refuses an application carrying one, and names where without echoing it", async () => {
    const response = await apply(memberCookie, { reason: WITH_A_NUMBER });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      reason: string;
      locations: { part: string; offset: number }[];
    }>();
    expect(body.reason).toBe("personal-identity-number");
    expect(body.locations).toEqual([
      { part: "reason", offset: WITH_A_NUMBER.indexOf("1981") },
    ]);
    // The whole response body, not just the field the number would have
    // travelled in: a position is safe to publish and the value never is.
    expect(response.body).not.toContain("19811218-9876");
    expect(response.body).not.toContain("198112189876");
  });

  it("refuses it again on a later revision", async () => {
    /*
     * The half a scan on the way in does not cover. An application that arrived
     * clean and was edited to carry a number would otherwise be stored, and the
     * number would be on the board's screen and on an access report.
     */
    const created = await apply(memberCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const response = await inject({
      method: "PUT",
      url: `/api/sublet-applications/${id}`,
      payload: {
        periodFrom: dayText(30),
        periodTo: dayText(200),
        reason: WITH_A_NUMBER,
      },
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "personal-identity-number",
    );

    // And the stored row is the one that arrived clean.
    const mine = await intake(memberCookie);
    expect(
      mine.applications.find((row) => row.id === id)?.reason,
    ).not.toContain("19811218-9876");
  });

  it("refuses it in the board's own decision note", async () => {
    // The note is quoted back to the applicant and printed on their access
    // report, so it travels exactly as their own text does.
    const created = await apply(memberCookie);
    expect(created.statusCode).toBe(201);

    const response = await inject({
      method: "POST",
      url: `/api/sublet-queue/${created.json<{ id: string }>().id}/decision`,
      payload: { consent: false, note: WITH_A_NUMBER },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      reason: string;
      locations: { part: string }[];
    }>();
    expect(body.reason).toBe("personal-identity-number");
    expect(body.locations.map((hit) => hit.part)).toEqual(["decisionNote"]);
    expect(response.body).not.toContain("19811218-9876");
  });

  it("takes a revision that carries no number", async () => {
    const created = await apply(memberCookie);
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const response = await inject({
      method: "PUT",
      url: `/api/sublet-applications/${id}`,
      payload: {
        periodFrom: dayText(60),
        periodTo: dayText(240),
        reason: "Provbo pa annan ort, forlangt med tva manader.",
      },
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ periodTo: string }>().periodTo).toBe(dayText(240));
  });
});

describe("the board's answer", () => {
  it("records a consent with its date and never deletes the row", async () => {
    const created = await apply(memberCookie);
    const id = created.json<{ id: string }>().id;

    const decided = await inject({
      method: "POST",
      url: `/api/sublet-queue/${id}/decision`,
      payload: { consent: true, note: "Styrelsen samtycker for perioden." },
      headers: { cookie: boardCookie },
    });

    expect(decided.statusCode).toBe(201);
    const body = decided.json<{
      status: string;
      closedAt: string | null;
      decisionNote: string | null;
    }>();
    expect(body.status).toBe("CONSENTED");
    expect(body.closedAt).not.toBeNull();
    expect(body.decisionNote).toBe("Styrelsen samtycker for perioden.");

    // Still on the applicant's own list, with the board's words on it.
    const mine = await intake(memberCookie);
    expect(mine.applications.find((row) => row.id === id)?.status).toBe(
      "CONSENTED",
    );
  });

  it("closes exactly once, whichever way", async () => {
    const created = await apply(memberCookie);
    const id = created.json<{ id: string }>().id;

    const first = await inject({
      method: "POST",
      url: `/api/sublet-queue/${id}/decision`,
      payload: { consent: false, note: null },
      headers: { cookie: boardCookie },
    });
    expect(first.statusCode).toBe(201);

    const second = await inject({
      method: "POST",
      url: `/api/sublet-queue/${id}/decision`,
      payload: { consent: true, note: null },
      headers: { cookie: boardCookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ reason: string }>().reason).toBe("already-closed");
  });

  it("refuses a withdrawal once the board has answered", async () => {
    const created = await apply(memberCookie);
    const id = created.json<{ id: string }>().id;

    await inject({
      method: "POST",
      url: `/api/sublet-queue/${id}/decision`,
      payload: { consent: true, note: null },
      headers: { cookie: boardCookie },
    });

    const withdrawal = await inject({
      method: "POST",
      url: `/api/sublet-applications/${id}/withdrawal`,
      headers: { cookie: memberCookie },
    });

    expect(withdrawal.statusCode).toBe(409);
  });

  it("answers a request that is not the caller's as one that never existed", async () => {
    // The queue is what `sublets:handle` gates. A withdrawal endpoint that told
    // any identifier apart would report whether an application is there.
    const created = await apply(memberCookie);

    const response = await inject({
      method: "POST",
      url: `/api/sublet-applications/${created.json<{ id: string }>().id}/withdrawal`,
      // The administrator holds the capability and did not make this request.
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "application-not-found",
    );
  });
});

describe("the rent tribunal, stated rather than enforced", () => {
  const permission = { permittedOn: dayText(10), permittedUntil: dayText(200) };

  it("refuses a permission against an application the board has not refused", async () => {
    /*
     * BRL 7 kap. 11 § opens the route on the board having refused - "Vagrar
     * styrelsen att ge sitt samtycke" - so a permission recorded against an open
     * or a consented application describes a proceeding that had no ground to be
     * brought.
     */
    const created = await apply(memberCookie);
    const id = created.json<{ id: string }>().id;

    const open = await inject({
      method: "PUT",
      url: `/api/sublet-queue/${id}/tribunal-permission`,
      payload: { permission },
      headers: { cookie: boardCookie },
    });
    expect(open.statusCode).toBe(409);
    expect(open.json<{ reason: string }>().reason).toBe("not-refused");

    await inject({
      method: "POST",
      url: `/api/sublet-queue/${id}/decision`,
      payload: { consent: true, note: null },
      headers: { cookie: boardCookie },
    });

    const consented = await inject({
      method: "PUT",
      url: `/api/sublet-queue/${id}/tribunal-permission`,
      payload: { permission },
      headers: { cookie: boardCookie },
    });
    expect(consented.statusCode).toBe(409);
  });

  it("records one against a refusal without turning it into a consent", async () => {
    /*
     * The whole of the "stated rather than enforced" decision, asserted. The
     * association did not consent and the platform must not say it did; what the
     * tribunal permitted is a second fact recorded beside the refusal, and the
     * member reads both.
     */
    const created = await apply(memberCookie);
    const id = created.json<{ id: string }>().id;

    await inject({
      method: "POST",
      url: `/api/sublet-queue/${id}/decision`,
      payload: { consent: false, note: "Styrelsen ser inga skal." },
      headers: { cookie: boardCookie },
    });

    const recorded = await inject({
      method: "PUT",
      url: `/api/sublet-queue/${id}/tribunal-permission`,
      payload: { permission },
      headers: { cookie: boardCookie },
    });

    expect(recorded.statusCode).toBe(200);
    expect(
      recorded.json<{
        status: string;
        tribunalPermission: { permittedOn: string; permittedUntil: string };
      }>(),
    ).toMatchObject({
      status: "REFUSED",
      tribunalPermission: permission,
    });

    // And the applicant reads both facts on their own list.
    const mine = await intake(memberCookie);
    const own = mine.applications.find((row) => row.id === id);
    expect(own?.status).toBe("REFUSED");
    expect(own?.tribunalPermission?.permittedUntil).toBe(dayText(200));
  });

  it("clears a record entered wrongly", async () => {
    const created = await apply(memberCookie);
    const id = created.json<{ id: string }>().id;

    await inject({
      method: "POST",
      url: `/api/sublet-queue/${id}/decision`,
      payload: { consent: false, note: null },
      headers: { cookie: boardCookie },
    });
    await inject({
      method: "PUT",
      url: `/api/sublet-queue/${id}/tribunal-permission`,
      payload: { permission },
      headers: { cookie: boardCookie },
    });

    const cleared = await inject({
      method: "PUT",
      url: `/api/sublet-queue/${id}/tribunal-permission`,
      payload: { permission: null },
      headers: { cookie: boardCookie },
    });

    expect(cleared.statusCode).toBe(200);
    expect(
      cleared.json<{ tribunalPermission: unknown }>().tribunalPermission,
    ).toBeNull();
  });

  it("takes a permission that named no end", async () => {
    // 7 kap. 11 § forsta stycket requires one, but what is recorded is what the
    // decision said rather than what it ought to have said.
    const created = await apply(memberCookie);
    const id = created.json<{ id: string }>().id;

    await inject({
      method: "POST",
      url: `/api/sublet-queue/${id}/decision`,
      payload: { consent: false, note: null },
      headers: { cookie: boardCookie },
    });

    const recorded = await inject({
      method: "PUT",
      url: `/api/sublet-queue/${id}/tribunal-permission`,
      payload: {
        permission: { permittedOn: dayText(10), permittedUntil: null },
      },
      headers: { cookie: boardCookie },
    });

    expect(recorded.statusCode).toBe(200);
    expect(
      recorded.json<{
        tribunalPermission: { permittedUntil: string | null };
      }>().tribunalPermission.permittedUntil,
    ).toBeNull();
  });
});

describe("the purge", () => {
  it("erases a closed application whose letting is over and its window has run", async () => {
    const id = `su-expired-${suffix}`;
    await seedApplication({
      id,
      personId: member.personId,
      closedAt: daysBefore(90),
      periodTo: dayColumn(-60),
      status: "CONSENTED",
    });

    const summary = await purge.run(NOW, RETENTION_DAYS);

    expect(summary.applicationsDeleted).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.subletApplication.findUnique({ where: { id } }),
    ).toBeNull();

    // One entry per person, naming what went and the window it fell out of.
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "subletApplication",
        targetPersonId: member.personId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).not.toBeNull();
  });

  it("leaves a closed application alone while the letting is still running", async () => {
    /*
     * The property the second anchor exists for, and the one a single-anchor
     * purge would get wrong. The board answered a year ago; the consent covers a
     * letting that runs for another two months, and the association's record of
     * having given it has to outlive the letting rather than the answer.
     */
    const id = `su-running-${suffix}`;
    await seedApplication({
      id,
      personId: member.personId,
      closedAt: daysBefore(365),
      periodTo: dayColumn(60),
      status: "CONSENTED",
    });

    await purge.run(NOW, RETENTION_DAYS);

    expect(
      await prisma.subletApplication.findUnique({ where: { id } }),
    ).not.toBeNull();
  });

  it("leaves an open application alone however old it is", async () => {
    // The association is still processing it, so the purpose it is held for has
    // not ended. A queue nobody has worked is for the board to see rather than
    // for a job to erase.
    const id = `su-open-${suffix}`;
    await seedApplication({
      id,
      personId: member.personId,
      closedAt: null,
      periodTo: dayColumn(-300),
      status: "SUBMITTED",
    });

    await purge.run(NOW, RETENTION_DAYS);

    expect(
      await prisma.subletApplication.findUnique({ where: { id } }),
    ).not.toBeNull();
  });

  it("is stopped by a legal hold, including one placed while it runs", async () => {
    /*
     * The hold is checked twice, and the second check is the one that counts: a
     * board member who places a hold is entitled to assume it took effect. The
     * advisory lock is what makes that a decision rather than a race, so the
     * test takes the key first and asserts the purge is waiting on it.
     */
    const id = `su-held-${suffix}`;
    await seedApplication({
      id,
      personId: member.personId,
      closedAt: daysBefore(90),
      periodTo: dayColumn(-60),
      status: "REFUSED",
    });

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    // A transaction that takes the hold key, writes the hold, and waits. Run
    // through $executeRaw rather than $queryRaw because the lock function
    // returns void, which the client has no column type for - the same call
    // `retention/legal-hold-lock.ts` makes.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-hold:${member.personId}`}))`;
        await tx.legalHold.create({
          data: {
            personId: member.personId,
            reason: "Placed while the purge was running",
            placedByPersonId: board.personId,
          },
        });
        await holderDone;
      },
      /*
       * Longer than the wait below is willing to spend. An interactive
       * transaction defaults to five seconds, and this one is held open on
       * purpose while the purge queues behind its key - so on the default it
       * would abort with P2028 before the test let it go, the lock would be
       * released by the rollback, and the purge would sail through and erase.
       * The assertion would then fail as though the hold had not been honoured.
       */
      { timeout: 60_000, maxWait: 20_000 },
    );

    try {
      await waitFor(
        async () => (await holdLockCount(member.personId, true)) > 0n,
      );

      // The purge starts now and must block on the key rather than read past it.
      const running = purge.purgePerson(member.personId, NOW, RETENTION_DAYS);
      await waitFor(
        async () => (await holdLockCount(member.personId, false)) > 0n,
      );

      releaseHolder?.();
      await holder;

      // It erased nothing, because by the time it got the key the hold stood.
      await expect(running).resolves.toBe(0);
      expect(
        await prisma.subletApplication.findUnique({ where: { id } }),
      ).not.toBeNull();
    } finally {
      releaseHolder?.();
      await holder.catch(() => undefined);
      await prisma.legalHold.deleteMany({
        where: { personId: member.personId },
      });
    }
  }, 60_000);
});

describe("the data subject access report", () => {
  it("carries the member's applications with the date each becomes erasable", async () => {
    const closed = `su-report-closed-${suffix}`;
    const open = `su-report-open-${suffix}`;
    await prisma.subletApplication.create({
      data: {
        id: closed,
        appliedByPersonId: member.personId,
        apartmentId,
        periodFrom: new Date("2027-01-01T00:00:00.000Z"),
        periodTo: new Date("2027-06-30T00:00:00.000Z"),
        reason: "Arbete pa annan ort.",
        status: "REFUSED",
        closedAt: new Date("2027-04-15T12:00:00.000Z"),
        closedByPersonId: board.personId,
        decisionNote: "Styrelsen ser inga skal.",
        tribunalPermittedOn: new Date("2027-05-02T00:00:00.000Z"),
        tribunalPermittedUntil: new Date("2027-12-31T00:00:00.000Z"),
      },
    });
    createdApplicationIds.push(closed);
    await prisma.subletApplication.create({
      data: {
        id: open,
        appliedByPersonId: member.personId,
        apartmentId,
        periodFrom: dayColumn(400),
        periodTo: dayColumn(500),
        reason: "Nagot.",
      },
    });
    createdApplicationIds.push(open);

    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${member.personId}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);

    const report = response.json<{
      subletApplications: {
        applicationId: string;
        apartment: string | null;
        reason: string;
        status: string;
        decisionNote: string | null;
        tribunalPermittedOn: string | null;
        tribunalPermittedUntil: string | null;
        erasableFrom: string | null;
      }[];
    }>();

    const closedRow = report.subletApplications.find(
      (row) => row.applicationId === closed,
    );
    /*
     * Two years after the *later* of the two anchors, derived and never stored.
     * The board answered on the 15th of April 2027 and the letting ran to the
     * end of June, so the clock starts when the letting is over - the 1st of
     * July - and not when the answer was given.
     */
    expect(closedRow?.erasableFrom).toBe("2029-06-30");
    // The person's own words, and the association's words about them, in full.
    expect(closedRow?.reason).toBe("Arbete pa annan ort.");
    expect(closedRow?.decisionNote).toBe("Styrelsen ser inga skal.");
    // What the rent tribunal decided is held about this person, so art. 15 asks
    // for it whoever decided it.
    expect(closedRow?.tribunalPermittedOn).toBe("2027-05-02");
    expect(closedRow?.tribunalPermittedUntil).toBe("2027-12-31");
    expect(closedRow?.apartment).toContain("1301");

    const openRow = report.subletApplications.find(
      (row) => row.applicationId === open,
    );
    // No closing date to count from, and the association is still processing it.
    expect(openRow?.erasableFrom).toBeNull();
    expect(openRow?.status).toBe("SUBMITTED");
  });
});
