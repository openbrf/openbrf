import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { formatLocalDay, localDayOf } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { lockIssueForHandling } from "./issue-lock";
import { IssueTextPurgeService } from "./issue-text-purge.service";

/**
 * A damage case (skadeärende, decision 28 of the issue module's plan) over
 * HTTP, against a real database: a handler marks an issue as an insurance
 * damage with the insurer, the claim number, the day and the cause, and the
 * mark places a legal hold (ADR 0057) so the issue's free text outlasts its
 * clock. Taking the mark off leaves the hold, which a handler releases as its
 * own act.
 */

// Refuses to run without a configured environment, before anything connects.
loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let textPurge: IssueTextPurgeService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `dc-${key}-${suffix}`,
    email: `dc-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const manager = person("manager", "Frida", "Forvaltare");
const people = [board, manager];
const personIds = people.map((entry) => entry.personId);

const typeIds = {
  leak: `dc-type-leak-${suffix}`,
  insurance: `dc-type-insurance-${suffix}`,
};
let leak: IssueTypeFixture;
let insurance: IssueTypeFixture;

const CLAIM = {
  insurer: "Länsförsäkringar",
  claimNumber: `S-2026-${suffix}`,
  occurredOn: "2026-10-30",
  cause: "WATER",
} as const;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        // 10.213.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.213.${String(subnet)}.${String(host + 1)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
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

const cookies: Record<string, string> = {};
const as = (entry: { personId: string }): string =>
  cookies[entry.personId] ?? "";

/** An internal issue the board opens, with no reporter. */
async function opened(type: IssueTypeFixture, key: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/issue-queue",
    payload: {
      typeId: type.id,
      description: `Vatten i källaren, ${key} ${suffix}`,
    },
    cookie: as(board),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

/** `replaces` is the mark the change is made from; none unless a test says. */
function mark(
  issueId: string,
  payload: object,
  cookie: string = as(board),
  replaces: object | null = null,
) {
  return inject({
    method: "PUT",
    url: `/api/issue-queue/${issueId}/damage-case`,
    payload: { ...payload, replaces },
    cookie,
  });
}

function unmark(issueId: string, replaces: object, cookie: string = as(board)) {
  return inject({
    method: "DELETE",
    url: `/api/issue-queue/${issueId}/damage-case`,
    payload: { replaces },
    cookie,
  });
}

function entriesOf(issueId: string) {
  return prisma.auditLogEntry.findMany({
    where: { targetKind: "issue", targetId: issueId },
    orderBy: { createdAt: "asc" },
    select: { action: true, actorPersonId: true, context: true },
  });
}

/** Whether this suite made the association row, and so removes it. */
let createdAssociation = false;

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
  textPurge = app.get(IssueTextPurgeService);
  const encryption = app.get(FieldEncryptionService);

  createdAssociation =
    (await prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    })) === null;
  if (createdAssociation) {
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet" },
    });
  }

  for (const entry of people) {
    const email = await encryption.encrypt("person.email", entry.email);
    await prisma.person.create({
      data: {
        id: entry.personId,
        firstName: entry.firstName,
        lastName: entry.lastName,
        emailCipher: email.cipher,
        emailIndex: email.index,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: entry.personId,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`,
      password: PASSWORD,
    });
  }
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  leak = await createIssueTypeFixture(prisma, {
    id: typeIds.leak,
    name: `Vattenläcka ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  insurance = await createIssueTypeFixture(prisma, {
    id: typeIds.insurance,
    name: `Försäkringsärende ${suffix}`,
    reporters: ["HANDLERS"],
    handledBy: "BOARD",
  });
  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  // The mail an issue a handler opens queues for the other handlers.
  const filed = await prisma.issue.findMany({
    where: { typeId: { in: Object.values(typeIds) } },
    select: { id: true },
  });
  await prisma.$executeRawUnsafe(
    "DELETE FROM pgboss.job WHERE data->>'issueId' = ANY($1::text[])",
    filed.map((issue) => issue.id),
  );
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
  });
  await prisma.issueType.deleteMany({
    where: { id: { in: Object.values(typeIds) } },
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
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  if (createdAssociation) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  }
  await app.close();
});

describe("a damage case", () => {
  it("is marked with the claim, places a legal hold, and keeps it when the mark comes off", async () => {
    const issueId = await opened(leak, "marked");

    const marked = await mark(issueId, CLAIM);
    expect(marked.statusCode, marked.body).toBe(200);
    const view = marked.json<{
      damageCase: unknown;
      legalHoldAt: string | null;
    }>();
    expect(view.damageCase).toEqual(CLAIM);
    expect(view.legalHoldAt).not.toBeNull();
    const placedAt = view.legalHoldAt;

    // The cause and the day, never the insurer or the claim number.
    const afterMark = await entriesOf(issueId);
    expect(afterMark).toContainEqual({
      action: "ISSUE_DAMAGE_CASE_MARKED",
      actorPersonId: board.personId,
      context: { cause: "WATER", occurredOn: "2026-10-30", changed: false },
    });
    expect(afterMark).toContainEqual({
      action: "ISSUE_LEGAL_HOLD_PLACED",
      actorPersonId: board.personId,
      context: { byDamageCase: true },
    });
    expect(JSON.stringify(afterMark)).not.toContain(CLAIM.claimNumber);
    expect(JSON.stringify(afterMark)).not.toContain(CLAIM.insurer);

    // The same mark again writes nothing.
    expect((await mark(issueId, CLAIM, as(board), CLAIM)).statusCode).toBe(200);
    expect(await entriesOf(issueId)).toHaveLength(afterMark.length);

    // A changed mark is recorded as one, and the hold keeps its date.
    const changed = await mark(
      issueId,
      { ...CLAIM, cause: "FIRE" },
      as(board),
      CLAIM,
    );
    expect(changed.json<{ legalHoldAt: string | null }>().legalHoldAt).toBe(
      placedAt,
    );
    expect(await entriesOf(issueId)).toContainEqual({
      action: "ISSUE_DAMAGE_CASE_MARKED",
      actorPersonId: board.personId,
      context: { cause: "FIRE", occurredOn: "2026-10-30", changed: true },
    });

    // Off again: the hold stays until a handler releases it.
    const removed = await unmark(issueId, { ...CLAIM, cause: "FIRE" });
    expect(removed.statusCode).toBe(200);
    expect(
      removed.json<{ damageCase: unknown; legalHoldAt: string | null }>(),
    ).toMatchObject({ damageCase: null, legalHoldAt: placedAt });
    expect(await entriesOf(issueId)).toContainEqual({
      action: "ISSUE_DAMAGE_CASE_REMOVED",
      actorPersonId: board.personId,
      context: {},
    });

    // The timeline says what happened, with the cause.
    const timeline = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/timeline`,
      cookie: as(board),
    });
    const steps = timeline.json<{ kind: string }[]>();
    expect(steps.filter((step) => step.kind === "damageCase")).toEqual([
      expect.objectContaining({ marked: true, cause: "WATER" }),
      expect.objectContaining({ marked: true, cause: "FIRE" }),
      expect.objectContaining({ marked: false, cause: null }),
    ]);
  });

  it("refuses a change made from a mark that is another by then, and writes nothing", async () => {
    const issueId = await opened(leak, "stale");
    expect((await mark(issueId, CLAIM)).statusCode).toBe(200);
    // Another handler changes the claim number.
    const theirs = { ...CLAIM, claimNumber: "S-2026-200" };
    expect((await mark(issueId, theirs, as(manager), CLAIM)).statusCode).toBe(
      200,
    );
    const entries = (await entriesOf(issueId)).length;

    // The first handler saves from the mark they read, which is gone.
    const stale = await mark(
      issueId,
      { ...CLAIM, insurer: "If Skadeförsäkring" },
      as(board),
      CLAIM,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ reason: string }>().reason).toBe("damage-case-changed");
    // Nor does a change that thinks there is no mark write over one.
    expect((await mark(issueId, CLAIM)).statusCode).toBe(409);
    const stored = await prisma.issueDamageCase.findUniqueOrThrow({
      where: { issueId },
      select: { insurer: true, claimNumber: true },
    });
    expect(stored).toEqual({
      insurer: CLAIM.insurer,
      claimNumber: "S-2026-200",
    });
    expect(await entriesOf(issueId)).toHaveLength(entries);

    // Taking the mark off is decided the same way: from the mark the handler
    // saw, which is another by now.
    const staleRemoval = await unmark(issueId, CLAIM);
    expect(staleRemoval.statusCode).toBe(409);
    expect(staleRemoval.json<{ reason: string }>().reason).toBe(
      "damage-case-changed",
    );
    expect(await prisma.issueDamageCase.count({ where: { issueId } })).toBe(1);
    expect(await entriesOf(issueId)).toHaveLength(entries);

    // A mark somebody else already took off is not taken off again.
    expect((await unmark(issueId, theirs, as(manager))).statusCode).toBe(200);
    const again = await unmark(issueId, theirs);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe("damage-case-changed");
  });

  it("does not place a second hold over one a handler placed", async () => {
    const issueId = await opened(leak, "held");
    const held = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/legal-hold`,
      payload: { held: true },
      cookie: as(board),
    });
    const placedAt = held.json<{ legalHoldAt: string }>().legalHoldAt;

    const marked = await mark(issueId, CLAIM);
    expect(marked.json<{ legalHoldAt: string }>().legalHoldAt).toBe(placedAt);
    expect(
      (await entriesOf(issueId)).filter(
        (entry) => entry.action === "ISSUE_LEGAL_HOLD_PLACED",
      ),
    ).toHaveLength(1);
  });

  it("keeps a closed issue's free text past its clock", async () => {
    const issueId = await opened(leak, "closed");
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        statusId: leak.statusIds.DONE,
        outcome: "FIXED",
        closedAt: new Date(Date.now() - 5 * 365 * 86_400_000),
      },
    });
    // A claim is often made after the repair: a closed issue is marked too.
    expect((await mark(issueId, CLAIM)).statusCode).toBe(200);

    expect(await textPurge.purgeIssue(issueId, new Date(), 2)).toBe("kept");
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { description: true },
        })
      ).description,
    ).not.toBe("");
  });

  it("keeps a closed issue's free text when a hold written under the issue's lock lands while the purge waits for it", async () => {
    /*
     * The mark takes the issue's lock (`lockIssueForHandling`) before it
     * writes `legalHoldAt`, and the purge reads the hold again under that
     * lock. `markDamageCase` opens its own transaction and cannot be paused,
     * so the holder here takes the same lock and writes the same hold. The
     * purge queues behind it on the advisory key, which `pg_locks` shows, and
     * finds the hold once it commits. A purge that read the hold before the
     * lock would remove the text.
     */
    const issueId = await opened(leak, "held");
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        statusId: leak.statusIds.DONE,
        outcome: "FIXED",
        closedAt: new Date(Date.now() - 5 * 365 * 86_400_000),
      },
    });
    const key = `issue:${issueId}`;

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holder: Promise<void> | undefined;
    let running: Promise<string> | undefined;

    try {
      // Longer than the waits below, so the transaction held open on purpose
      // is not aborted by the five-second default and its lock released early.
      holder = prisma.$transaction(
        async (tx) => {
          await lockIssueForHandling(tx, issueId);
          await tx.issue.update({
            where: { id: issueId },
            data: { legalHoldAt: new Date() },
          });
          await holderDone;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, true)) > 0n,
      );

      running = textPurge.purgeIssue(issueId, new Date(), 2);
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );

      releaseHolder?.();
      await holder;

      await expect(running).resolves.toBe("kept");
      expect(
        (
          await prisma.issue.findUniqueOrThrow({
            where: { id: issueId },
            select: { description: true },
          })
        ).description,
      ).not.toBe("");
    } finally {
      releaseHolder?.();
      await holder?.catch(() => undefined);
      await running?.catch(() => undefined);
    }
  }, 60_000);

  it("refuses a mark that says nothing, carries an identity number, or dates a day to come", async () => {
    const issueId = await opened(leak, "refused");
    const tomorrow = formatLocalDay(
      localDayOf(new Date(Date.now() + 2 * 86_400_000)),
    );
    const refusals: [object, number, string | null][] = [
      // Only invisible characters: the route's trim does not see them.
      [{ ...CLAIM, insurer: "​​" }, 422, "damage-case-incomplete"],
      [
        { ...CLAIM, claimNumber: "19121212-1212" },
        422,
        "personal-identity-number",
      ],
      [{ ...CLAIM, insurer: "19121212-1212" }, 422, "personal-identity-number"],
      [{ ...CLAIM, occurredOn: tomorrow }, 422, "damage-date-invalid"],
      [{ ...CLAIM, occurredOn: "2026-02-30" }, 422, "damage-date-invalid"],
      [{ ...CLAIM, cause: "FLOOD" }, 400, null],
      [{ ...CLAIM, note: "x" }, 400, null],
    ];
    for (const [payload, status, reason] of refusals) {
      const response = await mark(issueId, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(status);
      if (reason !== null) {
        expect(response.json<{ reason: string }>().reason).toBe(reason);
      }
    }
    const { damageCase, legalHoldAt } = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { damageCase: true, legalHoldAt: true },
    });
    expect({ damageCase, legalHoldAt }).toEqual({
      damageCase: null,
      legalHoldAt: null,
    });
  });

  it("is marked by any handler the issue lets in, and by nobody else", async () => {
    const shared = await opened(leak, "shared");
    expect((await mark(shared, CLAIM, as(manager))).statusCode).toBe(200);

    const boardOnly = await opened(insurance, "board-only");
    const refused = await mark(boardOnly, CLAIM, as(manager));
    expect(refused.statusCode).toBe(404);
    expect(refused.json<{ reason: string }>().reason).toBe("issue-not-found");
    const unmarked = await unmark(boardOnly, CLAIM, as(manager));
    expect(unmarked.statusCode).toBe(404);
  });
});
