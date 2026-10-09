import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PersonService } from "../address-book/person.service";
import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  InvitationError,
  InvitationService,
} from "../invitations/invitation.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
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
/*
 * The claim the queries below select on, made run-scoped like every other
 * fixture value here. Integration tests share one database, so a fixed number
 * would let a concurrent run's pending request answer findFirstOrThrow, and
 * would let this suite's cleanup delete that run's rows on the way out.
 */
const claimedApartmentNumber = `1105-${suffix}`;
/*
 * The honeypot block's claim, run-scoped for the same reason and one more: its
 * assertion is that NO request carries this number, so a fixed value would be
 * answered by any row another run left behind - including one this suite itself
 * left behind on the day the honeypot was broken, which would then fail the
 * test that proves it fixed.
 */
const botApartmentNumber = `1106-${suffix}`;
let apartmentId: string;
/*
 * Applicants other than the main one, for the blocks that need a request of
 * their own. Listed so the cleanup finds the persons their approvals created.
 */
const extraEmails = [
  `shared-${suffix}@exempel.se`,
  `returning-${suffix}@exempel.se`,
  `midnight-${suffix}@exempel.se`,
  `unsent-${suffix}@exempel.se`,
  `broken-${suffix}@exempel.se`,
  `lost-${suffix}@exempel.se`,
  `member-${suffix}@exempel.se`,
  `audited-${suffix}@exempel.se`,
  `racing-${suffix}@exempel.se`,
  `added-${suffix}@exempel.se`,
];
const otherClaim = `1107-${suffix}`;

/** Submits a request of its own for `email`, and returns its id. */
async function submitFor(email: string): Promise<string> {
  await setSelfSignup(true);
  const response = await inject({
    method: "POST",
    url: "/api/signup-requests/submit",
    payload: { ...submission(), email, claimedApartmentNumber: otherClaim },
  });
  expect(response.statusCode).toBe(202);
  const stored = await prisma.signupRequest.findMany({
    where: { claimedApartmentNumber: otherClaim, status: "PENDING" },
    select: { id: true, emailCipher: true },
  });
  for (const request of stored) {
    if (
      (await encryption.decrypt("signupRequest.email", request.emailCipher)) ===
      email
    ) {
      return request.id;
    }
  }
  throw new Error(`No pending request for ${email}.`);
}

/** A person already in the register under `email`, as the board entered them. */
async function registeredPerson(email: string, id: string): Promise<string> {
  const encrypted = await encryption.encrypt("person.email", email);
  await prisma.person.create({
    data: {
      id,
      firstName: "Registered",
      lastName: "Person",
      emailCipher: encrypted.cipher,
      emailIndex: encrypted.index,
    },
  });
  return id;
}

/**
 * Holds one address's lock in a transaction of its own, as a writer of a
 * person's address does, running `inside` under it and committing on
 * `release`. `locked` settles once the lock is held, so whatever the test
 * starts next is certain to find it taken.
 */
function holdAddressLock(
  emailIndex: string,
  inside: (tx: Prisma.TransactionClient) => Promise<void> = async () => {},
): {
  locked: Promise<void>;
  release: () => void;
  committed: Promise<void>;
} {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const committed = prisma.$transaction(
    async (tx) => {
      // Spelled out rather than imported, so a writer that quietly changed
      // its key fails here instead of passing under a new name.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`person-email:${emailIndex}`}))`;
      await inside(tx);
      locked();
      await held;
    },
    { timeout: 60_000, maxWait: 20_000 },
  );
  return { locked: lockTaken, release, committed };
}

/** True while a transaction is queued behind this one address's lock. */
async function waitsForAddressLock(emailIndex: string): Promise<boolean> {
  return (
    (await advisoryLockCount(prisma, `person-email:${emailIndex}`, false)) > 0n
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
  claimedApartmentNumber,
});

/**
 * Leaves exactly one pending request from the applicant.
 *
 * Called by every block that needs one, so no block depends on a request an
 * earlier block happened to create: a single test run in isolation, or a
 * reordering, would otherwise fail in findFirstOrThrow rather than on the
 * behaviour under test. An outstanding request is kept as it is, since a
 * resubmission from the same address never replaces it.
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
  /*
   * The audit entries the decisions wrote are append-only and stay.
   *
   * Removing them would mean disabling audit_log_entry_append_only, and that
   * ALTER is table-wide rather than session-scoped: it turns the statutory
   * guard off for every connection, including an overlapping run of these
   * suites, which runSuffix exists to make safe. Only the audit log's own
   * suites take that risk, because there the guard is the thing under test.
   * Nothing here depends on the rows being gone either - every assertion below
   * selects on a per-request id.
   */
  const applicantIndexes = await Promise.all(
    [applicantEmail, ...extraEmails].map((email) =>
      encryption.computeIndex("person.email", email),
    ),
  );
  const applicants = await prisma.person.findMany({
    where: {
      emailIndex: {
        in: applicantIndexes.filter((index) => index !== null),
      },
    },
    select: { id: true },
  });
  const personIds = [board.personId, ...applicants.map((p) => p.id)];

  await prisma.dataSubjectRequest.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.signupRequest.deleteMany({
    where: {
      claimedApartmentNumber: {
        in: [claimedApartmentNumber, botApartmentNumber, otherClaim],
      },
    },
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

  it("keeps the first pending request when the same address submits again", async () => {
    const first = await prisma.signupRequest.findFirstOrThrow({
      where: { claimedApartmentNumber, status: "PENDING" },
      select: { id: true, firstName: true, claimedAddress: true },
    });

    // Anybody can submit the form with a resident's address, so a second
    // submission must not replace the claim the board is about to read.
    const response = await inject({
      method: "POST",
      url: "/api/signup-requests/submit",
      payload: {
        ...submission(),
        firstName: "Someone",
        claimedAddress: "Annan gata 1",
      },
    });
    // Answered as a stored request is, so the caller learns nothing about
    // whether the address already has one waiting.
    expect(response.statusCode).toBe(202);
    expect(Object.keys(response.json() as object)).toEqual(["id"]);

    const pending = await prisma.signupRequest.findMany({
      where: { claimedApartmentNumber, status: "PENDING" },
      select: { id: true, firstName: true, claimedAddress: true },
    });
    expect(pending).toEqual([first]);
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
      where: { claimedApartmentNumber, status: "PENDING" },
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

  it("writes nothing to the member register", async () => {
    const decided = await prisma.signupRequest.findFirstOrThrow({
      where: { claimedApartmentNumber, status: "APPROVED" },
      select: { id: true },
    });
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "SIGNUP_REQUEST_APPROVED", targetId: decided.id },
      select: { targetPersonId: true },
    });

    expect(
      await prisma.memberRegisterEntry.count({
        where: { personId: entry.targetPersonId ?? "none" },
      }),
    ).toBe(0);
  });

  it("refuses a request that asks for membership, and creates nothing", async () => {
    const requestId = await submitFor(`member-${suffix}@exempel.se`);
    const cookie = await signIn(board.email);

    const response = await inject({
      method: "POST",
      url: `/api/signup-requests/${requestId}/approve`,
      payload: { apartmentId, role: "MEMBER" },
      headers: { cookie },
    });

    /*
     * Membership is entered by a move-in with its transfer, where the member
     * register row is written. An approval that granted it would leave a
     * member with no ENTRY, and an EXIT for them later that nothing began.
     */
    expect(response.statusCode).toBe(400);
    const request = await prisma.signupRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { status: true },
    });
    expect(request.status).toBe("PENDING");

    await requests.reject({
      requestId,
      decidedByPersonId: board.personId,
    });
  });

  it("dates the residency by the day in Stockholm, not in UTC", async () => {
    const email = `midnight-${suffix}@exempel.se`;
    const requestId = await submitFor(email);

    // 00:30 on 22 June in Stockholm is still 21 June in UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-21T22:30:00Z"));
    let personId: string;
    try {
      ({ personId } = await requests.approve({
        requestId,
        apartmentId,
        decidedByPersonId: board.personId,
      }));
    } finally {
      vi.useRealTimers();
    }

    const residency = await prisma.residency.findFirstOrThrow({
      where: { personId },
      select: { movedInOn: true },
    });
    expect(residency.movedInOn.toISOString().slice(0, 10)).toBe("2026-06-22");
  }, 60_000);

  it.each([
    {
      name: "the mail server refusing",
      applicant: "unsent",
      cause: Object.assign(new Error("550 recipient refused"), {
        code: "EENVELOPE",
      }),
      level: "warn",
    },
    {
      name: "another account signing in with the address",
      applicant: "taken",
      cause: new InvitationError(
        "Another account already signs in with this email address.",
        "email-in-use",
      ),
      level: "warn",
    },
    {
      name: "a fault in the code",
      applicant: "broken",
      cause: new TypeError("undefined is not a function"),
      level: "error",
    },
    {
      name: "the person it just created going missing",
      applicant: "lost",
      cause: new InvitationError("Person not found.", "person-not-found"),
      level: "error",
    },
  ] as const)(
    "keeps the approval and says the invitation was not sent after $name",
    async ({ applicant, cause, level }) => {
      const requestId = await submitFor(`${applicant}-${suffix}@exempel.se`);
      const invite = vi
        .spyOn(app.get(InvitationService), "invite")
        .mockRejectedValueOnce(cause);
      const warn = vi.spyOn(Logger.prototype, "warn");
      const error = vi.spyOn(Logger.prototype, "error");

      try {
        const result = await requests.approve({
          requestId,
          apartmentId,
          decidedByPersonId: board.personId,
        });

        expect(result.invitationSent).toBe(false);
        const request = await prisma.signupRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { status: true },
        });
        expect(request.status).toBe("APPROVED");
        expect(
          await prisma.residency.count({
            where: { personId: result.personId },
          }),
        ).toBe(1);
        // A fault is logged as one, so it is not passed off as an ordinary
        // refusal the board can resend past.
        const [logged, notLogged] = (
          level === "error" ? [error, warn] : [warn, error]
        ).map((spy) => spy.mock.calls.map(([message]) => String(message)));
        const line = expect.stringContaining(
          `Approved account request ${requestId}`,
        );
        expect(logged).toContainEqual(line);
        expect(notLogged).not.toContainEqual(line);
      } finally {
        invite.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    },
    60_000,
  );

  it("refuses to link a request to an address two persons share", async () => {
    const email = `shared-${suffix}@exempel.se`;
    await registeredPerson(email, `su-shared-a-${suffix}`);
    await registeredPerson(email, `su-shared-b-${suffix}`);
    const requestId = await submitFor(email);

    await expect(
      requests.approve({
        requestId,
        apartmentId,
        decidedByPersonId: board.personId,
      }),
    ).rejects.toMatchObject({ reason: "email-shared" });

    // Neither household member was given the applicant's residency.
    expect(
      await prisma.residency.count({
        where: {
          personId: { in: [`su-shared-a-${suffix}`, `su-shared-b-${suffix}`] },
        },
      }),
    ).toBe(0);

    await requests.reject({ requestId, decidedByPersonId: board.personId });
  });

  it("matches a person the board adds while the approval waits for the address", async () => {
    const email = `racing-${suffix}@exempel.se`;
    const requestId = await submitFor(email);
    const encrypted = await encryption.encrypt("person.email", email);
    const index = encrypted.index ?? "none";
    const racingId = `su-racing-${suffix}`;

    // The address book's write, held open after the person exists and before
    // it commits: the moment the approval used to read the register in.
    const writer = holdAddressLock(index, async (tx) => {
      await tx.person.create({
        data: {
          id: racingId,
          firstName: "Nora",
          lastName: "Ny",
          emailCipher: encrypted.cipher,
          emailIndex: encrypted.index,
        },
      });
    });
    await writer.locked;

    let settled = false;
    const approval = requests
      .approve({ requestId, apartmentId, decidedByPersonId: board.personId })
      .finally(() => (settled = true));

    // Released once the approval can make no progress on its own: waiting for
    // the address, which is the fix, or finished without it, which is the
    // defect and leaves a second person behind.
    await waitFor(async () => settled || (await waitsForAddressLock(index)));
    writer.release();
    await writer.committed;

    const approved = await approval;
    expect(approved.personId).toBe(racingId);
    expect(await prisma.person.count({ where: { emailIndex: index } })).toBe(1);
  }, 60_000);

  it("makes the address book wait for a writer holding the address", async () => {
    const email = `added-${suffix}@exempel.se`;
    const index =
      (await encryption.computeIndex("person.email", email)) ?? "none";

    const writer = holdAddressLock(index);
    await writer.locked;

    let settled = false;
    const added = app
      .get(PersonService)
      .create({ firstName: "Adam", lastName: "Adress", email }, board.personId)
      .finally(() => (settled = true));

    await waitFor(async () => settled || (await waitsForAddressLock(index)));
    expect(settled).toBe(false);
    writer.release();
    await writer.committed;
    await added;
  }, 60_000);

  it("follows the move-in's rules for a person already in the register", async () => {
    const email = `returning-${suffix}@exempel.se`;
    const personId = await registeredPerson(email, `su-returning-${suffix}`);
    await prisma.residency.create({
      data: {
        personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2024-01-01"),
      },
    });
    const erasure = await prisma.dataSubjectRequest.create({
      data: {
        personId,
        kind: "ERASURE",
        requestedOn: new Date("2025-01-10"),
        ground: "Flyttat",
        decision: "GRANTED",
        decidedAt: new Date("2025-01-11"),
      },
      select: { id: true },
    });

    // A residency on the same apartment for the same days is refused, and the
    // refusal leaves the request undecided.
    const first = await submitFor(email);
    await expect(
      requests.approve({
        requestId: first,
        apartmentId,
        decidedByPersonId: board.personId,
      }),
    ).rejects.toMatchObject({ reason: "already-resident" });
    const refused = await prisma.signupRequest.findUniqueOrThrow({
      where: { id: first },
      select: { status: true },
    });
    expect(refused.status).toBe("PENDING");

    // Once the old residency has ended, the move-in closes the erasure it
    // overtakes, as every other move-in does.
    await prisma.residency.updateMany({
      where: { personId },
      data: { movedOutOn: new Date("2024-12-31") },
    });
    await requests.approve({
      requestId: first,
      apartmentId,
      decidedByPersonId: board.personId,
    });
    const closed = await prisma.dataSubjectRequest.findUniqueOrThrow({
      where: { id: erasure.id },
      select: { closedAt: true, closeReason: true },
    });
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.closeReason).toBe("moved-in");
  }, 60_000);

  it("refuses to decide the same request twice", async () => {
    const decided = await prisma.signupRequest.findFirstOrThrow({
      where: { claimedApartmentNumber, status: "APPROVED" },
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
 * What a decision leaves behind.
 *
 * A self-signup decision is a board act on a person's access to the
 * association's data, so it is recorded like every other one. The entry has to
 * commit with the decision it records: a board member who loses the race for a
 * request finds it already decided and writes nothing, and the log must not
 * end up claiming two people decided one request.
 */
describe("the audit trail of a decision", () => {
  beforeAll(ensurePendingRequest);

  it("records an approval, naming the request and the person it produced", async () => {
    // An applicant of its own: the main one already lives in the apartment
    // after the approval block, and a second residency there is refused.
    const pending = { id: await submitFor(`audited-${suffix}@exempel.se`) };

    const result = await requests.approve({
      requestId: pending.id,
      apartmentId,
      decidedByPersonId: board.personId,
    });

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "SIGNUP_REQUEST_APPROVED",
        targetKind: "signupRequest",
        targetId: pending.id,
      },
    });

    expect(entry).not.toBeNull();
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.targetPersonId).toBe(result.personId);
    expect(entry?.context).toMatchObject({ apartmentId, role: "RESIDENT" });
  }, 60_000);

  it("records a rejection, and names no person because none was created", async () => {
    await ensurePendingRequest();
    const pending = await prisma.signupRequest.findFirstOrThrow({
      where: { claimedApartmentNumber, status: "PENDING" },
    });

    await requests.reject({
      requestId: pending.id,
      decidedByPersonId: board.personId,
      reason: "Bor inte i föreningen",
    });

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "SIGNUP_REQUEST_REJECTED",
        targetKind: "signupRequest",
        targetId: pending.id,
      },
    });

    expect(entry).not.toBeNull();
    expect(entry?.actorPersonId).toBe(board.personId);
    // The applicant is not in the register, so there is no person to name.
    expect(entry?.targetPersonId).toBeNull();
    // The fact that a reason was given, never the board's words about the
    // applicant: those are on the request row, which the entry names, and the
    // log is append-only and outside every purge scope.
    expect(entry?.context).toMatchObject({ reasonGiven: true });
    expect(JSON.stringify(entry?.context)).not.toContain(
      "Bor inte i föreningen",
    );

    const request = await prisma.signupRequest.findUniqueOrThrow({
      where: { id: pending.id },
      select: { rejectReason: true },
    });
    expect(request.rejectReason).toBe("Bor inte i föreningen");
  });

  it("writes nothing for a decision that was refused", async () => {
    const decided = await prisma.signupRequest.findFirstOrThrow({
      where: { claimedApartmentNumber, status: "REJECTED" },
      orderBy: [{ decidedAt: "desc" }],
    });

    await expect(
      requests.reject({
        requestId: decided.id,
        decidedByPersonId: board.personId,
      }),
    ).rejects.toMatchObject({ reason: "already-decided" });

    // One entry, not two: the refusal rolled its transaction back.
    const entries = await prisma.auditLogEntry.count({
      where: {
        action: "SIGNUP_REQUEST_REJECTED",
        targetKind: "signupRequest",
        targetId: decided.id,
      },
    });
    expect(entries).toBe(1);
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
  it("is answered exactly as a stored one is, and stored nowhere", async () => {
    await setSelfSignup(true);

    const response = await inject({
      method: "POST",
      url: "/api/signup-requests/submit",
      payload: {
        ...submission(),
        email: `bot-${suffix}@exempel.se`,
        claimedApartmentNumber: botApartmentNumber,
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
        where: { claimedApartmentNumber: botApartmentNumber },
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
        claimedApartmentNumber: botApartmentNumber,
        website: "https://example.invalid",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(
      await prisma.signupRequest.count({
        where: { claimedApartmentNumber: botApartmentNumber },
      }),
    ).toBe(0);
  });
});
