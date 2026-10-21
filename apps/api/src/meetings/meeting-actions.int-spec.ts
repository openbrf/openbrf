import { dateColumnOf, localDayOf } from "@openbrf/shared";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

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

loadEnvForIntegrationTests();

let moduleRef: TestingModule;
let prisma: PrismaService;
let registry: ActionRegistryService;
let callers: ActionCallerFactory;

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
  markAuthenticated(request, { personId, token, requestId: request.id });
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

  const meeting = await prisma.meeting.create({
    data: {
      kind: "EXTRAORDINARY",
      heldOn: dateColumnOf(today),
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
      { id: meetingId },
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
  it("lists the meeting in its year, naming nobody", async () => {
    const page = (await registry.invoke(
      connectedApp(board.personId),
      "meeting_list",
      { year: today.year, limit: 50 },
    )) as { meetings: { id: string; heldOn: string }[] };

    const listed = page.meetings.find((meeting) => meeting.id === meetingId);
    expect(listed).toMatchObject({ summoned: true, agendaItemCount: 2 });
    for (const meeting of page.meetings) {
      expect(meeting.heldOn.startsWith(String(today.year))).toBe(true);
    }
    expect(JSON.stringify(page)).not.toContain(member.personId);
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
