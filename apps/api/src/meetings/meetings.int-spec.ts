import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { dateColumnOf, localDayOf } from "../bookings/stockholm-calendar";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { MeetingSummaryView, MeetingView } from "./meeting.service";

/**
 * The general meeting against a real database.
 *
 * Six properties, and four of them are statutory rules that no unit test can
 * show end to end because they are answers the API gives after reading the
 * member register, the residencies and the association's own bylaws together.
 *
 * A member holding two apartments has one vote (EFL 6 kap. 3 § with BRL 9 kap.
 * 14 § 1: the vote belongs to the membership, and the earlier draft of this
 * platform's plan had it the other way round).
 *
 * Members holding one bostadsratt jointly have one vote between them (BRL 9 kap.
 * 14 § 1, second sentence, and unconditional).
 *
 * A proxy holder may represent as many members as the bylaws allow and no more,
 * which for a housing cooperative is one unless the bylaws say otherwise (BRL 9
 * kap. 14 § 4, replacing EFL 6 kap. 5 §'s three). Asserted at both settings,
 * because the refusal alone would pass against an implementation that refused
 * every second authorisation.
 *
 * An assistant is on the list EFL 6 kap. 27 § requires and carries no vote (EFL
 * 6 kap. 7 § gives it the right to speak and nothing else).
 *
 * The audiences are split at the controller: the board reaches the module, a
 * resident and the external property manager do not.
 *
 * And a decision is minuted once the meeting has been held, corrected in place
 * rather than written twice, with the entry in the audit log naming the counts.
 *
 * ## Why the assertions filter the register
 *
 * The member register is append-only, so this suite cannot delete the rows it
 * writes into it and leaves its people behind - the report suite does the same
 * and says why. The register is the association's whole membership, so it carries
 * every person any suite has ever entered into this shared database. Nothing
 * here asserts a total; every count is over the lines belonging to this run's own
 * people, which is what makes the assertions about the rules rather than about
 * which suite ran first.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `mt-address-${suffix}`;
const apartments = {
  first: `mt-apartment-a-${suffix}`,
  second: `mt-apartment-b-${suffix}`,
  joint: `mt-apartment-c-${suffix}`,
  solo: `mt-apartment-d-${suffix}`,
  other: `mt-apartment-e-${suffix}`,
};

/** Holds two apartments, which is one vote and not two. */
const twoHoldings = {
  personId: `mt-two-${suffix}`,
  email: `mt-two-${suffix}@exempel.se`,
};
/** Two members holding one bostadsratt jointly: one vote between them. */
const jointFirst = {
  personId: `mt-joint-1-${suffix}`,
  email: `mt-joint-1-${suffix}@exempel.se`,
};
const jointSecond = {
  personId: `mt-joint-2-${suffix}`,
  email: `mt-joint-2-${suffix}@exempel.se`,
};
/** One apartment each: the two members whose votes a proxy holder may carry. */
const soloMember = {
  personId: `mt-solo-${suffix}`,
  email: `mt-solo-${suffix}@exempel.se`,
};
const otherMember = {
  personId: `mt-other-${suffix}`,
  email: `mt-other-${suffix}@exempel.se`,
};
/** Lives in the first apartment and holds no tenant-ownership. */
const lodger = {
  personId: `mt-lodger-${suffix}`,
  email: `mt-lodger-${suffix}@exempel.se`,
};
const board = {
  personId: `mt-board-${suffix}`,
  email: `mt-board-${suffix}@exempel.se`,
};
const manager = {
  personId: `mt-manager-${suffix}`,
  email: `mt-manager-${suffix}@exempel.se`,
};
/**
 * The account the bylaws writes go through.
 *
 * Its own person, and that is load-bearing rather than tidy. Changing what the
 * instance holds needs association:manage, which the board does not hold; but
 * granting ADMIN to the board member would give every boardCookie request the
 * administrator's whole capability set, because the guard resolves capabilities
 * per request from the roles. The assertion that a board seat alone reaches this
 * module would then pass whatever the capability model said - which is the one
 * failure a test about a capability must not have.
 */
const administrator = {
  personId: `mt-admin-${suffix}`,
  email: `mt-admin-${suffix}@exempel.se`,
};

const actors = [
  twoHoldings,
  jointFirst,
  jointSecond,
  soloMember,
  otherMember,
  lodger,
  board,
  manager,
  administrator,
];
const personIds = actors.map((actor) => actor.personId);
const memberIds = [
  twoHoldings.personId,
  jointFirst.personId,
  jointSecond.personId,
  soloMember.personId,
  otherMember.personId,
];

/** Every meeting this run arranged, so afterAll can clear the shared tables. */
const createdMeetingIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The day the meetings are held on, and the day a proxy authorisation was
 * signed.
 *
 * Relative to now rather than a literal date, for the reason every other suite
 * anchors its fixtures that way: this database is shared and a literal would
 * drift out of every window measured from today - here the year EFL 6 kap. 4 §
 * gives a proxy authorisation. Built through the association's own calendar
 * because the columns are `@db.Date`, and a date column read as an instant is
 * yesterday's date for the two hours a night Stockholm runs ahead of UTC.
 */
const today = localDayOf(new Date());
const MEETING_DAY = dateColumnOf(today);
const MEETING_DAY_TEXT = MEETING_DAY.toISOString().slice(0, 10);
const AUTHORISED_ON_TEXT = new Date(Date.now() - 30 * DAY_MS)
  .toISOString()
  .slice(0, 10);
/** Outside the year EFL 6 kap. 4 § allows, by a fortnight. */
const STALE_AUTHORITY_TEXT = new Date(Date.now() - 380 * DAY_MS)
  .toISOString()
  .slice(0, 10);

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        // 10.37.0.0/16 is this suite's; the others each hold their own second
        // octet. 10.40.0.1 to 10.40.0.4 are reserved for the screenshot walk's
        // four actors and must never be taken by an integration subnet.
        "x-forwarded-for": `10.37.${String(subnet)}.${String(host + 1)}`,
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

/** Arranges a meeting as the board, and remembers it for the cleanup. */
async function arrangeMeeting(heldOn = MEETING_DAY_TEXT): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/meetings",
    payload: { kind: "ORDINARY", heldOn },
    headers: { cookie: boardCookie },
  });
  expect(response.statusCode).toBe(201);
  const created = response.json<MeetingSummaryView>();
  createdMeetingIds.push(created.id);
  return created.id;
}

async function readMeeting(meetingId: string): Promise<MeetingView> {
  const response = await inject({
    method: "GET",
    url: `/api/meetings/${meetingId}`,
    headers: { cookie: boardCookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<MeetingView>();
}

function checkIn(
  meetingId: string,
  payload: {
    personId: string;
    capacity: "MEMBER" | "PROXY_HOLDER" | "ASSISTANT";
    mode?: "IN_PERSON" | "REMOTE";
    onBehalfOfPersonId?: string;
  },
) {
  return inject({
    method: "POST",
    url: `/api/meetings/${meetingId}/attendances`,
    payload: { mode: "IN_PERSON", ...payload },
    headers: { cookie: boardCookie },
  });
}

function registerProxy(
  meetingId: string,
  payload: {
    memberPersonId: string;
    proxyHolderPersonId: string;
    ground?: "MEMBER" | "SPOUSE_OR_COHABITANT" | "BYLAWS";
    authorisedOn?: string;
  },
) {
  return inject({
    method: "POST",
    url: `/api/meetings/${meetingId}/proxy-authorisations`,
    payload: {
      ground: "MEMBER",
      authorisedOn: AUTHORISED_ON_TEXT,
      ...payload,
    },
    headers: { cookie: boardCookie },
  });
}

/** How many of this run's own votes the register holds, and how many are present. */
function ownVotes(meeting: MeetingView): {
  total: number;
  present: number;
  lines: MeetingView["votingRegister"]["lines"];
} {
  const lines = meeting.votingRegister.lines.filter((line) =>
    line.memberPersonIds.some((personId) => memberIds.includes(personId)),
  );
  return {
    total: lines.length,
    present: lines.filter((line) => line.votePresent).length,
    lines,
  };
}

/** The register line one of this run's members is on. */
function lineOf(meeting: MeetingView, personId: string) {
  return meeting.votingRegister.lines.find((line) =>
    line.memberPersonIds.includes(personId),
  );
}

async function setBylaws(input: {
  proxyHolderEligibilityWidened?: boolean;
  maxMembersPerProxyHolder?: number;
  storageOnlyVoteLimited?: boolean;
  assistantEligibilityWidened?: boolean;
}): Promise<void> {
  const response = await inject({
    method: "PUT",
    url: "/api/settings/meeting-bylaws",
    payload: {
      proxyHolderEligibilityWidened: false,
      maxMembersPerProxyHolder: 1,
      storageOnlyVoteLimited: false,
      assistantEligibilityWidened: false,
      ...input,
    },
    headers: { cookie: adminCookie },
  });
  expect(response.statusCode).toBe(200);
}

let boardCookie = "";
let adminCookie = "";
let lodgerCookie = "";
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
      street: "Stammogatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartments.first, addressId, number: "1101", floor: 1 },
      { id: apartments.second, addressId, number: "1102", floor: 1 },
      { id: apartments.joint, addressId, number: "1201", floor: 2 },
      { id: apartments.solo, addressId, number: "1202", floor: 2 },
      { id: apartments.other, addressId, number: "1301", floor: 3 },
    ],
  });

  for (const person of [
    { ...twoHoldings, firstName: "Maja", lastName: "Tvaboende" },
    { ...jointFirst, firstName: "Erik", lastName: "Samagare" },
    { ...jointSecond, firstName: "Nina", lastName: "Samagare" },
    { ...soloMember, firstName: "Sofia", lastName: "Enboende" },
    { ...otherMember, firstName: "Olle", lastName: "Annanboende" },
    { ...lodger, firstName: "Lars", lastName: "Inneboende" },
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...manager, firstName: "Frida", lastName: "Forvaltare" },
    { ...administrator, firstName: "Adam", lastName: "Administrator" },
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
   * The residencies say which bostadsratt each membership covers, which is the
   * half of the register the archive cannot answer: an EXIT row is written only when
   * a person's last tenant-ownership ends, so the archive would leave an open
   * entry on an apartment somebody had sold.
   *
   * Maja holds two, Erik and Nina hold one between them, Sofia and Olle hold one
   * each, and Lars lives in Maja's first apartment holding nothing.
   */
  const movedInOn = new Date(Date.now() - 400 * DAY_MS);
  await prisma.residency.createMany({
    data: [
      {
        personId: twoHoldings.personId,
        apartmentId: apartments.first,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: twoHoldings.personId,
        apartmentId: apartments.second,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: jointFirst.personId,
        apartmentId: apartments.joint,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: jointSecond.personId,
        apartmentId: apartments.joint,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: soloMember.personId,
        apartmentId: apartments.solo,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: otherMember.personId,
        apartmentId: apartments.other,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: lodger.personId,
        apartmentId: apartments.first,
        role: "RESIDENT",
        movedInOn,
      },
    ],
  });

  /*
   * The member register is what says who was a member on the meeting day. One
   * ENTRY per membership per apartment, as a move-in as a member writes: Maja
   * has two, because she took two apartments, and `membershipPeriods` reads them
   * as one membership rather than two.
   *
   * These rows are never deleted. The archive refuses UPDATE and DELETE for
   * every caller, so this suite leaves them and the people they name behind -
   * which is why nothing here asserts a total over the register.
   */
  await prisma.memberRegisterEntry.createMany({
    data: [
      {
        personId: twoHoldings.personId,
        apartmentId: apartments.first,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Maja",
        recordedLastName: "Tvaboende",
      },
      {
        personId: twoHoldings.personId,
        apartmentId: apartments.second,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Maja",
        recordedLastName: "Tvaboende",
      },
      {
        personId: jointFirst.personId,
        apartmentId: apartments.joint,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Erik",
        recordedLastName: "Samagare",
      },
      {
        personId: jointSecond.personId,
        apartmentId: apartments.joint,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Nina",
        recordedLastName: "Samagare",
      },
      {
        personId: soloMember.personId,
        apartmentId: apartments.solo,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Sofia",
        recordedLastName: "Enboende",
      },
      {
        personId: otherMember.personId,
        apartmentId: apartments.other,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Olle",
        recordedLastName: "Annanboende",
      },
    ],
  });

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date(Date.now() - 200 * DAY_MS),
    },
  });
  /*
   * The board member holds no tenant-ownership, deliberately. `meetings:manage`
   * is the board's office and not a member's right - what a member holds at a
   * general meeting is the right to attend, speak and vote (EFL 6 kap. 2-3 §§),
   * none of which is a thing this platform does - so a board member who is not
   * a member must still reach the whole module.
   */
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  /*
   * The bylaws writes need association:manage, which the board does not hold -
   * changing what the instance holds stays with an administrator. So they go
   * through an account of their own, and the board account keeps its board
   * position and nothing else. See the comment on `administrator`: granting ADMIN
   * to the board member would disarm every assertion in this suite about what a
   * board seat reaches.
   */
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });

  boardCookie = await signIn(board.email);
  lodgerCookie = await signIn(lodger.email);
  managerCookie = await signIn(manager.email);
  adminCookie = await signIn(administrator.email);
}, 180_000);

/*
 * Cleanup in a try and the close in a finally, for the reason the motions suite
 * gives: a beforeAll that failed part-way leaves rows this suite has to remove
 * and rows it never wrote, and one throw here would take the rest of the cleanup
 * with it and never reach app.close() - leaving the Nest application, its Prisma
 * pool and its Fastify server open for the rest of the worker.
 */
afterAll(async () => {
  try {
    if (prisma !== undefined) {
      // The attendance lines, the authorities and the agenda cascade from the
      // meeting; naming them first clears a run that wrote one without the
      // other.
      await prisma.meetingAttendance.deleteMany({
        where: { meetingId: { in: createdMeetingIds } },
      });
      await prisma.proxyAuthorisation.deleteMany({
        where: { meetingId: { in: createdMeetingIds } },
      });
      await prisma.meeting.deleteMany({
        where: { id: { in: createdMeetingIds } },
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
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      /*
       * The persons, the apartments and the address stay. Every one of them is
       * named by a member register entry, and the archive refuses DELETE for
       * every caller - so removing them would need the guard turned off for this
       * connection, which is exactly the thing the guard exists to make
       * impossible. The report suite leaves its subject behind for the same
       * reason.
       */

      // The bylaws this suite wrote, back to the statutory position. updateMany,
      // because the row is absent whenever the setup failed before it reached
      // the association and update would throw P2025.
      await prisma.association.updateMany({
        where: { id: 1 },
        data: {
          bylawsWidenProxyHolderEligibility: false,
          bylawsMaxMembersPerProxyHolder: 1,
          bylawsLimitStorageOnlyVote: false,
          bylawsWidenAssistantEligibility: false,
        },
      });
      if (associationCreatedHere) {
        await prisma.association.deleteMany({ where: { id: 1 } });
      }
    }
  } finally {
    await app?.close();
  }
}, 120_000);

describe("who reaches the module", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({ method: "GET", url: "/api/meetings" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident who holds no tenant-ownership", async () => {
    // Not a statement about membership: `meetings:manage` is the board's office,
    // and a member who is not on the board holds it no more than a lodger does.
    const response = await inject({
      method: "GET",
      url: "/api/meetings",
      headers: { cookie: lodgerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses the external property manager", async () => {
    // The members' decisions about their own association are no part of a
    // contractor's work, and the list of who was in the room is resident data
    // they have no business reading.
    const response = await inject({
      method: "GET",
      url: "/api/meetings",
      headers: { cookie: managerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("lets a board member who holds no tenant-ownership run the meeting", async () => {
    /*
     * The board account holds a board position and no system role, which is what
     * makes this an assertion about `meetings:manage` rather than about the
     * administrator's blanket grant. The bylaws writes in this suite go through
     * a separate administrator for exactly that reason.
     */
    const roles = await prisma.systemRole.findMany({
      where: { personId: board.personId },
      select: { role: true },
    });
    expect(roles).toEqual([]);

    const response = await inject({
      method: "GET",
      url: "/api/meetings",
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("one vote per membership", () => {
  it("gives a member holding two apartments one vote and not two", async () => {
    /*
     * The rule the plan for this module had backwards at first. EFL 6 kap. 3 §
     * gives the vote to the member, and BRL 9 kap. 14 § 1 permits a bylaws
     * deviation only to limit a storage-only holding, so nothing makes a second
     * apartment a second vote.
     */
    const meetingId = await arrangeMeeting();
    const meeting = await readMeeting(meetingId);

    const line = lineOf(meeting, twoHoldings.personId);
    expect(line?.memberPersonIds).toEqual([twoHoldings.personId]);
    expect(line?.apartmentIds).toHaveLength(2);
    expect(line?.jointlyHeld).toBe(false);

    // And exactly one line names her, which is the assertion a register built per
    // holding would fail.
    expect(
      meeting.votingRegister.lines.filter((candidate) =>
        candidate.memberPersonIds.includes(twoHoldings.personId),
      ),
    ).toHaveLength(1);
  });

  it("gives joint holders of one bostadsratt one vote between them", async () => {
    const meetingId = await arrangeMeeting();
    const meeting = await readMeeting(meetingId);

    const line = lineOf(meeting, jointFirst.personId);
    expect(line?.memberPersonIds).toEqual(
      [jointFirst.personId, jointSecond.personId].sort(),
    );
    expect(line?.jointlyHeld).toBe(true);
    // The other holder is on that one line and on no other, which is what "one
    // vote between them" means as a count.
    expect(lineOf(meeting, jointSecond.personId)).toEqual(line);
  });

  it("counts this run's five memberships as four votes", async () => {
    /*
     * The two rules above, read as arithmetic: Maja's two apartments are one
     * vote, Erik and Nina's shared one is one between them, and Sofia and Olle
     * have one each. Five memberships, four votes.
     *
     * Filtered to this run's own people, because the archive is append-only and
     * every suite's members are in it.
     */
    const meetingId = await arrangeMeeting();
    const meeting = await readMeeting(meetingId);

    expect(ownVotes(meeting).total).toBe(4);
  });

  it("reports the storage clause rather than acting on it", async () => {
    /*
     * BRL 9 kap. 14 § 1 permits the bylaws to limit the vote of a member holding
     * nothing but a garage, a store or other storage space. The clause turns on
     * what a space is used for and this platform records no use for a space, so
     * the register says the clause stands and the meeting applies it. Asserted as a
     * vote that is still counted, because the failure to guard against is a register
     * that quietly subtracted one on a guess.
     */
    await setBylaws({ storageOnlyVoteLimited: true });
    try {
      const meetingId = await arrangeMeeting();
      const meeting = await readMeeting(meetingId);

      expect(meeting.votingRegister.storageOnlyVoteLimited).toBe(true);
      expect(ownVotes(meeting).total).toBe(4);
    } finally {
      await setBylaws({});
    }
  });
});

describe("checking people in", () => {
  it("refuses somebody who was not a member on the meeting day", async () => {
    // EFL 6 kap. 2-3 §§ give the right to attend, speak and vote to a member.
    // Lars lives in the building and holds no tenant-ownership.
    const meetingId = await arrangeMeeting();
    const response = await checkIn(meetingId, {
      personId: lodger.personId,
      capacity: "MEMBER",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe(
      "not-a-member-on-the-meeting-day",
    );
  });

  it("counts a joint holding once however many of its holders arrive", async () => {
    const meetingId = await arrangeMeeting();
    expect(
      (
        await checkIn(meetingId, {
          personId: jointFirst.personId,
          capacity: "MEMBER",
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await checkIn(meetingId, {
          personId: jointSecond.personId,
          capacity: "MEMBER",
        })
      ).statusCode,
    ).toBe(201);

    const meeting = await readMeeting(meetingId);
    expect(ownVotes(meeting).present).toBe(1);
    expect(
      lineOf(meeting, jointFirst.personId)?.presentMemberPersonIds,
    ).toEqual([jointFirst.personId, jointSecond.personId].sort());
  });

  it("gives an assistant no vote, and puts them on the list", async () => {
    /*
     * EFL 6 kap. 7 § lets a member or a proxy holder bring at most one
     * assistant, who may speak at the meeting. That is the whole of what it
     * grants.
     *
     * The assistant here is a member of the association in her own right, which
     * is the case that would slip past a check written against the register
     * rather than against the capacity: Sofia holds an apartment and is present
     * only as Maja's assistant, so her own vote is not in the room either.
     */
    const meetingId = await arrangeMeeting();
    expect(
      (
        await checkIn(meetingId, {
          personId: twoHoldings.personId,
          capacity: "MEMBER",
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await checkIn(meetingId, {
          personId: soloMember.personId,
          capacity: "ASSISTANT",
          onBehalfOfPersonId: twoHoldings.personId,
        })
      ).statusCode,
    ).toBe(201);

    const meeting = await readMeeting(meetingId);
    expect(meeting.votingRegister.assistantsPresent).toBe(1);
    // One vote present: Maja's. Sofia is in the room and her own vote is not.
    expect(ownVotes(meeting).present).toBe(1);
    expect(lineOf(meeting, soloMember.personId)?.votePresent).toBe(false);
  });

  it("refuses a member's line that names somebody who brought them", async () => {
    /*
     * A member is nobody's stand-in and a proxy holder's principals are the
     * authorities they hold, so only an assistant came with anybody - which the
     * table also states as a check constraint. Refused rather than dropped,
     * because a field the server silently ignored is a defect nothing surfaces.
     */
    const meetingId = await arrangeMeeting();
    const response = await checkIn(meetingId, {
      personId: twoHoldings.personId,
      capacity: "MEMBER",
      onBehalfOfPersonId: soloMember.personId,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "attendance-principal-not-applicable",
    );
  });

  it("refuses an assistant nobody on the list brought", async () => {
    const meetingId = await arrangeMeeting();
    const response = await checkIn(meetingId, {
      personId: soloMember.personId,
      capacity: "ASSISTANT",
      onBehalfOfPersonId: otherMember.personId,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "assistant-principal-not-present",
    );
  });

  it("takes a struck-off line off the register and back on again", async () => {
    const meetingId = await arrangeMeeting();
    const created = await checkIn(meetingId, {
      personId: soloMember.personId,
      capacity: "MEMBER",
    });
    expect(created.statusCode).toBe(201);
    const attendanceId = created.json<{ id: string }>().id;

    const struck = await inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/attendances/${attendanceId}/withdrawal`,
      headers: { cookie: boardCookie },
    });
    // 201, which is what a POST answers with here as it does for a withdrawn
    // motion: the route records an act rather than editing a field.
    expect(struck.statusCode).toBe(201);
    expect(
      lineOf(await readMeeting(meetingId), soloMember.personId)?.votePresent,
    ).toBe(false);

    // Checking them in again clears the date on the same line rather than
    // writing a second one, which is the sign-up's own pattern.
    expect(
      (
        await checkIn(meetingId, {
          personId: soloMember.personId,
          capacity: "MEMBER",
        })
      ).statusCode,
    ).toBe(201);
    const meeting = await readMeeting(meetingId);
    expect(lineOf(meeting, soloMember.personId)?.votePresent).toBe(true);
    expect(
      meeting.attendances.filter(
        (line) => line.personId === soloMember.personId,
      ),
    ).toHaveLength(1);
  });
});

describe("a member's proxy authorisation", () => {
  it("lets the proxy holder exercise an absent member's vote", async () => {
    const meetingId = await arrangeMeeting();
    expect(
      (
        await registerProxy(meetingId, {
          memberPersonId: soloMember.personId,
          proxyHolderPersonId: twoHoldings.personId,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await checkIn(meetingId, {
          personId: twoHoldings.personId,
          capacity: "PROXY_HOLDER",
        })
      ).statusCode,
    ).toBe(201);

    const meeting = await readMeeting(meetingId);
    // Sofia's vote is in the room and Maja's is not: she came as a proxy holder
    // only.
    expect(lineOf(meeting, soloMember.personId)?.votePresent).toBe(true);
    expect(lineOf(meeting, twoHoldings.personId)?.votePresent).toBe(false);
    expect(ownVotes(meeting).present).toBe(1);
  });

  it("refuses a second member for one proxy holder when the bylaws allow one", async () => {
    /*
     * BRL 9 kap. 14 § 4, last sentence: nobody may represent more than one
     * member as proxy holder unless the bylaws determine otherwise. The default
     * here is one and not the three EFL 6 kap. 5 § allows an economic
     * association generally, which is the exception this Act makes for a
     * housing cooperative.
     */
    const meetingId = await arrangeMeeting();
    expect(
      (
        await registerProxy(meetingId, {
          memberPersonId: soloMember.personId,
          proxyHolderPersonId: twoHoldings.personId,
        })
      ).statusCode,
    ).toBe(201);

    const second = await registerProxy(meetingId, {
      memberPersonId: otherMember.personId,
      proxyHolderPersonId: twoHoldings.personId,
    });
    expect(second.statusCode).toBe(403);
    expect(second.json<{ reason: string }>().reason).toBe(
      "proxy-holder-limit-reached",
    );
  });

  it("allows the second when the bylaws say two", async () => {
    /*
     * The other half of the same rule, and the reason both halves are here: a
     * suite that asserted only the refusal would pass against an implementation
     * that refused every second authorisation whatever the bylaws said, which is
     * the platform overriding the association's own clause.
     */
    await setBylaws({ maxMembersPerProxyHolder: 2 });
    try {
      const meetingId = await arrangeMeeting();
      expect(
        (
          await registerProxy(meetingId, {
            memberPersonId: soloMember.personId,
            proxyHolderPersonId: twoHoldings.personId,
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await registerProxy(meetingId, {
            memberPersonId: otherMember.personId,
            proxyHolderPersonId: twoHoldings.personId,
          })
        ).statusCode,
      ).toBe(201);

      expect(
        (
          await checkIn(meetingId, {
            personId: twoHoldings.personId,
            capacity: "PROXY_HOLDER",
          })
        ).statusCode,
      ).toBe(201);

      // Two absent members' votes in the room, carried by one person.
      const meeting = await readMeeting(meetingId);
      expect(ownVotes(meeting).present).toBe(2);
    } finally {
      await setBylaws({});
    }
  });

  it("refuses a proxy holder who is not a member on the ground that they are one", async () => {
    // BRL 9 kap. 14 § 4's first limb, which is the one the register can decide.
    const meetingId = await arrangeMeeting();
    const response = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: lodger.personId,
      ground: "MEMBER",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe(
      "proxy-holder-not-a-member",
    );
  });

  it("takes the same non-member as the member's spouse or cohabitant", async () => {
    /*
     * The limb the platform cannot decide and must not refuse. BRL 9 kap. 14 § 4
     * permits the member's spouse or cohabitant outright, and nothing here
     * records who is married to whom - one inferred from a shared residency
     * would be wrong about siblings and lodgers alike. So the board's statement
     * is what the row carries.
     *
     * The same person the previous case refused, which is what makes this an
     * assertion about the ground rather than about the person.
     */
    const meetingId = await arrangeMeeting();
    const response = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: lodger.personId,
      ground: "SPOUSE_OR_COHABITANT",
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ ground: string }>().ground).toBe(
      "SPOUSE_OR_COHABITANT",
    );
  });

  it("refuses a bylaws ground until the association has recorded the clause", async () => {
    const meetingId = await arrangeMeeting();
    const refused = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: lodger.personId,
      ground: "BYLAWS",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ reason: string }>().reason).toBe(
      "proxy-holder-not-permitted-by-bylaws",
    );

    await setBylaws({ proxyHolderEligibilityWidened: true });
    try {
      const accepted = await registerProxy(meetingId, {
        memberPersonId: soloMember.personId,
        proxyHolderPersonId: lodger.personId,
        ground: "BYLAWS",
      });
      expect(accepted.statusCode).toBe(201);
    } finally {
      await setBylaws({});
    }
  });

  it("keeps the first authority when a member appoints somebody else", async () => {
    /*
     * EFL 6 kap. 4 § forsta stycket allows a member no more than one proxy
     * holder, so a member naming a second one is replacing the first. The first
     * row is kept with a withdrawal date rather than overwritten, and that is
     * the whole reason the table is keyed on the pair: the proxy holder who
     * held somebody's vote for a while has an access request of their own, and
     * this table is the only place that fact lives - the registration entry
     * names the member, not the holder.
     */
    const meetingId = await arrangeMeeting();
    const first = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: twoHoldings.personId,
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json<{ id: string }>().id;

    const second = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: jointFirst.personId,
    });
    expect(second.statusCode).toBe(201);

    const meeting = await readMeeting(meetingId);
    const held = meeting.proxyAuthorisations.filter(
      (row) => row.memberPersonId === soloMember.personId,
    );
    // Two rows: the first proxy holder's, withdrawn and kept, and the second's.
    expect(held).toHaveLength(2);
    const replaced = held.find((row) => row.id === firstId);
    expect(replaced?.proxyHolderPersonId).toBe(twoHoldings.personId);
    expect(replaced?.withdrawnAt).not.toBeNull();
    const standing = held.find((row) => row.id !== firstId);
    expect(standing?.proxyHolderPersonId).toBe(jointFirst.personId);
    expect(standing?.withdrawnAt).toBeNull();

    /*
     * Only the second proxy holder can exercise the vote. Asserted because the
     * point of keeping the first row is the record, never a second live
     * authority: two standing rows would put two representatives on a line
     * carrying one vote.
     */
    expect(
      (
        await checkIn(meetingId, {
          personId: twoHoldings.personId,
          capacity: "PROXY_HOLDER",
        })
      ).statusCode,
    ).toBe(403);

    // The withdrawal is its own entry, with the member as the subject and a note
    // that it was superseded rather than simply taken back.
    const entry = await prisma.auditLogEntry.findFirst({
      where: { action: "MEETING_PROXY_WITHDRAWN", targetId: firstId },
      select: { actorPersonId: true, targetPersonId: true, context: true },
    });
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.targetPersonId).toBe(soloMember.personId);
    expect(entry?.context).toMatchObject({ superseded: true });
  });

  it("leaves one standing authorisation when two registrations race", async () => {
    /*
     * EFL 6 kap. 4 § forsta stycket allows a member no more than one proxy
     * holder, and that rule is over the authorisations standing at any moment
     * rather than over any row - so no index can state it, not even a partial
     * one, and the check is a read before a write.
     *
     * Two board members naming different holders for one member at the same
     * instant would each read no standing authorisation and each write one,
     * because the unique key includes the holder and neither insert collides.
     * The member would end the meeting with two people entitled to cast their
     * single vote, and the register would pick one of them - a decision no rule
     * here made. The advisory lock in `proxy-lock.ts` is what serialises it.
     *
     * Driven as two requests in flight together rather than one after the other,
     * because a sequence cannot fail this way however often it is run.
     */
    const meetingId = await arrangeMeeting();
    const [first, second] = await Promise.all([
      registerProxy(meetingId, {
        memberPersonId: soloMember.personId,
        proxyHolderPersonId: twoHoldings.personId,
      }),
      registerProxy(meetingId, {
        memberPersonId: soloMember.personId,
        proxyHolderPersonId: jointFirst.personId,
      }),
    ]);

    // Both are accepted: the second is a replacement, which is a lawful act.
    expect(first?.statusCode).toBe(201);
    expect(second?.statusCode).toBe(201);

    const standing = await prisma.proxyAuthorisation.findMany({
      where: {
        meetingId,
        memberPersonId: soloMember.personId,
        withdrawnAt: null,
      },
      select: { proxyHolderPersonId: true },
    });
    // One standing, whichever of the two won the lock, and the other kept with
    // its withdrawal date.
    expect(standing).toHaveLength(1);
    const all = await prisma.proxyAuthorisation.findMany({
      where: { meetingId, memberPersonId: soloMember.personId },
      select: { withdrawnAt: true },
    });
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.withdrawnAt !== null)).toHaveLength(1);
  });

  it("takes a member re-appointing a proxy holder they had withdrawn on one row", async () => {
    // The sign-up's pattern, applied where it fits: to the row that person
    // already has, rather than across two people.
    const meetingId = await arrangeMeeting();
    const created = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: twoHoldings.personId,
    });
    const authorisationId = created.json<{ id: string }>().id;
    await inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/proxy-authorisations/${authorisationId}/withdrawal`,
      headers: { cookie: boardCookie },
    });

    const again = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: twoHoldings.personId,
    });
    expect(again.statusCode).toBe(201);
    expect(again.json<{ id: string }>().id).toBe(authorisationId);
    expect(again.json<{ withdrawnAt: string | null }>().withdrawnAt).toBeNull();

    const meeting = await readMeeting(meetingId);
    expect(
      meeting.proxyAuthorisations.filter(
        (row) => row.memberPersonId === soloMember.personId,
      ),
    ).toHaveLength(1);
  });

  it("refuses an authority older than the year the statute allows", async () => {
    // EFL 6 kap. 4 § andra stycket: a proxy authorisation holds for at most one
    // year from the day it was issued.
    const meetingId = await arrangeMeeting();
    const response = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: twoHoldings.personId,
      authorisedOn: STALE_AUTHORITY_TEXT,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "proxy-authority-expired",
    );
  });

  it("stops counting a vote once the authority is taken back", async () => {
    const meetingId = await arrangeMeeting();
    const created = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: twoHoldings.personId,
    });
    expect(created.statusCode).toBe(201);
    const authorisationId = created.json<{ id: string }>().id;
    expect(
      (
        await checkIn(meetingId, {
          personId: twoHoldings.personId,
          capacity: "PROXY_HOLDER",
        })
      ).statusCode,
    ).toBe(201);
    expect(
      lineOf(await readMeeting(meetingId), soloMember.personId)?.votePresent,
    ).toBe(true);

    const withdrawn = await inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/proxy-authorisations/${authorisationId}/withdrawal`,
      headers: { cookie: boardCookie },
    });
    expect(withdrawn.statusCode).toBe(201);

    const meeting = await readMeeting(meetingId);
    expect(lineOf(meeting, soloMember.personId)?.votePresent).toBe(false);
    // The proxy holder is still in the room and exercising nothing, which is
    // what the chair has to be told at the door.
    expect(meeting.votingRegister.proxyHoldersWithoutVote).toContain(
      twoHoldings.personId,
    );
  });
});

describe("the agenda and what the meeting decided", () => {
  it("numbers the agenda from the order the board states", async () => {
    const meetingId = await arrangeMeeting();
    const response = await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda`,
      payload: {
        items: [
          { title: "Val av ordforande vid stamman" },
          { title: "Faststallande av rostlangd" },
          { title: "Styrelsens arsredovisning" },
        ],
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json<{ position: number; title: string }[]>()
        .map((item) => [item.position, item.title]),
    ).toEqual([
      [1, "Val av ordforande vid stamman"],
      [2, "Faststallande av rostlangd"],
      [3, "Styrelsens arsredovisning"],
    ]);
  });

  it("minutes a decision only once the meeting has been held", async () => {
    /*
     * A decision recorded against a meeting that has not happened is not a
     * minute. It is also what keeps the agenda's own rewrite from discarding
     * one: the agenda may be replaced while the meeting is being arranged, and
     * that would take a decision with it.
     */
    const meetingId = await arrangeMeeting();
    await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda`,
      payload: { items: [{ title: "Ansvarsfrihet for styrelsen" }] },
      headers: { cookie: boardCookie },
    });
    const [item] = (await readMeeting(meetingId)).agenda;
    if (item === undefined) {
      throw new Error("The agenda was not written.");
    }

    const early = await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda/${item.id}/decision`,
      payload: {
        outcome: "CARRIED",
        votesFor: 12,
        votesAgainst: 1,
        votesAbstaining: 9,
        closedBallot: false,
      },
      headers: { cookie: boardCookie },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ reason: string }>().reason).toBe("meeting-not-held");

    const held = await inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/conclusion`,
      headers: { cookie: boardCookie },
    });
    expect(held.statusCode).toBe(201);
    expect(held.json<MeetingSummaryView>().concludedAt).not.toBeNull();

    const recorded = await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda/${item.id}/decision`,
      payload: {
        outcome: "CARRIED",
        votesFor: 12,
        votesAgainst: 1,
        votesAbstaining: 9,
        closedBallot: true,
      },
      headers: { cookie: boardCookie },
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json<{ decision: unknown }>().decision).toMatchObject({
      outcome: "CARRIED",
      votesFor: 12,
      votesAgainst: 1,
      votesAbstaining: 9,
      closedBallot: true,
      recordedByPersonId: board.personId,
    });

    // Corrected in place, one decision per item: a chair who mis-keyed a count
    // has to be able to fix it, and what stands is the signed protokoll.
    const corrected = await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda/${item.id}/decision`,
      payload: {
        outcome: "REJECTED",
        votesFor: 2,
        votesAgainst: 11,
        votesAbstaining: 9,
        closedBallot: true,
      },
      headers: { cookie: boardCookie },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json<{ decision: unknown }>().decision).toMatchObject({
      outcome: "REJECTED",
      votesFor: 2,
    });

    /*
     * Both figures are in the log, which is where a correction leaves what it
     * replaced: the row afterwards says only what stands now.
     */
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "MEETING_DECISION_RECORDED", targetId: item.id },
      orderBy: [{ createdAt: "asc" }],
      select: { actorPersonId: true, targetPersonId: true, context: true },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.actorPersonId).toBe(board.personId);
    // No subject: what the meeting resolved is the association's business and
    // not an act about a person.
    expect(entries[0]?.targetPersonId).toBeNull();
    expect(entries[0]?.context).toMatchObject({ votesFor: 12 });
    expect(entries[1]?.context).toMatchObject({ votesFor: 2 });
  });

  it("refuses a second conclusion and refuses an agenda after it", async () => {
    const meetingId = await arrangeMeeting();
    expect(
      (
        await inject({
          method: "POST",
          url: `/api/meetings/${meetingId}/conclusion`,
          headers: { cookie: boardCookie },
        })
      ).statusCode,
    ).toBe(201);

    const again = await inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/conclusion`,
      headers: { cookie: boardCookie },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe(
      "meeting-already-held",
    );

    const agenda = await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda`,
      payload: { items: [{ title: "Nagot efterat" }] },
      headers: { cookie: boardCookie },
    });
    expect(agenda.statusCode).toBe(409);
  });
});

describe("what running a meeting records", () => {
  it("names the person present as the subject and the board as the actor", async () => {
    /*
     * The split that makes an access report answerable. Being recorded as
     * present is an act about the person, so they are the subject; arranging the
     * meeting is the association's own act and names none.
     */
    const meetingId = await arrangeMeeting();
    await checkIn(meetingId, {
      personId: soloMember.personId,
      capacity: "MEMBER",
    });

    const attendance = await prisma.auditLogEntry.findFirst({
      where: {
        action: "MEETING_ATTENDANCE_RECORDED",
        targetPersonId: soloMember.personId,
      },
      orderBy: [{ createdAt: "desc" }],
      select: { actorPersonId: true, targetKind: true, context: true },
    });
    expect(attendance?.actorPersonId).toBe(board.personId);
    expect(attendance?.targetKind).toBe("meetingAttendance");
    expect(attendance?.context).toMatchObject({ capacity: "MEMBER" });

    const arranged = await prisma.auditLogEntry.findFirst({
      where: { action: "MEETING_ARRANGED", targetId: meetingId },
      select: { actorPersonId: true, targetPersonId: true },
    });
    expect(arranged?.actorPersonId).toBe(board.personId);
    expect(arranged?.targetPersonId).toBeNull();
  });

  it("names the member who gave the authority as the subject", async () => {
    /*
     * It is their voting right that somebody else will exercise, so their own
     * access report is where that has to be visible. The proxy holder reaches
     * their own report through the authorisation's section, which answers for
     * both roles - the log has one subject column and this is the one that
     * belongs in it.
     */
    const meetingId = await arrangeMeeting();
    const created = await registerProxy(meetingId, {
      memberPersonId: soloMember.personId,
      proxyHolderPersonId: twoHoldings.personId,
    });
    expect(created.statusCode).toBe(201);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "MEETING_PROXY_REGISTERED",
        targetId: created.json<{ id: string }>().id,
      },
      select: { actorPersonId: true, targetPersonId: true, context: true },
    });
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.targetPersonId).toBe(soloMember.personId);
    expect(entry?.context).toMatchObject({ ground: "MEMBER" });
  });

  it("records the agenda as a count and never as its text", async () => {
    // The log is append-only and exempt from every purge, so text copied into it
    // would outlive the row it came from.
    const meetingId = await arrangeMeeting();
    await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda`,
      payload: {
        items: [{ title: "Motion om laddstolpar" }, { title: "Ovriga fragor" }],
      },
      headers: { cookie: boardCookie },
    });

    const entry = await prisma.auditLogEntry.findFirst({
      where: { action: "MEETING_AGENDA_SET", targetId: meetingId },
      select: { context: true },
    });
    expect(entry?.context).toEqual({ itemCount: 2 });
    expect(JSON.stringify(entry?.context)).not.toContain("laddstolpar");
  });
});
