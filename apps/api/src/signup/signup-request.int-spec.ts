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
import { SignupRequestService } from "./signup-request.service";

/**
 * Self-signup, including the two properties that keep it from becoming open
 * registration: the association toggle, and a request creating nothing but a
 * request until a board member approves it.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let requests: SignupRequestService;
let encryption: FieldEncryptionService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const board = {
  personId: `su-board-${suffix}`,
  email: `su-board-${suffix}@exempel.se`,
};
const applicantEmail = `applicant-${suffix}@exempel.se`;
let apartmentId: string;

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
        "x-forwarded-for": `10.2.0.${String(ipCounter % 250)}`,
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

async function setSelfSignup(enabled: boolean): Promise<void> {
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet", selfSignupEnabled: enabled },
    update: { selfSignupEnabled: enabled },
  });
}

const submission = () => ({
  firstName: "Nora",
  lastName: "Ny",
  email: applicantEmail,
  claimedAddress: "Storgatan 12",
  claimedApartmentNumber: "1105",
});

/**
 * Leaves exactly one pending request from the applicant.
 *
 * Called by every block that needs one, so no block depends on a request an
 * earlier block happened to create: a single test run in isolation, or a
 * reordering, would otherwise fail in findFirstOrThrow rather than on the
 * behaviour under test. Submitting twice is safe because a resubmission from
 * the same address replaces the outstanding request.
 */
async function ensurePendingRequest(): Promise<void> {
  await setSelfSignup(true);
  const response = await inject({
    method: "POST",
    url: "/api/signup-requests/submit",
    payload: submission(),
  });
  // Asserted here rather than discarded: a failed submission would otherwise
  // surface as a findFirstOrThrow in an unrelated test, which is the
  // misleading failure this helper exists to remove.
  expect(response.statusCode).toBe(202);
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
  requests = app.get(SignupRequestService);
  encryption = app.get(FieldEncryptionService);

  const email = await encryption.encrypt("person.email", board.email);
  await prisma.person.create({
    data: {
      id: board.personId,
      firstName: "Board",
      lastName: "Member",
      emailCipher: email.cipher,
      emailIndex: email.index,
    },
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15"),
    },
  });
  await app.get(AuthService).createAccountForPerson({
    personId: board.personId,
    email: board.email,
    name: "Board Member",
    password: PASSWORD,
  });

  const address = await prisma.address.create({
    data: {
      id: `su-address-${suffix}`,
      street: "Signupgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  const apartment = await prisma.apartment.create({
    data: {
      id: `su-apartment-${suffix}`,
      addressId: address.id,
      number: "1105",
      floor: 1,
    },
  });
  apartmentId = apartment.id;
}, 180_000);

afterAll(async () => {
  const applicantIndex = await encryption.computeIndex(
    "person.email",
    applicantEmail,
  );
  const applicants = await prisma.person.findMany({
    where: { emailIndex: applicantIndex ?? "none" },
    select: { id: true },
  });
  const personIds = [board.personId, ...applicants.map((p) => p.id)];

  await prisma.signupRequest.deleteMany({
    where: { claimedApartmentNumber: "1105" },
  });
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
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.apartment.deleteMany({ where: { id: apartmentId } });
  await prisma.address.deleteMany({ where: { id: `su-address-${suffix}` } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await setSelfSignup(false);
  await app.close();
});

describe("the self-signup toggle", () => {
  it("closes the endpoint when the association has it off", async () => {
    await setSelfSignup(false);

    const response = await inject({
      method: "POST",
      url: "/api/signup-requests/submit",
      payload: submission(),
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("accepts a request when the association has it on", async () => {
    await setSelfSignup(true);

    const response = await inject({
      method: "POST",
      url: "/api/signup-requests/submit",
      payload: submission(),
    });

    expect(response.statusCode).toBe(202);
  });
});

describe("the public state endpoint", () => {
  /*
   * The form the visitor meets is rendered from this answer, so it has to be
   * readable without a session and it has to follow the association rather
   * than a cached idea of it. The alternative - offering the form always and
   * letting the submission be refused - teaches a resident to retry a door the
   * board has deliberately shut.
   */
  it("answers a caller with no session", async () => {
    await setSelfSignup(true);

    const response = await inject({
      method: "GET",
      url: "/api/signup-requests/state",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: true });
  });

  it("follows the toggle when the board closes the door", async () => {
    await setSelfSignup(false);

    const response = await inject({
      method: "GET",
      url: "/api/signup-requests/state",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: false });
  });
});

describe("a pending request", () => {
  beforeAll(ensurePendingRequest);

  it("creates no person, residency or account by itself", async () => {
    const index = await encryption.computeIndex("person.email", applicantEmail);
    const person = await prisma.person.findFirst({
      where: { emailIndex: index ?? "none" },
    });

    // Asking for access must not put anyone in the register.
    expect(person).toBeNull();
  });

  it("replaces an earlier pending request from the same address", async () => {
    await inject({
      method: "POST",
      url: "/api/signup-requests/submit",
      payload: submission(),
    });

    const pending = await prisma.signupRequest.count({
      where: { claimedApartmentNumber: "1105", status: "PENDING" },
    });
    expect(pending).toBe(1);
  });

  it("is not readable without the deciding capability", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/signup-requests",
    });
    expect(response.statusCode).toBe(401);
  });

  it("is readable by a board member", async () => {
    const cookie = await signIn(board.email);
    const response = await inject({
      method: "GET",
      url: "/api/signup-requests",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { email: string }[];
    // The queue decrypts the address so the board can judge the claim.
    expect(body.some((entry) => entry.email === applicantEmail)).toBe(true);
  });
});

describe("approval", () => {
  beforeAll(ensurePendingRequest);

  it("creates the person and residency, and invites them", async () => {
    const pending = await prisma.signupRequest.findFirstOrThrow({
      where: { claimedApartmentNumber: "1105", status: "PENDING" },
    });

    const result = await requests.approve({
      requestId: pending.id,
      apartmentId,
      decidedByPersonId: board.personId,
    });

    const residency = await prisma.residency.findFirstOrThrow({
      where: { personId: result.personId },
    });
    // A self-signup never grants membership.
    expect(residency.role).toBe("RESIDENT");
    expect(residency.apartmentId).toBe(apartmentId);

    const invitation = await prisma.invitation.findFirst({
      where: { personId: result.personId },
    });
    expect(invitation).not.toBeNull();
  }, 60_000);

  it("refuses to decide the same request twice", async () => {
    const decided = await prisma.signupRequest.findFirstOrThrow({
      where: { claimedApartmentNumber: "1105", status: "APPROVED" },
    });

    await expect(
      requests.approve({
        requestId: decided.id,
        apartmentId,
        decidedByPersonId: board.personId,
      }),
    ).rejects.toMatchObject({ reason: "already-decided" });
  });

  it("refuses an apartment that does not exist", async () => {
    await setSelfSignup(true);
    const submitted = await requests.submit({
      ...submission(),
      email: `other-${suffix}@exempel.se`,
    });

    await expect(
      requests.approve({
        requestId: submitted.id,
        apartmentId: "no-such-apartment",
        decidedByPersonId: board.personId,
      }),
    ).rejects.toMatchObject({ reason: "apartment-not-found" });

    await requests.reject({
      requestId: submitted.id,
      decidedByPersonId: board.personId,
      reason: "cleanup",
    });
  });
});

/**
 * The decoy field on the public form.
 *
 * A script that fills in every input it finds fills that one too. What matters
 * is the pair: nothing reaches the board's queue, and the answer is the answer a
 * stored request gets - so nothing in it tells the script which field gave it
 * away, or that the form has a decoy in it at all.
 */
describe("a submission that filled the honeypot", () => {
  /** Nobody else's number, so an empty count means nothing was written. */
  const BOT_APARTMENT = "1106";

  it("is answered exactly as a stored one is, and stored nowhere", async () => {
    await setSelfSignup(true);

    const response = await inject({
      method: "POST",
      url: "/api/signup-requests/submit",
      payload: {
        ...submission(),
        email: `bot-${suffix}@exempel.se`,
        claimedApartmentNumber: BOT_APARTMENT,
        website: "https://example.invalid",
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { id: string };
    // The same shape, down to the one key: a body missing a field, or carrying
    // an extra one, is the tell this exists to avoid.
    expect(Object.keys(body)).toEqual(["id"]);
    expect(body.id).not.toBe("");

    expect(
      await prisma.signupRequest.count({
        where: { claimedApartmentNumber: BOT_APARTMENT },
      }),
    ).toBe(0);
  });

  it("is answered the same way on an instance that is not accepting requests", async () => {
    // Deliberate: the drop is decided before the toggle is read, so a script
    // cannot learn from a honeypot submission whether this association's form
    // is open. A person is still told, on the screen and by the endpoint.
    await setSelfSignup(false);

    const response = await inject({
      method: "POST",
      url: "/api/signup-requests/submit",
      payload: {
        ...submission(),
        email: `bot-closed-${suffix}@exempel.se`,
        claimedApartmentNumber: BOT_APARTMENT,
        website: "https://example.invalid",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(
      await prisma.signupRequest.count({
        where: { claimedApartmentNumber: BOT_APARTMENT },
      }),
    ).toBe(0);
  });
});
