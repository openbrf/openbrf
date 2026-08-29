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
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { PersonDetail } from "./person.service";
import type { PublicationConsentView } from "./publication-consent";

/**
 * Publication consent (publiceringssamtycke) over HTTP, against a real
 * database.
 *
 * What a pure projection cannot prove is here: that the endpoint is closed to
 * anyone without the board's address book, that a withdrawal leaves the row it
 * closes on file, that the audit entry commits with the change it records, and
 * that a change which changes nothing writes neither.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const board = {
  personId: `pc-board-${suffix}`,
  email: `pc-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `pc-resident-${suffix}`,
  email: `pc-resident-${suffix}@exempel.se`,
};
const subject = {
  personId: `pc-subject-${suffix}`,
  email: `pc-subject-${suffix}@exempel.se`,
};
const personIds = [board.personId, resident.personId, subject.personId];

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PATCH";
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

async function createPerson(input: {
  personId: string;
  email: string;
}): Promise<void> {
  const email = await encryption.encrypt("person.email", input.email);
  await prisma.person.create({
    data: {
      id: input.personId,
      firstName: "Test",
      lastName: `Samtyckesson${suffix}`,
      emailCipher: email.cipher,
      emailIndex: email.index,
      preferredLocale: "sv",
    },
  });
}

/** Sets one scope through the endpoint the board's screen calls. */
async function setConsent(
  cookie: string,
  payload: { scope: string; granted: boolean; note?: string },
) {
  return inject({
    method: "PATCH",
    url: `/api/address-book/persons/${subject.personId}/publication-consent`,
    payload,
    headers: { cookie },
  });
}

async function personDetail(cookie: string): Promise<PersonDetail> {
  const response = await inject({
    method: "GET",
    url: `/api/address-book/persons/${subject.personId}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as PersonDetail;
}

function viewOf(
  detail: PersonDetail,
  scope: string,
): PublicationConsentView | undefined {
  return detail.publicationConsents.find((consent) => consent.scope === scope);
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

  await createPerson(board);
  await createPerson(resident);
  await createPerson(subject);

  const address = await prisma.address.create({
    data: {
      id: `pc-address-${suffix}`,
      street: "Samtyckesgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  const apartment = await prisma.apartment.create({
    data: {
      id: `pc-apartment-${suffix}`,
      addressId: address.id,
      number: "1001",
      floor: 0,
    },
  });
  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId: apartment.id,
      role: "RESIDENT",
      movedInOn: new Date("2024-01-01T00:00:00.000Z"),
    },
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15T00:00:00.000Z"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [board, resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
}, 180_000);

afterAll(async () => {
  // Consents first: the row names its person by foreign key, so the register
  // cannot be cleaned up around it. The audit log is append-only and stays.
  await prisma.publicationConsent.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.residency.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.apartment.deleteMany({
    where: { id: `pc-apartment-${suffix}` },
  });
  await prisma.address.deleteMany({ where: { id: `pc-address-${suffix}` } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await app.close();
});

describe("who may record a publication consent", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "PATCH",
      url: `/api/address-book/persons/${subject.personId}/publication-consent`,
      payload: { scope: "PHOTO", granted: true },
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident, who has no address book to record it in", async () => {
    const cookie = await signIn(resident.email);
    const response = await setConsent(cookie, {
      scope: "PHOTO",
      granted: true,
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses a scope the model does not have", async () => {
    const cookie = await signIn(board.email);
    const response = await setConsent(cookie, {
      scope: "ANYTHING_AT_ALL",
      granted: true,
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason?: string }).reason).toBe(
      "invalid-body",
    );
  });

  it("answers not-found for a person who is not in the register", async () => {
    const cookie = await signIn(board.email);
    const response = await inject({
      method: "PATCH",
      url: "/api/address-book/persons/no-such-person/publication-consent",
      payload: { scope: "PHOTO", granted: true },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("recording and withdrawing", () => {
  it("starts with every scope unasked", async () => {
    const cookie = await signIn(board.email);
    const detail = await personDetail(cookie);

    expect(detail.publicationConsents.map((consent) => consent.scope)).toEqual([
      "PHOTO",
      "NAME_ON_SITE",
      "BOARD_ROSTER",
    ]);
    expect(
      detail.publicationConsents.every((consent) => consent.state === "never"),
    ).toBe(true);
  });

  it("records a consent and writes the audit entry with it", async () => {
    const cookie = await signIn(board.email);
    const response = await setConsent(cookie, {
      scope: "NAME_ON_SITE",
      granted: true,
      note: "Sa ja på stämman",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "NAME_ON_SITE",
      state: "granted",
      withdrawnOn: null,
      note: "Sa ja på stämman",
    });

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "CONSENT_RECORDED",
        targetPersonId: subject.personId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.context).toMatchObject({ scope: "NAME_ON_SITE" });

    const row = await prisma.publicationConsent.findFirstOrThrow({
      where: { personId: subject.personId, scope: "NAME_ON_SITE" },
    });
    expect(row.recordedByPersonId).toBe(board.personId);
  });

  it("shows the consent on the board's person view", async () => {
    const cookie = await signIn(board.email);
    const detail = await personDetail(cookie);

    expect(viewOf(detail, "NAME_ON_SITE")?.state).toBe("granted");
    // One scope at a time: agreeing to be named is not agreeing to be
    // photographed.
    expect(viewOf(detail, "PHOTO")?.state).toBe("never");
  });

  it("writes nothing when the consent already stands", async () => {
    const cookie = await signIn(board.email);
    const before = await prisma.auditLogEntry.count({
      where: { action: "CONSENT_RECORDED", targetPersonId: subject.personId },
    });

    const response = await setConsent(cookie, {
      scope: "NAME_ON_SITE",
      granted: true,
    });
    expect(response.statusCode).toBe(200);

    const after = await prisma.auditLogEntry.count({
      where: { action: "CONSENT_RECORDED", targetPersonId: subject.personId },
    });
    // A no-op is not an act, and the log records acts.
    expect(after).toBe(before);
    expect(
      await prisma.publicationConsent.count({
        where: { personId: subject.personId, scope: "NAME_ON_SITE" },
      }),
    ).toBe(1);
  });

  it("closes the consent on withdrawal without deleting the row", async () => {
    const cookie = await signIn(board.email);
    const response = await setConsent(cookie, {
      scope: "NAME_ON_SITE",
      granted: false,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "withdrawn" });

    // The record that consent existed between two dates is the evidence that
    // what was published while it stood was published lawfully.
    const row = await prisma.publicationConsent.findFirstOrThrow({
      where: { personId: subject.personId, scope: "NAME_ON_SITE" },
    });
    expect(row.withdrawnAt).not.toBeNull();
    expect(row.grantedAt).not.toBeNull();

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "CONSENT_WITHDRAWN",
        targetPersonId: subject.personId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.context).toMatchObject({ scope: "NAME_ON_SITE" });
  });

  it("writes nothing when there is no consent to withdraw", async () => {
    const cookie = await signIn(board.email);
    const before = await prisma.auditLogEntry.count({
      where: { action: "CONSENT_WITHDRAWN", targetPersonId: subject.personId },
    });

    const response = await setConsent(cookie, {
      scope: "NAME_ON_SITE",
      granted: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "withdrawn" });

    const after = await prisma.auditLogEntry.count({
      where: { action: "CONSENT_WITHDRAWN", targetPersonId: subject.personId },
    });
    expect(after).toBe(before);
  });

  it("records a fresh grant beside the one that was withdrawn", async () => {
    const cookie = await signIn(board.email);
    const response = await setConsent(cookie, {
      scope: "NAME_ON_SITE",
      granted: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "granted",
      withdrawnOn: null,
    });

    // Two dated facts, not one row rewritten: the period between them is what
    // a question about an already published page is answered against.
    const rows = await prisma.publicationConsent.findMany({
      where: { personId: subject.personId, scope: "NAME_ON_SITE" },
      orderBy: [{ grantedAt: "asc" }],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.withdrawnAt).not.toBeNull();
    expect(rows[1]?.withdrawnAt).toBeNull();

    const detail = await personDetail(cookie);
    expect(viewOf(detail, "NAME_ON_SITE")?.state).toBe("granted");
  });

  it("closes every row a race left standing, not only the newest", async () => {
    const cookie = await signIn(board.email);

    /*
     * Two open rows for one scope is what two grants arriving at the same
     * moment produce: the invariant is a unique index restricted to rows where
     * withdrawnAt is null, which Prisma's schema cannot express, so the write
     * path is what has to hold it. Written directly because the race cannot be
     * provoked reliably through the endpoint, and given the same grant date so
     * that neither row is the obvious one to pick.
     */
    const grantedAt = new Date("2026-02-01T09:00:00.000Z");
    await prisma.publicationConsent.createMany({
      data: [
        {
          personId: subject.personId,
          scope: "BOARD_ROSTER",
          grantedAt,
          recordedByPersonId: board.personId,
        },
        {
          personId: subject.personId,
          scope: "BOARD_ROSTER",
          grantedAt,
          recordedByPersonId: board.personId,
        },
      ],
    });

    const response = await setConsent(cookie, {
      scope: "BOARD_ROSTER",
      granted: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "withdrawn" });

    // A row left open behind a withdrawal is the one way this record could say
    // a page was lawful to publish after the person asked to be taken off it.
    expect(
      await prisma.publicationConsent.count({
        where: {
          personId: subject.personId,
          scope: "BOARD_ROSTER",
          withdrawnAt: null,
        },
      }),
    ).toBe(0);

    const detail = await personDetail(cookie);
    expect(viewOf(detail, "BOARD_ROSTER")?.state).toBe("withdrawn");
  });
});
