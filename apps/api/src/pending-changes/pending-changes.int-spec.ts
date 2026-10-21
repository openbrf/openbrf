import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { AppModule } from "../app.module";
import { AuditLogService } from "../audit/audit-log.service";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { sweepExpiredPendingChanges } from "../retention/pending-change-sweep";
import { loadEnvForIntegrationTests, runSuffix } from "../testing/integration-env";
import { PENDING_CHANGE_LIFETIME_MS, PendingChangeService } from "./pending-change.service";

/**
 * The pending-change queue against a real database (ADR 0039).
 *
 * What only this suite can show: that nothing is written to the records when a
 * change is proposed, that the confirmed call runs as the person confirming it
 * on WEB through a real core action and its own service, that nobody but the
 * proposer can see or act on a change, that a refused confirmation and a second
 * press both leave the records as they were, that a confirmation failing after
 * the action wrote cannot run it again, and that the expiry is the clock's and
 * the purge's.
 *
 * The held action is `news_create`: a real write with a real refusal
 * (`slug-taken`) and an audit entry written by its own service, which is the
 * entry that has to lead back to the proposal.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let audit: AuditLogService;
let changes: PendingChangeService;
let callers: ActionCallerFactory;
let registry: ActionRegistryService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const board = {
  personId: `pending-board-${suffix}`,
  email: `pending-board-${suffix}@exempel.se`,
};
/** A second board member, whose seat ends between proposing and confirming. */
const leaving = {
  personId: `pending-leaving-${suffix}`,
  email: `pending-leaving-${suffix}@exempel.se`,
};
/** A second board member, who may write news and may not touch the first's. */
const colleague = {
  personId: `pending-colleague-${suffix}`,
  email: `pending-colleague-${suffix}@exempel.se`,
};
/** Under a legal hold, so the sweep must leave their expired change alone. */
const held = { personId: `pending-held-${suffix}` };
/** Has a backlog longer than one batch, which a legal hold interrupts. */
const backlogged = { personId: `pending-backlog-${suffix}` };
const personIds = [board, leaving, colleague, held, backlogged].map((person) => person.personId);

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.65.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.65.${String(subnet)}.${String(host + 1)}`;
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
        "accept-language": "sv-SE,sv;q=0.9",
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
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

/**
 * A plugin's own route proposing on behalf of the person whose request it is
 * serving, which is the only way a change is proposed today.
 */
function pluginCaller(personId: string): ActionCaller {
  const request = {
    id: `req-${suffix}`,
    principal: { personId },
  } as unknown as RequestWithToken;
  markAuthenticated(request);
  return callers.forPlugin(request);
}

function newsInput(slug: string) {
  return {
    slug,
    title: `Städdag ${suffix}`,
    blocks: [{ type: "paragraph", runs: [{ text: "Vi ses på gården." }] }],
  };
}

let boardCookie: string;
let leavingCookie: string;
let colleagueCookie: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  audit = app.get(AuditLogService);
  changes = app.get(PendingChangeService);
  callers = app.get(ActionCallerFactory);
  registry = app.get(ActionRegistryService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  await prisma.person.createMany({
    data: [
      { id: board.personId, firstName: "Bo", lastName: `Väntar${suffix}` },
      { id: leaving.personId, firstName: "Lis", lastName: `Väntar${suffix}` },
      { id: colleague.personId, firstName: "Kim", lastName: `Väntar${suffix}` },
      { id: held.personId, firstName: "Hed", lastName: `Väntar${suffix}` },
      {
        id: backlogged.personId,
        firstName: "Bea",
        lastName: `Väntar${suffix}`,
      },
    ],
  });
  await prisma.boardPosition.createMany({
    data: [board, leaving, colleague, held].map((person) => ({
      personId: person.personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2026-01-01"),
    })),
  });

  const auth = app.get(AuthService);
  for (const person of [board, leaving, colleague]) {
    await auth.createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  boardCookie = await signIn(board.email);
  leavingCookie = await signIn(leaving.email);
  colleagueCookie = await signIn(colleague.email);
});

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      // The audit entries stay: the log is append-only, as in every suite.
      await prisma.pendingChange.deleteMany({
        where: { proposedByPersonId: { in: personIds } },
      });
      await prisma.news.deleteMany({
        where: { authorPersonId: { in: personIds } },
      });
      await prisma.legalHold.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.account.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await app?.close();
  }
});

describe("proposing", () => {
  it("writes nothing to the records, and records that it was proposed", async () => {
    const slug = `proposed-${suffix}`;

    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );

    expect(await prisma.news.count({ where: { slug } })).toBe(0);

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "PENDING_CHANGE_PROPOSED", targetId: proposed.id },
      select: { actorPersonId: true, channel: true, context: true },
    });
    expect(entry.actorPersonId).toBe(board.personId);
    expect(entry.channel).toBe("PLUGIN");
    // The action's name, and nothing of what it would write.
    expect(entry.context).toEqual({ action: "news_create" });
  });

  it("refuses what the proposer could not do themselves", async () => {
    await prisma.boardPosition.updateMany({
      where: { personId: held.personId },
      data: { endedOn: new Date("2026-02-01") },
    });
    try {
      await expect(
        changes.propose(
          pluginCaller(held.personId),
          "news_create",
          newsInput(`not-theirs-${suffix}`),
        ),
      ).rejects.toMatchObject({ reason: "forbidden-capability" });
    } finally {
      await prisma.boardPosition.updateMany({
        where: { personId: held.personId },
        data: { endedOn: null },
      });
    }
  });

  it("refuses an input the action refuses, when it is proposed", async () => {
    await expect(
      changes.propose(pluginCaller(board.personId), "news_create", {
        ...newsInput(`loose-${suffix}`),
        published: true,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(
      await prisma.pendingChange.count({
        where: {
          proposedByPersonId: board.personId,
          input: { path: ["slug"], equals: `loose-${suffix}` },
        },
      }),
    ).toBe(0);
  });

  it("refuses to hold a read", async () => {
    await expect(
      changes.propose(pluginCaller(board.personId), "news_list", {}),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
  });
});

describe("who sees a pending change", () => {
  it("shows the proposer the action and what it would write", async () => {
    const slug = `seen-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );

    const response = await inject({
      method: "GET",
      url: `/api/pending-changes/mine/${proposed.id}`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode, response.body).toBe(200);
    const view = JSON.parse(response.body) as {
      actionName: string;
      action: { title: string } | null;
      input: { slug: string };
      channel: string;
    };
    expect(view.actionName).toBe("news_create");
    expect(view.action?.title).not.toBe("actions.news_create.title");
    expect(view.input.slug).toBe(slug);
    expect(view.channel).toBe("PLUGIN");
  });

  it("shows nobody else, not even a colleague who could make it", async () => {
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(`unseen-${suffix}`),
    );

    const list = await inject({
      method: "GET",
      url: "/api/pending-changes/mine",
      headers: { cookie: colleagueCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(
      (JSON.parse(list.body) as { pendingChanges: { id: string }[] }).pendingChanges,
    ).not.toContainEqual(expect.objectContaining({ id: proposed.id }));

    const one = await inject({
      method: "GET",
      url: `/api/pending-changes/mine/${proposed.id}`,
      headers: { cookie: colleagueCookie },
    });
    // Answered as one that does not exist.
    expect(one.statusCode).toBe(404);
    expect(JSON.parse(one.body)).toMatchObject({
      reason: "pending-change-not-found",
    });
  });

  it("is not reachable with a token at all", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/pending-changes/mine",
      headers: { authorization: "Bearer not-a-session" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("confirming", () => {
  it("runs the held call as the person confirming it, on WEB", async () => {
    const slug = `confirmed-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );

    const response = await inject({
      method: "POST",
      url: `/api/pending-changes/mine/${proposed.id}/confirm`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode, response.body).toBe(200);
    const news = await prisma.news.findUniqueOrThrow({
      where: { slug },
      select: { id: true, authorPersonId: true, published: true },
    });
    expect(news.authorPersonId).toBe(board.personId);
    expect(news.published).toBe(false);

    // The action's own entry, by its own service: the confirming person, on
    // WEB, leading back to the proposal.
    const written = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "NEWS_CONTENT_CHANGED", targetId: news.id },
      select: { actorPersonId: true, channel: true, context: true },
    });
    expect(written.actorPersonId).toBe(board.personId);
    expect(written.channel).toBe("WEB");
    expect(written.context).toMatchObject({ pendingChange: proposed.id });

    const confirmed = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "PENDING_CHANGE_CONFIRMED", targetId: proposed.id },
      select: { actorPersonId: true, channel: true },
    });
    expect(confirmed).toEqual({
      actorPersonId: board.personId,
      channel: "WEB",
    });

    expect(await prisma.pendingChange.count({ where: { id: proposed.id } })).toBe(0);
  });

  it("runs it once when it is pressed twice at the same moment", async () => {
    const slug = `twice-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );

    const press = () =>
      inject({
        method: "POST",
        url: `/api/pending-changes/mine/${proposed.id}/confirm`,
        headers: { cookie: boardCookie },
      });
    const statuses = (await Promise.all([press(), press()]))
      .map((response) => response.statusCode)
      .toSorted((a, b) => a - b);

    expect(statuses).toEqual([200, 404]);
    expect(await prisma.news.count({ where: { slug } })).toBe(1);
  });

  it("is refused for anybody but the proposer, and leaves the change waiting", async () => {
    const slug = `colleague-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );

    for (const act of ["confirm", "reject"]) {
      const response = await inject({
        method: "POST",
        url: `/api/pending-changes/mine/${proposed.id}/${act}`,
        headers: { cookie: colleagueCookie },
      });
      expect(response.statusCode).toBe(404);
    }

    expect(await prisma.news.count({ where: { slug } })).toBe(0);
    expect(await prisma.pendingChange.count({ where: { id: proposed.id } })).toBe(1);
  });

  it("is checked again as the person is now, not as they were", async () => {
    const slug = `term-ended-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(leaving.personId),
      "news_create",
      newsInput(slug),
    );

    // The board term ends between the proposal and the press.
    await prisma.boardPosition.updateMany({
      where: { personId: leaving.personId },
      data: { endedOn: new Date("2026-02-01") },
    });

    const response = await inject({
      method: "POST",
      url: `/api/pending-changes/mine/${proposed.id}/confirm`,
      headers: { cookie: leavingCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      reason: "forbidden-capability",
    });
    expect(await prisma.news.count({ where: { slug } })).toBe(0);
    // Still there, for the person to reject.
    expect(await prisma.pendingChange.count({ where: { id: proposed.id } })).toBe(1);
  });

  it("carries the action's own refusal, and keeps the change for rejecting", async () => {
    const slug = `taken-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );
    // Somebody takes the address in between.
    await prisma.news.create({
      data: {
        slug,
        title: "Först",
        content: { blocks: [] },
        authorPersonId: colleague.personId,
      },
    });

    const refused = await inject({
      method: "POST",
      url: `/api/pending-changes/mine/${proposed.id}/confirm`,
      headers: { cookie: boardCookie },
    });
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ reason: "slug-taken" });
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "PENDING_CHANGE_CONFIRMED", targetId: proposed.id },
      }),
    ).toBe(0);

    const rejected = await inject({
      method: "POST",
      url: `/api/pending-changes/mine/${proposed.id}/reject`,
      headers: { cookie: boardCookie },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await prisma.pendingChange.count({ where: { id: proposed.id } })).toBe(0);
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "PENDING_CHANGE_REJECTED", targetId: proposed.id },
      select: { actorPersonId: true, channel: true, context: true },
    });
    expect(entry).toEqual({
      actorPersonId: board.personId,
      channel: "WEB",
      context: { action: "news_create" },
    });
  });

  it("can be confirmed again once the action's refusal no longer holds", async () => {
    // The refusal wrote nothing, so the claim the confirmation made is lifted
    // and the change waits as it did.
    const slug = `freed-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );
    const taken = await prisma.news.create({
      data: {
        slug,
        title: "Först",
        content: { blocks: [] },
        authorPersonId: colleague.personId,
      },
    });

    const press = () =>
      inject({
        method: "POST",
        url: `/api/pending-changes/mine/${proposed.id}/confirm`,
        headers: { cookie: boardCookie },
      });
    expect((await press()).statusCode).toBe(409);
    expect(
      await prisma.pendingChange.findUniqueOrThrow({
        where: { id: proposed.id },
        select: { dispatchedAt: true },
      }),
    ).toEqual({ dispatchedAt: null });

    await prisma.news.delete({ where: { id: taken.id } });
    const confirmed = await press();

    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(
      await prisma.news.count({
        where: { slug, authorPersonId: board.personId },
      }),
    ).toBe(1);
  });
});

/**
 * The action's service commits in its own transaction, so nothing here can
 * roll its write back. What has to hold is that it never happens twice: once
 * the held call has reached its handler, the change is not waiting for
 * anything, whatever failed after.
 */
describe("a confirmation that fails after the action ran", () => {
  it("cannot be pressed into running the action again", async () => {
    const slug = `unrecorded-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );

    // The action writes; recording the confirmation does not.
    const record = audit.record.bind(audit);
    const failing = vi.spyOn(audit, "record").mockImplementation(async (entry, tx) => {
      if (entry.action === "PENDING_CHANGE_CONFIRMED") {
        throw new Error("The log is unavailable.");
      }
      return record(entry, tx);
    });
    const press = (act = "confirm") =>
      inject({
        method: "POST",
        url: `/api/pending-changes/mine/${proposed.id}/${act}`,
        headers: { cookie: boardCookie },
      });
    let failed;
    try {
      failed = await press();
    } finally {
      failing.mockRestore();
    }
    expect(failed.statusCode).toBe(500);
    expect(JSON.parse(failed.body)).toMatchObject({
      reason: "pending-change-failed-after-dispatch",
    });
    expect(await prisma.news.count({ where: { slug } })).toBe(1);

    // Pressed again, it finds nothing to run, and nothing to reject: the
    // action ran, and a rejection would say it had not.
    expect((await press()).statusCode).toBe(404);
    expect((await press("reject")).statusCode).toBe(404);
    expect(await prisma.news.count({ where: { slug } })).toBe(1);
    const list = await inject({
      method: "GET",
      url: "/api/pending-changes/mine",
      headers: { cookie: boardCookie },
    });
    expect(
      (JSON.parse(list.body) as { pendingChanges: { id: string }[] }).pendingChanges,
    ).not.toContainEqual(expect.objectContaining({ id: proposed.id }));

    // The sweep ends it, saying it was dispatched rather than that it lapsed.
    await prisma.pendingChange.update({
      where: { id: proposed.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await sweepExpiredPendingChanges(prisma, audit, new Date());
    const ended = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "PENDING_CHANGE_EXPIRED", targetId: proposed.id },
      select: { context: true },
    });
    expect(ended.context).toEqual({ action: "news_create", dispatched: true });
  });

  it("ends the change when the action wrote and returned what its schema refuses", async () => {
    const slug = `unusable-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
    );

    const { definition } = registry.get("news_create") ?? {};
    if (definition === undefined) {
      throw new Error("news_create is not registered.");
    }
    const handler = definition.handler.bind(definition);
    const widened = vi
      .spyOn(definition, "handler")
      .mockImplementationOnce(async (input, context) => {
        await handler(input, context);
        return { unexpected: true };
      });
    const press = () =>
      inject({
        method: "POST",
        url: `/api/pending-changes/mine/${proposed.id}/confirm`,
        headers: { cookie: boardCookie },
      });
    let refused;
    try {
      refused = await press();
    } finally {
      widened.mockRestore();
    }

    // The action's reason is recorded below; the person is told the change
    // may have been carried out and is no longer waiting.
    expect(refused.statusCode).toBe(500);
    expect(JSON.parse(refused.body)).toMatchObject({
      reason: "pending-change-failed-after-dispatch",
    });
    expect(await prisma.news.count({ where: { slug } })).toBe(1);
    expect(await prisma.pendingChange.count({ where: { id: proposed.id } })).toBe(0);
    const confirmed = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "PENDING_CHANGE_CONFIRMED", targetId: proposed.id },
      select: { actorPersonId: true, channel: true, context: true },
    });
    expect(confirmed).toEqual({
      actorPersonId: board.personId,
      channel: "WEB",
      context: { action: "news_create", failure: "output-invalid" },
    });

    expect((await press()).statusCode).toBe(404);
    expect(await prisma.news.count({ where: { slug } })).toBe(1);
  });
});

describe("expiry", () => {
  it("stops a change waiting at its expiry, whether or not the sweep has run", async () => {
    const slug = `expired-${suffix}`;
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(slug),
      new Date(Date.now() - PENDING_CHANGE_LIFETIME_MS - 60_000),
    );

    const list = await inject({
      method: "GET",
      url: "/api/pending-changes/mine",
      headers: { cookie: boardCookie },
    });
    expect(
      (JSON.parse(list.body) as { pendingChanges: { id: string }[] }).pendingChanges,
    ).not.toContainEqual(expect.objectContaining({ id: proposed.id }));

    const confirm = await inject({
      method: "POST",
      url: `/api/pending-changes/mine/${proposed.id}/confirm`,
      headers: { cookie: boardCookie },
    });
    expect(confirm.statusCode).toBe(404);
    expect(await prisma.news.count({ where: { slug } })).toBe(0);
  });

  it("is swept the night after, and the end is on the proposer's record", async () => {
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(`swept-${suffix}`),
      new Date(Date.now() - PENDING_CHANGE_LIFETIME_MS - 60_000),
    );

    await sweepExpiredPendingChanges(prisma, audit, new Date());

    expect(await prisma.pendingChange.count({ where: { id: proposed.id } })).toBe(0);
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "PENDING_CHANGE_EXPIRED", targetId: proposed.id },
      select: {
        actorPersonId: true,
        targetPersonId: true,
        channel: true,
        context: true,
      },
    });
    expect(entry).toEqual({
      actorPersonId: null,
      targetPersonId: board.personId,
      channel: "SYSTEM",
      context: { action: "news_create" },
    });
  });

  it("sweeps a backlog larger than one batch, each change with its entry", async () => {
    const ids = Array.from({ length: 105 }, (_, i) => `batch-${suffix}-${i}`);
    await prisma.pendingChange.createMany({
      data: ids.map((id) => ({
        id,
        actionName: "news_create",
        input: {},
        proposedByPersonId: board.personId,
        channel: "WEB" as const,
        expiresAt: new Date(Date.now() - 60_000),
      })),
    });

    const swept = await sweepExpiredPendingChanges(prisma, audit, new Date());

    expect(swept).toBeGreaterThanOrEqual(ids.length);
    expect(await prisma.pendingChange.count({ where: { id: { in: ids } } })).toBe(0);
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "PENDING_CHANGE_EXPIRED", targetId: { in: ids } },
      }),
    ).toBe(ids.length);
  });

  it("commits a batch before the next, so a hold placed between them keeps the rest", async () => {
    const ids = Array.from({ length: 105 }, (_, i) => `held-${suffix}-${i}`);
    await prisma.pendingChange.createMany({
      data: ids.map((id) => ({
        id,
        actionName: "news_create",
        input: {},
        proposedByPersonId: backlogged.personId,
        channel: "WEB" as const,
        expiresAt: new Date(Date.now() - 60_000),
      })),
    });
    const remaining = () => prisma.pendingChange.count({ where: { id: { in: ids } } });

    // A hold lands as soon as one transaction of the sweep has committed and
    // part of the backlog is gone. One transaction for the whole backlog
    // commits it all before the hold exists, so none is left to keep.
    let holdPlaced = false;
    const interrupting = new Proxy(prisma, {
      get(target, property) {
        if (property === "$transaction") {
          const transaction = Reflect.get(target, property, target) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          return async (...args: unknown[]) => {
            const result = await transaction.apply(target, args);
            if (!holdPlaced && (await remaining()) < ids.length) {
              holdPlaced = true;
              await prisma.legalHold.create({
                data: {
                  personId: backlogged.personId,
                  reason: `Tvist ${suffix}`,
                  placedByPersonId: board.personId,
                },
              });
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });

    await sweepExpiredPendingChanges(interrupting, audit, new Date());

    expect(holdPlaced).toBe(true);
    // The first batch of 100 committed with its entries; the hold kept the 5.
    expect(await remaining()).toBe(5);
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "PENDING_CHANGE_EXPIRED", targetId: { in: ids } },
      }),
    ).toBe(100);

    await prisma.legalHold.deleteMany({
      where: { personId: backlogged.personId },
    });
    await sweepExpiredPendingChanges(prisma, audit, new Date());

    expect(await remaining()).toBe(0);
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "PENDING_CHANGE_EXPIRED", targetId: { in: ids } },
      }),
    ).toBe(ids.length);
  });

  it("leaves a held person's expired change for after the hold", async () => {
    const proposed = await changes.propose(
      pluginCaller(held.personId),
      "news_create",
      newsInput(`held-${suffix}`),
      new Date(Date.now() - PENDING_CHANGE_LIFETIME_MS - 60_000),
    );
    await prisma.legalHold.create({
      data: {
        personId: held.personId,
        reason: `Tvist ${suffix}`,
        placedByPersonId: board.personId,
      },
    });

    await sweepExpiredPendingChanges(prisma, audit, new Date());

    expect(await prisma.pendingChange.count({ where: { id: proposed.id } })).toBe(1);
  });

  it("leaves a change that is still waiting alone", async () => {
    const proposed = await changes.propose(
      pluginCaller(board.personId),
      "news_create",
      newsInput(`waiting-${suffix}`),
    );

    await sweepExpiredPendingChanges(prisma, audit, new Date());

    expect(await prisma.pendingChange.count({ where: { id: proposed.id } })).toBe(1);
  });
});
