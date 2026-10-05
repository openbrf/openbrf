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
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { hashToken, InvitationService } from "./invitation.service";

/**
 * The invitation flow end to end, including the HTTP surface.
 *
 * Worth an integration test rather than unit tests because the interesting
 * properties are crosscutting: the token never being stored in the clear, the
 * endpoint being closed to residents, and activation producing an account that
 * can actually sign in.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let invitations: InvitationService;
let encryption: FieldEncryptionService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

const invitee = {
  personId: `inv-person-${suffix}`,
  email: `invitee-${suffix}@exempel.se`,
};
const board = {
  personId: `inv-board-${suffix}`,
  email: `board-${suffix}@exempel.se`,
};
const resident = {
  personId: `inv-resident-${suffix}`,
  email: `resident-${suffix}@exempel.se`,
};

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
        "x-forwarded-for": `10.1.0.${String(ipCounter % 250)}`,
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
  const encrypted = await encryption.encrypt("person.email", input.email);
  await prisma.person.create({
    data: {
      id: input.personId,
      firstName: "Test",
      lastName: "Person",
      emailCipher: encrypted.cipher,
      emailIndex: encrypted.index,
      preferredLocale: "sv",
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
  invitations = app.get(InvitationService);
  encryption = app.get(FieldEncryptionService);

  await createPerson(invitee);
  await createPerson(board);
  await createPerson(resident);

  // A board member may invite; a plain resident may not.
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
  const address = await prisma.address.create({
    data: {
      id: `inv-address-${suffix}`,
      street: "Invitegatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  const apartment = await prisma.apartment.create({
    data: {
      id: `inv-apartment-${suffix}`,
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
      movedInOn: new Date("2024-01-01"),
    },
  });

  // Both actors need accounts so they can sign in.
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
  const personIds = [invitee.personId, board.personId, resident.personId];
  await prisma.invitation.deleteMany({
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
    where: { id: `inv-apartment-${suffix}` },
  });
  await prisma.address.deleteMany({ where: { id: `inv-address-${suffix}` } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await app.close();
});

describe("sending an invitation", () => {
  it("is refused without a session", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/invitations",
      payload: { personId: invitee.personId },
    });

    // The guard is global, so an unprotected route is not the default.
    expect(response.statusCode).toBe(401);
  });

  it("is refused for a resident without the capability", async () => {
    const cookie = await signIn(resident.email);
    const response = await inject({
      method: "POST",
      url: "/api/invitations",
      payload: { personId: invitee.personId },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("is accepted for a board member", async () => {
    const cookie = await signIn(board.email);
    const response = await inject({
      method: "POST",
      url: "/api/invitations",
      payload: { personId: invitee.personId },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(202);
  });

  it("never stores the token in the clear", async () => {
    const stored = await prisma.invitation.findFirstOrThrow({
      where: { personId: invitee.personId },
    });

    // 64 hex characters is a SHA-256 digest, not a base64url token.
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("accepting an invitation", () => {
  it("rejects an unknown token", async () => {
    await expect(
      invitations.accept({ token: "not-a-real-token", password: PASSWORD }),
    ).rejects.toMatchObject({ reason: "invalid-token" });
  });

  it("rejects an expired invitation", async () => {
    const token = "expired-token-fixture";
    await prisma.invitation.create({
      data: {
        personId: invitee.personId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await expect(
      invitations.accept({ token, password: PASSWORD }),
    ).rejects.toMatchObject({ reason: "expired" });

    await prisma.invitation.deleteMany({
      where: { tokenHash: hashToken(token) },
    });
  });

  it("activates the account and allows sign-in", async () => {
    const token = "valid-token-fixture";
    await prisma.invitation.deleteMany({
      where: { personId: invitee.personId, acceptedAt: null },
    });
    await prisma.invitation.create({
      data: {
        personId: invitee.personId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const response = await inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: { token, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);

    // The address comes back so the activation screen can sign the new account
    // in without asking for it again. Only a caller holding a valid, unused
    // token that was mailed to that address reaches this response.
    expect(response.json()).toEqual({
      personId: invitee.personId,
      email: invitee.email,
    });

    // The whole point: the person can now sign in.
    const cookie = await signIn(invitee.email);
    expect(cookie).toContain("session_token");
  });

  it("refuses to reuse a consumed invitation", async () => {
    const used = await prisma.invitation.findFirstOrThrow({
      where: { personId: invitee.personId, acceptedAt: { not: null } },
    });
    expect(used.acceptedAt).not.toBeNull();

    await expect(
      invitations.accept({
        token: "valid-token-fixture",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ reason: "already-accepted" });
  });

  it("refuses a second invitation once an account exists", async () => {
    await expect(
      invitations.invite({
        personId: invitee.personId,
        invitedByPersonId: board.personId,
      }),
    ).rejects.toMatchObject({ reason: "already-has-account" });
  });
});

/**
 * The way in, in the audit log.
 *
 * An invitation is what turns a person in the register into someone who can
 * read it, so both halves are recorded: the board issuing the link, and the
 * recipient using it. Each entry commits with the row it describes, so the log
 * never claims an invitation that was not created or an activation that did
 * not happen.
 */
describe("the audit trail of an invitation", () => {
  it("records the send, naming the board member who issued it", async () => {
    const person = {
      personId: `inv-audit-${suffix}`,
      email: `inv-audit-${suffix}@exempel.se`,
    };
    await createPerson(person);

    const { expiresAt } = await invitations.invite({
      personId: person.personId,
      invitedByPersonId: board.personId,
    });

    const entry = await prisma.auditLogEntry.findFirst({
      where: { action: "INVITATION_SENT", targetPersonId: person.personId },
    });

    expect(entry).not.toBeNull();
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.context).toMatchObject({
      expiresAt: expiresAt.toISOString(),
    });

    await prisma.invitation.deleteMany({
      where: { personId: person.personId },
    });
    await prisma.person.deleteMany({ where: { id: person.personId } });
  }, 60_000);

  it("records the activation against the person who used the link", async () => {
    // The invitee activated their account earlier in this file, which is the
    // act this asserts: no session existed, so the person is both the actor
    // and the subject.
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "INVITATION_ACCEPTED",
        targetPersonId: invitee.personId,
      },
    });

    expect(entry).not.toBeNull();
    expect(entry?.actorPersonId).toBe(invitee.personId);
  });

  it("writes no second entry when a used link is presented again", async () => {
    await expect(
      invitations.accept({
        token: "valid-token-fixture",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ reason: "already-accepted" });

    const entries = await prisma.auditLogEntry.count({
      where: {
        action: "INVITATION_ACCEPTED",
        targetPersonId: invitee.personId,
      },
    });
    expect(entries).toBe(1);
  });
});
