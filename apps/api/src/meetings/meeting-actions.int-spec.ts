import { dateColumnOf, localDayOf } from "@openbrf/shared";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { ZodError } from "zod";

import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { PendingChangeService } from "../pending-changes/pending-change.service";
import { waitFor } from "../testing/advisory-locks";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { backendPid, waitersBehind } from "../testing/lock-waiters";

/**
 * The meeting reads against a real instance (ADR 0041).
 *
 * The meeting here holds everything the board's own screen holds about a
 * member: a member with protected personal data (skyddade personuppgifter) on
 * the list of those present, a proxy authorisation she gave, a vote row naming
 * her, and a notice that failed to reach her. What these suites assert is that
 * none of it reaches a connected app, while the agenda, the totals and the
 * notice's terms do; and that a person without `meetings:manage` is refused
 * before any of it is read.
 */

const integrationEnv = loadEnvForIntegrationTests();

let moduleRef: TestingModule;
let prisma: PrismaService;
let registry: ActionRegistryService;
let callers: ActionCallerFactory;
let changes: PendingChangeService;

const suffix = runSuffix();

const board = { personId: `meeting-action-board-${suffix}` };
const member = {
  personId: `meeting-action-member-${suffix}`,
  lastName: `Skyddad${suffix}`,
};
const holder = { personId: `meeting-action-holder-${suffix}` };
const manager = { personId: `meeting-action-manager-${suffix}` };
const personIds = [
  board.personId,
  member.personId,
  holder.personId,
  manager.personId,
];

let meetingId: string;
const today = localDayOf(new Date());

/**
 * The first and last calendar year a fixture may take. The action accepts
 * years up to 2200, and the year after the fixture year must stay inside that.
 */
const FIRST_FIXTURE_YEAR = 2101;
const LAST_FIXTURE_YEAR = 2199;

/** The four meetings on the edges of the fixture year, as the days they fall on. */
function edgeMeetingsOf(year: number) {
  return {
    dayBefore: { year: year - 1, month: 12, day: 31 },
    firstDay: { year, month: 1, day: 1 },
    lastDay: { year, month: 12, day: 31 },
    dayAfter: { year: year + 1, month: 1, day: 1 },
  };
}

/**
 * A calendar year no real meeting is held in, chosen per run.
 *
 * The year filter is asserted against fixtures in this year alone, so what
 * other suites or earlier runs left on the shared database does not change
 * the answer. A year is chosen at random among those where it and its two
 * neighbours hold no meeting yet, rather than at random alone, so a run that
 * leaked its fixtures does not share it.
 *
 * Choosing is not claiming: two runs that read the held years before either
 * has inserted would choose the same one. So the choice and the first
 * fixtures that make a year held happen in one transaction under an advisory
 * lock, and a run that arrives later reads the years the earlier one
 * committed. That keeps apart the runs that go through {@link claimFixtureYear};
 * a suite that put meetings into these years without it would not be seen
 * until its rows were committed.
 */
let fixtureYear = 0;
let edgeMeetings = edgeMeetingsOf(fixtureYear);
const edgeIds: Record<keyof ReturnType<typeof edgeMeetingsOf>, string> = {
  dayBefore: "",
  firstDay: "",
  lastDay: "",
  dayAfter: "",
};

/** The key every run takes before it chooses a fixture year. */
const FIXTURE_YEAR_LOCK = "meeting-fixture-year";

/** The years a claim may choose among, both included. */
interface YearRange {
  first: number;
  last: number;
}

const FIXTURE_YEARS: YearRange = {
  first: FIRST_FIXTURE_YEAR,
  last: LAST_FIXTURE_YEAR,
};

/**
 * Chooses a year in the range whose meeting list, and its neighbours', is
 * empty, and has `claim` insert the fixtures that make it held before the
 * lock is let go.
 */
async function claimFixtureYear(
  range: YearRange,
  claim: (tx: Prisma.TransactionClient, year: number) => Promise<void>,
  pick: (free: number[]) => number | undefined = (free) =>
    free[Math.floor(Math.random() * free.length)],
): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FIXTURE_YEAR_LOCK}))`;
      const held = await tx.meeting.findMany({
        where: {
          heldOn: {
            gte: dateColumnOf({ year: range.first - 1, month: 1, day: 1 }),
            lte: dateColumnOf({ year: range.last + 1, month: 12, day: 31 }),
          },
        },
        select: { heldOn: true },
      });
      const taken = new Set(
        held.map((meeting) => meeting.heldOn.getUTCFullYear()),
      );
      const free: number[] = [];
      for (let year = range.first; year <= range.last; year += 1) {
        if (!taken.has(year - 1) && !taken.has(year) && !taken.has(year + 1)) {
          free.push(year);
        }
      }
      const year = pick(free);
      if (year === undefined) {
        throw new Error("No calendar year is free for the meeting fixtures");
      }
      await claim(tx, year);
      return year;
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
}

/** The meetings the agenda suites draft for, one per test, removed at the end. */
const draftMeetingIds: string[] = [];

/** A request on the board member's own session, as the guard marks it. */
function sessionRequest(personId: string): RequestWithToken {
  const request = {
    id: `session-${suffix}`,
    principal: { personId },
  } as unknown as RequestWithToken;
  markAuthenticated(request, new LiveResponse(), {
    personId,
    token: null,
    requestId: request.id,
  });
  return request;
}

/** The AI package's own route, serving the given person's session. */
function aiPackage(personId: string): ActionCaller {
  return callers.forPlugin(sessionRequest(personId), {
    id: "ai-package",
    ai: true,
  });
}

/** A meeting being arranged, with an agenda of two items and no notice. */
async function draftMeeting(): Promise<{ id: string; itemIds: string[] }> {
  const meeting = await prisma.meeting.create({
    data: {
      kind: "ORDINARY",
      heldOn: dateColumnOf({ year: fixtureYear, month: 9, day: 1 }),
      agendaItems: {
        create: [
          { position: 1, title: "Stammans oppnande" },
          { position: 2, title: `Arsredovisning ${suffix}` },
        ],
      },
    },
    select: { id: true, agendaItems: { orderBy: { position: "asc" } } },
  });
  draftMeetingIds.push(meeting.id);
  return {
    id: meeting.id,
    itemIds: meeting.agendaItems.map((item) => item.id),
  };
}

async function titlesOf(id: string): Promise<string[]> {
  const items = await prisma.agendaItem.findMany({
    where: { meetingId: id },
    orderBy: { position: "asc" },
    select: { title: true },
  });
  return items.map((item) => item.title);
}

/** A connected app acting as the given person, built where the guard stands. */
function connectedApp(personId: string): ActionCaller {
  const token = {
    tokenRowId: `token-${suffix}`,
    clientId: `client-${suffix}`,
    clientHost: "app.example",
    scopes: ["mcp:read"],
  };
  const request = {
    id: `request-${suffix}`,
    principal: { personId, capabilities: new Set<string>() },
    token,
  } as unknown as RequestWithToken;
  markAuthenticated(request, new LiveResponse(), {
    personId,
    token,
    requestId: request.id,
  });
  return callers.forRequest(request);
}

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  await moduleRef.init();

  prisma = moduleRef.get(PrismaService);
  registry = moduleRef.get(ActionRegistryService);
  callers = moduleRef.get(ActionCallerFactory);
  changes = moduleRef.get(PendingChangeService);

  await prisma.person.createMany({
    data: [
      { id: board.personId, firstName: "Bo", lastName: `Stamma${suffix}` },
      {
        id: member.personId,
        firstName: "Rut",
        lastName: member.lastName,
        protectedPersonalData: true,
      },
      { id: holder.personId, firstName: "Ola", lastName: `Ombud${suffix}` },
      {
        id: manager.personId,
        firstName: "Per",
        lastName: `Forvaltare${suffix}`,
      },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  // The edge meetings make the year and both its neighbours held, so they are
  // what a claim inserts; the rest of the fixtures follow inside the year.
  fixtureYear = await claimFixtureYear(FIXTURE_YEARS, async (tx, year) => {
    edgeMeetings = edgeMeetingsOf(year);
    for (const key of Object.keys(
      edgeMeetings,
    ) as (keyof typeof edgeMeetings)[]) {
      const edge = await tx.meeting.create({
        data: { kind: "ORDINARY", heldOn: dateColumnOf(edgeMeetings[key]) },
        select: { id: true },
      });
      edgeIds[key] = edge.id;
    }
  });

  const meeting = await prisma.meeting.create({
    data: {
      kind: "EXTRAORDINARY",
      heldOn: dateColumnOf({ year: fixtureYear, month: 6, day: 15 }),
      agendaItems: {
        create: [
          { position: 1, title: "Val av ordforande vid stamman" },
          {
            position: 2,
            title: `Laddstolpar i garaget ${suffix}`,
            decision: {
              create: {
                outcome: "CARRIED",
                votesFor: 31,
                votesAgainst: 4,
                votesAbstaining: 2,
                closedBallot: true,
                recordedByPersonId: board.personId,
              },
            },
            votes: {
              create: [{ voterPersonId: member.personId, choice: "FOR" }],
            },
          },
        ],
      },
      attendances: {
        create: [
          {
            personId: member.personId,
            capacity: "MEMBER",
            mode: "IN_PERSON",
          },
        ],
      },
      proxyAuthorisations: {
        create: [
          {
            memberPersonId: member.personId,
            proxyHolderPersonId: holder.personId,
            ground: "MEMBER",
            authorisedOn: dateColumnOf(today),
            recordedByPersonId: board.personId,
          },
        ],
      },
      notice: {
        create: {
          startsAt: new Date(),
          place: "Foreningslokalen",
          issuedByPersonId: board.personId,
          deliveries: {
            create: [
              {
                personId: member.personId,
                status: "FAILED",
                failureReason: "no-address",
              },
            ],
          },
        },
      },
    },
    select: { id: true },
  });
  meetingId = meeting.id;
});

afterAll(async () => {
  try {
    if (prisma !== undefined && draftMeetingIds.length > 0) {
      await prisma.pendingChange.deleteMany({
        where: { proposedByPersonId: { in: personIds } },
      });
      await prisma.meetingNotice.deleteMany({
        where: { meetingId: { in: draftMeetingIds } },
      });
      await prisma.agendaItem.deleteMany({
        where: { meetingId: { in: draftMeetingIds } },
      });
      await prisma.meeting.deleteMany({
        where: { id: { in: draftMeetingIds } },
      });
    }
    if (prisma !== undefined && meetingId !== undefined) {
      // The children first: each holds the meeting down (Restrict), and the
      // decision, the votes and the deliveries go with their parents.
      await prisma.meetingNotice.deleteMany({ where: { meetingId } });
      await prisma.proxyAuthorisation.deleteMany({ where: { meetingId } });
      await prisma.meetingAttendance.deleteMany({ where: { meetingId } });
      await prisma.agendaItem.deleteMany({ where: { meetingId } });
      await prisma.meeting.deleteMany({ where: { id: meetingId } });
    }
    if (prisma !== undefined) {
      // Committed with the year's claim, before the meeting above exists.
      await prisma.meeting.deleteMany({
        where: { id: { in: Object.values(edgeIds).filter((id) => id !== "") } },
      });
    }
    if (prisma !== undefined) {
      await prisma.systemRole.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await moduleRef?.close();
  }
});

describe("what meeting_get carries out of the instance", () => {
  it("answers with the agenda, the totals and the notice's terms", async () => {
    const meeting = (await registry.invoke(
      connectedApp(board.personId),
      "meeting_get",
      {
        id: meetingId,
      },
    )) as {
      kind: string;
      summoned: boolean;
      agenda: {
        title: string;
        decision: Record<string, unknown> | null;
      }[];
      notice: { place: string } | null;
    };

    expect(meeting.kind).toBe("EXTRAORDINARY");
    expect(meeting.summoned).toBe(true);
    expect(meeting.agenda.map((item) => item.title)).toEqual([
      "Val av ordforande vid stamman",
      `Laddstolpar i garaget ${suffix}`,
    ]);
    expect(meeting.agenda[0]?.decision).toBeNull();
    expect(meeting.agenda[1]?.decision).toMatchObject({
      outcome: "CARRIED",
      votesFor: 31,
      votesAgainst: 4,
      votesAbstaining: 2,
      closedBallot: true,
    });
    expect(meeting.notice?.place).toBe("Foreningslokalen");
  });

  it("carries nobody: not who came, whose proxy, how anybody voted or whom the notice missed", async () => {
    const answer = JSON.stringify(
      await registry.invoke(connectedApp(board.personId), "meeting_get", {
        id: meetingId,
      }),
    );

    for (const personId of personIds) {
      expect(answer).not.toContain(personId);
    }
    expect(answer).not.toContain(member.lastName);
    for (const key of [
      "attendances",
      "proxyAuthorisations",
      "votingRegister",
      "votes",
      "deliveries",
    ]) {
      expect(answer).not.toContain(`"${key}"`);
    }
  });
});

describe("what meeting_list carries out of the instance", () => {
  type Page = {
    meetings: { id: string; heldOn: string }[];
    more: boolean;
  };
  const list = async (input: Record<string, number>) =>
    (await registry.invoke(
      connectedApp(board.personId),
      "meeting_list",
      input,
    )) as Page;

  it("lists the meeting in its year, naming nobody", async () => {
    const page = await list({ year: fixtureYear, limit: 50 });

    const listed = page.meetings.find((meeting) => meeting.id === meetingId);
    expect(listed).toMatchObject({ summoned: true, agendaItemCount: 2 });
    expect(JSON.stringify(page)).not.toContain(member.personId);
  });

  it("answers for one year only: the day before and the day after fall outside it", async () => {
    const own = await list({ year: fixtureYear, limit: 50 });
    const ids = own.meetings.map((meeting) => meeting.id);

    expect(ids).toContain(meetingId);
    expect(ids).toContain(edgeIds.firstDay);
    expect(ids).toContain(edgeIds.lastDay);
    expect(ids).not.toContain(edgeIds.dayBefore);
    expect(ids).not.toContain(edgeIds.dayAfter);
    for (const meeting of own.meetings) {
      expect(meeting.heldOn.startsWith(String(fixtureYear))).toBe(true);
    }
    expect(own.meetings.find((m) => m.id === edgeIds.firstDay)?.heldOn).toBe(
      `${fixtureYear}-01-01`,
    );
    expect(own.meetings.find((m) => m.id === edgeIds.lastDay)?.heldOn).toBe(
      `${fixtureYear}-12-31`,
    );

    const before = await list({ year: fixtureYear - 1, limit: 50 });
    expect(before.meetings.map((m) => m.id)).toContain(edgeIds.dayBefore);
    expect(before.meetings.map((m) => m.id)).not.toContain(edgeIds.firstDay);

    const after = await list({ year: fixtureYear + 1, limit: 50 });
    expect(after.meetings.map((m) => m.id)).toContain(edgeIds.dayAfter);
    expect(after.meetings.map((m) => m.id)).not.toContain(edgeIds.lastDay);
  });

  it("does not answer for this year with a meeting from another", async () => {
    const thisYear = await list({ year: today.year, limit: 50 });
    const ids = thisYear.meetings.map((meeting) => meeting.id);

    expect(ids).not.toContain(meetingId);
    expect(ids).not.toContain(edgeIds.firstDay);
    expect(ids).not.toContain(edgeIds.lastDay);
  });

  it("cuts the answer at the limit and says whether it left meetings out", async () => {
    const cut = await list({ year: fixtureYear, limit: 2 });
    expect(cut.more).toBe(true);
    // Furthest ahead first: the last day of the year, then mid-year.
    expect(cut.meetings.map((meeting) => meeting.id)).toEqual([
      edgeIds.lastDay,
      meetingId,
    ]);

    const whole = await list({ year: fixtureYear, limit: 3 });
    expect(whole.more).toBe(false);
    expect(whole.meetings.map((meeting) => meeting.id)).toEqual([
      edgeIds.lastDay,
      meetingId,
      edgeIds.firstDay,
    ]);
  });

  it("accepts the last year it allows and refuses the one after", async () => {
    await expect(list({ year: 2200 })).resolves.toMatchObject({
      more: false,
    });
    await expect(list({ year: 2201 })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("the choice of a fixture year", () => {
  // Far outside the years the suites above use, and at a different place each
  // run, so that the rows these checks leave while they run are no one's but
  // this run's.
  const first = 3000 + Math.floor(Math.random() * 5000);
  const probeRange: YearRange = { first, last: first + 2 };
  const probeIds: string[] = [];

  afterEach(async () => {
    await prisma.meeting.deleteMany({ where: { id: { in: probeIds } } });
    probeIds.length = 0;
  });

  /** Holds a meeting in the year, as a suite that has claimed it would. */
  async function hold(
    client: Prisma.TransactionClient | PrismaService,
    year: number,
  ): Promise<void> {
    const meeting = await client.meeting.create({
      data: {
        kind: "ORDINARY",
        heldOn: dateColumnOf({ year, month: 6, day: 15 }),
      },
      select: { id: true },
    });
    probeIds.push(meeting.id);
  }

  it("leaves out the years that hold a meeting and the ones next to them", async () => {
    await hold(prisma, first + 2);
    const offered: number[][] = [];
    // Offered only the years the rule leaves, it takes the first of them.
    const year = await claimFixtureYear(
      { first, last: first + 4 },
      (tx, chosen) => hold(tx, chosen),
      (free) => {
        offered.push(free);
        return free[0];
      },
    );

    expect(offered).toEqual([[first, first + 4]]);
    expect(year).toBe(first);
  });

  it("gives a claim that overlaps another no year the other has claimed", async () => {
    // The first claim holds its connection while it waits at the gate, the
    // second holds one while it waits for the lock, and the test asks the
    // database about them on a third. With fewer the second could not start,
    // and would only see the committed year, which passes without the lock.
    expect(integrationEnv.OPENBRF_DATABASE_POOL_SIZE).toBeGreaterThan(2);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (_pid: number): void => undefined;
    const holding = new Promise<number>((resolve) => {
      reached = resolve;
    });
    // Both would choose the year in the middle, the only one of the three
    // that leaves the others' neighbours alone.
    const middle = (free: number[]) => free[Math.floor(free.length / 2)];

    // The first has chosen and is yet to insert. Without the lock the second
    // would now read the same years, and choose the same one.
    const earlier = claimFixtureYear(
      probeRange,
      async (tx, year) => {
        reached(await backendPid(tx));
        await gate;
        await hold(tx, year);
      },
      middle,
    );
    const holder = await holding;
    const later = claimFixtureYear(
      probeRange,
      (tx, year) => hold(tx, year),
      middle,
    );
    // Let the first go only once the database has the second queued behind
    // it. Without the lock nothing ever queues, and the wait fails the test.
    // A failed wait still lets both go, so neither holds the lock past it.
    let claims: [PromiseSettledResult<number>, PromiseSettledResult<number>];
    try {
      await waitFor(async () => (await waitersBehind(prisma, holder)) > 0);
    } finally {
      release();
      claims = await Promise.allSettled([earlier, later]);
    }

    const [one, other] = claims;
    expect(one).toEqual({ status: "fulfilled", value: first + 1 });
    expect(other.status).toBe("rejected");
    expect(String((other as PromiseRejectedResult).reason)).toContain(
      "No calendar year is free",
    );
  });
});

/** The smallest input each read accepts. */
function inputFor(name: string): Record<string, string> {
  return name === "meeting_get" ? { id: meetingId } : {};
}

describe("who may read the meeting through an app", () => {
  it.each(["meeting_list", "meeting_get"])(
    "refuses %s to the property manager, who holds none of the meeting",
    async (name) => {
      await expect(
        registry.invoke(connectedApp(manager.personId), name, inputFor(name)),
      ).rejects.toMatchObject({ reason: "forbidden-capability" });
    },
  );

  it.each(["meeting_list", "meeting_get"])(
    "refuses %s to a person outside the board",
    async (name) => {
      await expect(
        registry.invoke(connectedApp(member.personId), name, inputFor(name)),
      ).rejects.toMatchObject({ reason: "forbidden-capability" });
    },
  );

  it("answers an id that names no meeting with the meeting's own refusal", async () => {
    await expect(
      registry.invoke(connectedApp(board.personId), "meeting_get", {
        id: `no-such-meeting-${suffix}`,
      }),
    ).rejects.toMatchObject({ reason: "meeting-not-found" });
  });
});

describe("an agenda the AI package drafts", () => {
  const drafted = [
    { title: "Stammans oppnande" },
    { title: "Val av ordforande" },
    { title: `Arsredovisning ${suffix}` },
  ];

  it("is held as a pending change, and written as the board member who confirms it", async () => {
    const meeting = await draftMeeting();

    const proposed = await changes.propose(
      aiPackage(board.personId),
      "meeting_set_agenda",
      {
        meetingId: meeting.id,
        expectedItemIds: meeting.itemIds,
        items: drafted,
      },
    );
    // Nothing is written until somebody confirms it.
    expect(await titlesOf(meeting.id)).toEqual([
      "Stammans oppnande",
      `Arsredovisning ${suffix}`,
    ]);

    await changes.confirm(sessionRequest(board.personId), proposed.id);

    expect(await titlesOf(meeting.id)).toEqual(
      drafted.map((item) => item.title),
    );
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "MEETING_AGENDA_SET", targetId: meeting.id },
      select: { actorPersonId: true, channel: true, context: true },
    });
    expect(entry).toEqual({
      actorPersonId: board.personId,
      channel: "WEB",
      // The count and the proposal it came from, and never a word of it.
      context: { itemCount: 3, pendingChange: proposed.id },
    });
  });

  it("is not written over an agenda somebody rewrote after it was drafted", async () => {
    const meeting = await draftMeeting();
    const proposed = await changes.propose(
      aiPackage(board.personId),
      "meeting_set_agenda",
      {
        meetingId: meeting.id,
        expectedItemIds: meeting.itemIds,
        items: drafted,
      },
    );

    // The board rewrites the agenda on its own screen in the meantime.
    await registry.invoke(
      callers.forRequest(sessionRequest(board.personId)),
      "meeting_set_agenda",
      {
        meetingId: meeting.id,
        expectedItemIds: meeting.itemIds,
        items: [{ title: `Ny dagordning ${suffix}` }],
      },
    );

    await expect(
      changes.confirm(sessionRequest(board.personId), proposed.id),
    ).rejects.toMatchObject({ reason: "agenda-changed" });
    expect(await titlesOf(meeting.id)).toEqual([`Ny dagordning ${suffix}`]);
  });

  it("is refused once the notice has been issued", async () => {
    const meeting = await draftMeeting();
    const proposed = await changes.propose(
      aiPackage(board.personId),
      "meeting_set_agenda",
      {
        meetingId: meeting.id,
        expectedItemIds: meeting.itemIds,
        items: drafted,
      },
    );
    await prisma.meetingNotice.create({
      data: {
        meetingId: meeting.id,
        startsAt: new Date(),
        place: "Foreningslokalen",
        issuedByPersonId: board.personId,
      },
    });

    await expect(
      changes.confirm(sessionRequest(board.personId), proposed.id),
    ).rejects.toMatchObject({ reason: "notice-already-issued" });
    expect(await titlesOf(meeting.id)).toEqual([
      "Stammans oppnande",
      `Arsredovisning ${suffix}`,
    ]);
  });

  it("is never written by the AI package directly", async () => {
    const meeting = await draftMeeting();

    await expect(
      registry.invoke(aiPackage(board.personId), "meeting_set_agenda", {
        meetingId: meeting.id,
        expectedItemIds: meeting.itemIds,
        items: drafted,
      }),
    ).rejects.toMatchObject({ reason: "confirmation-required" });
    expect(await titlesOf(meeting.id)).toHaveLength(2);
  });

  it("cannot be proposed for a person outside the board", async () => {
    const meeting = await draftMeeting();

    await expect(
      changes.propose(aiPackage(member.personId), "meeting_set_agenda", {
        meetingId: meeting.id,
        expectedItemIds: meeting.itemIds,
        items: drafted,
      }),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
  });
});
