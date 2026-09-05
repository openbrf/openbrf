import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { localDayOf } from "../bookings/stockholm-calendar";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { QueuedMotionView } from "../motions/motion.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { MeetingNoticeMailerService } from "./meeting-notice-mailer.service";
import type { MeetingNoticeView } from "./meeting-notice.service";
import type { MeetingSummaryView, MeetingView } from "./meeting.service";

/**
 * The notice (kallelse), and the link from a motion to the meeting it is taken
 * up at, against a real database.
 *
 * Five properties, and four of them are the statute rather than product
 * behaviour.
 *
 * A notice states the matters to be dealt with (EFL 6 kap. 22 §), so a meeting
 * with no agenda cannot be summoned, and once the notice has been issued the agenda
 * is what it stated: setting it again is refused, because EFL 6 kap. 25 § leaves
 * a meeting unable to decide a matter the notice did not take up.
 *
 * The ledger holds one row per member, written in the transaction that issued
 * the notice - including a member the association holds no address for, who is
 * failed under a code of their own rather than left out. A summons the platform
 * could not deliver is exactly what the board has to see.
 *
 * A failure is recorded on the row and never rolls the notice back. The meeting
 * has been summoned; one address that did not work is a fact for the board to
 * act on.
 *
 * A motion may be put to a meeting while that meeting is still being arranged,
 * and not afterwards: not to one whose notice has been issued, and not to one
 * recorded as held.
 *
 * And the audiences are split at the controller: the board reaches both routes,
 * a resident reaches neither.
 *
 * ## Why the assertions filter the register
 *
 * The recipients are read out of the member register, which is the association's
 * whole membership - so the ledger carries every person any suite has ever
 * entered into this shared database. Nothing here asserts a total; every count
 * is over this run's own people, which is what makes the assertions about the
 * rules rather than about which suite ran first.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `mn-address-${suffix}`;
const apartments = {
  first: `mn-apartment-a-${suffix}`,
  second: `mn-apartment-b-${suffix}`,
  third: `mn-apartment-c-${suffix}`,
  fourth: `mn-apartment-d-${suffix}`,
};

/** A member with an address, who also submits the motion. */
const author = {
  personId: `mn-author-${suffix}`,
  email: `mn-author-${suffix}@exempel.se`,
};
/** A second member with an address. */
const other = {
  personId: `mn-other-${suffix}`,
  email: `mn-other-${suffix}@exempel.se`,
};
/**
 * A member the association holds no email address for.
 *
 * No account either, deliberately: this is somebody the board knows from the
 * register and cannot reach electronically, which is the case the ledger has to
 * be able to report.
 */
const unreachable = { personId: `mn-unreachable-${suffix}` };
/** Lives in the house and holds no tenant-ownership. */
const resident = {
  personId: `mn-resident-${suffix}`,
  email: `mn-resident-${suffix}@exempel.se`,
};
const board = {
  personId: `mn-board-${suffix}`,
  email: `mn-board-${suffix}@exempel.se`,
};

const withAccounts = [author, other, resident, board];
const personIds = [
  ...withAccounts.map((one) => one.personId),
  unreachable.personId,
];
const memberIds = [author.personId, other.personId, unreachable.personId];

/** Every meeting and motion this run wrote, so afterAll can clear them. */
const createdMeetingIds: string[] = [];
const createdMotionIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The day the meetings are held on.
 *
 * Six weeks ahead rather than a literal date, for the reason every other suite
 * anchors its fixtures relative to now: this database is shared and a literal
 * would drift. Ahead of today because a meeting is summoned before it is held,
 * which is the ordinary case EFL 6 kap. 17 § assumes.
 */
const MEETING_DAY_TEXT = new Date(Date.now() + 42 * DAY_MS)
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
        // 10.39.0.0/16 is this suite's; the others each hold their own second
        // octet. 10.40.0.1 to 10.40.0.4 are reserved for the screenshot walk's
        // four actors and must never be taken by an integration subnet.
        "x-forwarded-for": `10.39.${String(subnet)}.${String(host + 1)}`,
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

/** Arranges a meeting with an agenda, which is the state a notice needs. */
async function arrangeMeeting(items = ["Stammans oppnande"]): Promise<string> {
  const arranged = await inject({
    method: "POST",
    url: "/api/meetings",
    payload: { kind: "ORDINARY", heldOn: MEETING_DAY_TEXT },
    headers: { cookie: boardCookie },
  });
  expect(arranged.statusCode).toBe(201);
  const meetingId = arranged.json<MeetingSummaryView>().id;
  createdMeetingIds.push(meetingId);

  if (items.length > 0) {
    const agenda = await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda`,
      payload: { items: items.map((title) => ({ title })) },
      headers: { cookie: boardCookie },
    });
    expect(agenda.statusCode).toBe(200);
  }
  return meetingId;
}

function issueNotice(
  meetingId: string,
  payload: {
    startsAt?: string;
    place?: string;
    digitalParticipation?: string | null;
  } = {},
  cookie?: string,
) {
  return inject({
    method: "POST",
    url: `/api/meetings/${meetingId}/notice`,
    payload: {
      startsAt: "18:30",
      place: "Foreningslokalen",
      digitalParticipation: null,
      ...payload,
    },
    headers: { cookie: cookie ?? boardCookie },
  });
}

function setMotionMeeting(
  motionId: string,
  meetingId: string | null,
  cookie?: string,
) {
  return inject({
    method: "PUT",
    url: `/api/motion-queue/${motionId}/meeting`,
    payload: { meetingId },
    headers: { cookie: cookie ?? boardCookie },
  });
}

async function submitMotion(title: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/motions",
    payload: { title, body: "Styrelsen bor utreda saken." },
    headers: { cookie: authorCookie },
  });
  expect(response.statusCode).toBe(201);
  const { id } = response.json<{ id: string }>();
  createdMotionIds.push(id);
  return id;
}

/** This run's own rows in one notice's ledger. */
async function ownLedger(noticeId: string) {
  return prisma.meetingNoticeDelivery.findMany({
    where: { noticeId, personId: { in: personIds } },
    orderBy: { personId: "asc" },
  });
}

/**
 * How many transactions hold, or are queued behind, this meeting's agenda key.
 *
 * `hashtext` gives a signed int4 and the advisory lock space addresses it as two
 * halves of a bigint, which is what the shifting reassembles. The key is spelled
 * out here rather than imported, so a writer that quietly changed it would fail
 * this assertion instead of passing under a new name.
 */
async function agendaLockCount(
  meetingId: string,
  granted: boolean,
): Promise<bigint> {
  const key = `meeting-agenda:${meetingId}`;
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
  throw new Error("The condition did not hold within the time allowed.");
}

let boardCookie = "";
let authorCookie = "";
let residentCookie = "";
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
      street: "Kallelsegatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartments.first, addressId, number: "2101", floor: 1 },
      { id: apartments.second, addressId, number: "2102", floor: 1 },
      { id: apartments.third, addressId, number: "2201", floor: 2 },
      { id: apartments.fourth, addressId, number: "2202", floor: 2 },
    ],
  });

  for (const person of [
    { ...author, firstName: "Astrid", lastName: "Motionar" },
    { ...other, firstName: "Olof", lastName: "Medlem" },
    { ...resident, firstName: "Rut", lastName: "Inneboende" },
    { ...board, firstName: "Bea", lastName: "Ordforande" },
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

  // No address and no account: a member the board can only reach on paper.
  await prisma.person.create({
    data: {
      id: unreachable.personId,
      firstName: "Ulla",
      lastName: "Utanadress",
    },
  });

  const movedInOn = new Date(Date.now() - 400 * DAY_MS);
  await prisma.residency.createMany({
    data: [
      {
        personId: author.personId,
        apartmentId: apartments.first,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: other.personId,
        apartmentId: apartments.second,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: unreachable.personId,
        apartmentId: apartments.third,
        role: "MEMBER",
        movedInOn,
      },
      {
        personId: resident.personId,
        apartmentId: apartments.first,
        role: "RESIDENT",
        movedInOn,
      },
    ],
  });

  /*
   * The member register is what the recipients are read out of. One ENTRY per
   * membership, as a move-in as a member writes. These rows are never deleted:
   * the archive refuses UPDATE and DELETE for every caller, so this suite leaves
   * them and the people they name behind - which is why nothing here asserts a
   * total over the register or over a ledger.
   */
  await prisma.memberRegisterEntry.createMany({
    data: [
      {
        personId: author.personId,
        apartmentId: apartments.first,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Astrid",
        recordedLastName: "Motionar",
      },
      {
        personId: other.personId,
        apartmentId: apartments.second,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Olof",
        recordedLastName: "Medlem",
      },
      {
        personId: unreachable.personId,
        apartmentId: apartments.third,
        eventType: "ENTRY",
        eventOn: movedInOn,
        recordedFirstName: "Ulla",
        recordedLastName: "Utanadress",
      },
    ],
  });

  /*
   * The board member holds no tenant-ownership, deliberately: `meetings:manage`
   * and `motions:handle` are the board's office rather than a member's right, so
   * a board member who is not a member must still reach both routes.
   */
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date(Date.now() - 200 * DAY_MS),
    },
  });

  boardCookie = await signIn(board.email);
  authorCookie = await signIn(author.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

/*
 * Cleanup in a try and the close in a finally, for the reason the meetings suite
 * gives: a beforeAll that failed part-way leaves rows this suite has to remove
 * and rows it never wrote, and one throw here would take the rest of the cleanup
 * with it and never reach app.close().
 */
afterAll(async () => {
  try {
    if (prisma !== undefined) {
      /*
       * The motions let go of their meetings first. The foreign key restricts
       * rather than nulls - nothing deletes a meeting in the product - so a
       * motion still pointing at one would veto the delete below.
       */
      await prisma.motion.updateMany({
        where: { id: { in: createdMotionIds } },
        data: { meetingId: null },
      });
      await prisma.motion.deleteMany({
        where: { id: { in: createdMotionIds } },
      });
      // Every child holds its meeting down: the foreign keys restrict rather
      // than cascade, so the meeting deletes only once the agenda and the
      // notice are gone. The notice's delivery ledger goes with the notice.
      await prisma.agendaItem.deleteMany({
        where: { meetingId: { in: createdMeetingIds } },
      });
      await prisma.meetingNotice.deleteMany({
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
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      /*
       * The persons, the apartments and the address stay, for the reason the
       * meetings suite gives: every one of them is named by a member register
       * entry, and the archive refuses DELETE for every caller.
       */
      if (associationCreatedHere) {
        await prisma.association.deleteMany({ where: { id: 1 } });
      }
    }
  } finally {
    await app?.close();
  }
}, 120_000);

describe("who reaches the notice and the linkage", () => {
  it("refuses a request with no session", async () => {
    const meetingId = await arrangeMeeting();
    const response = await inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/notice`,
      payload: { startsAt: "18:30", place: "X", digitalParticipation: null },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident both routes", async () => {
    const meetingId = await arrangeMeeting();
    const motionId = await submitMotion("Cykelrum");

    expect((await issueNotice(meetingId, {}, residentCookie)).statusCode).toBe(
      403,
    );
    expect(
      (await setMotionMeeting(motionId, meetingId, residentCookie)).statusCode,
    ).toBe(403);
  });
});

describe("issuing the notice", () => {
  it("writes one ledger row per member, pending and by email", async () => {
    const meetingId = await arrangeMeeting(["Stammans oppnande", "Motioner"]);

    const response = await issueNotice(meetingId);
    expect(response.statusCode).toBe(201);
    const notice = response.json<MeetingNoticeView>();

    const ledger = await ownLedger(notice.id);
    expect(ledger.map((row) => row.personId)).toEqual(
      [...memberIds].sort((left, right) => left.localeCompare(right)),
    );
    for (const row of ledger) {
      expect(row.status).toBe("PENDING");
      expect(row.channel).toBe("EMAIL");
      expect(row.failureReason).toBeNull();
      expect(row.sentAt).toBeNull();
    }

    // The resident holds no tenant-ownership, so the register never names them
    // and the notice does not summon them.
    expect(ledger.some((row) => row.personId === resident.personId)).toBe(
      false,
    );
  });

  /**
   * The time is stated and the day is the meeting's.
   *
   * EFL 6 kap. 22 § has the notice state the time and the place. The day a
   * meeting is held is what decides who has a vote at it, so it stays on the
   * meeting and the notice adds the hour - and the two must not be able to
   * disagree.
   */
  it("puts the stated time on the meeting's own day", async () => {
    const meetingId = await arrangeMeeting();

    const notice = (
      await issueNotice(meetingId, { startsAt: "18:30" })
    ).json<MeetingNoticeView>();

    const day = localDayOf(new Date(notice.startsAt));
    const [year, month, date] = MEETING_DAY_TEXT.split("-").map(Number);
    expect(day).toEqual({ year, month, day: date });
    expect(notice.place).toBe("Foreningslokalen");
    expect(notice.digitalParticipation).toBeNull();
  });

  it("carries the participation instruction for a meeting held digitally", async () => {
    const meetingId = await arrangeMeeting();

    const notice = (
      await issueNotice(meetingId, {
        digitalParticipation: "Lank skickas dagen fore stamman.",
      })
    ).json<MeetingNoticeView>();

    expect(notice.digitalParticipation).toBe(
      "Lank skickas dagen fore stamman.",
    );
  });

  /**
   * A notice states the matters to be dealt with, so a meeting with none cannot
   * be summoned (EFL 6 kap. 22 §).
   */
  it("refuses a meeting with no agenda", async () => {
    const meetingId = await arrangeMeeting([]);

    const response = await issueNotice(meetingId);
    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "meeting-has-no-agenda",
    );

    expect(await prisma.meetingNotice.count({ where: { meetingId } })).toBe(0);
  });

  it("summons a meeting once and refuses a second notice", async () => {
    const meetingId = await arrangeMeeting();
    expect((await issueNotice(meetingId)).statusCode).toBe(201);

    const second = await issueNotice(meetingId);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ reason: string }>().reason).toBe(
      "notice-already-issued",
    );
  });

  it("says on the list that a summoned meeting has been summoned", async () => {
    /*
     * The one fact about a meeting that decides what may still be attached to
     * it, on the answer a caller choosing among meetings reads. EFL 6 kap. 25 §
     * leaves the meeting unable to decide a matter its notice did not take up,
     * so from the moment the notice is issued no motion may be put to that
     * meeting - and the day it is held says nothing about whether that has
     * happened. A list that could not tell the two apart would offer a meeting
     * every write then has to refuse.
     */
    const meetingId = await arrangeMeeting();

    const before = await inject({
      method: "GET",
      url: "/api/meetings",
      headers: { cookie: boardCookie },
    });
    expect(before.statusCode).toBe(200);
    expect(
      before
        .json<MeetingSummaryView[]>()
        .find((meeting) => meeting.id === meetingId)?.summoned,
    ).toBe(false);

    expect((await issueNotice(meetingId)).statusCode).toBe(201);

    const after = await inject({
      method: "GET",
      url: "/api/meetings",
      headers: { cookie: boardCookie },
    });
    expect(
      after
        .json<MeetingSummaryView[]>()
        .find((meeting) => meeting.id === meetingId)?.summoned,
    ).toBe(true);
  });

  it("refuses a meeting already recorded as held", async () => {
    const meetingId = await arrangeMeeting();
    const held = await inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/conclusion`,
      headers: { cookie: boardCookie },
    });
    expect(held.statusCode).toBe(201);

    const response = await issueNotice(meetingId);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe(
      "meeting-already-held",
    );
  });

  /**
   * The notice fixes the agenda.
   *
   * EFL 6 kap. 25 § leaves the meeting unable to decide a matter its notice did
   * not take up without the consent of every member the failure affects, so what
   * the notice stated and what the meeting may deal with have to stay one list.
   */
  it("refuses a rewrite of the agenda once the notice has been issued", async () => {
    const meetingId = await arrangeMeeting(["Stammans oppnande"]);
    expect((await issueNotice(meetingId)).statusCode).toBe(201);

    const response = await inject({
      method: "PUT",
      url: `/api/meetings/${meetingId}/agenda`,
      payload: { items: [{ title: "Nagot helt annat" }] },
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe(
      "notice-already-issued",
    );

    const meeting = (
      await inject({
        method: "GET",
        url: `/api/meetings/${meetingId}`,
        headers: { cookie: boardCookie },
      })
    ).json<MeetingView>();
    expect(meeting.agenda.map((item) => item.title)).toEqual([
      "Stammans oppnande",
    ]);
    expect(meeting.notice?.deliveries.pending).toBeGreaterThan(0);
  });

  /**
   * The same refusal against a notice issued while the rewrite is already in
   * flight.
   *
   * The agenda is a delete and an insert on a table of its own, and the notice
   * is one row on another, so at READ COMMITTED neither transaction collides
   * with the other: a rewrite that read "no notice yet" would replace the items
   * a notice committing a moment later had already summoned the members to, and
   * nothing in the database would refuse it. The board would then hold a list
   * EFL 6 kap. 25 § leaves the meeting unable to decide on.
   *
   * Driven the way the link's own interleaving test is: the key is held by a
   * transaction of this test's own, and the wait is read out of `pg_locks`
   * rather than inferred from a delay.
   */
  it("refuses a rewrite against a notice issued while it was in flight", async () => {
    const meetingId = await arrangeMeeting(["Stammans oppnande"]);

    let releaseHolder = (): void => {
      /* replaced below */
    };
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`meeting-agenda:${meetingId}`}))`;
        await tx.meetingNotice.create({
          data: {
            meetingId,
            startsAt: new Date(`${MEETING_DAY_TEXT}T16:30:00.000Z`),
            place: "Foreningslokalen",
            digitalParticipation: null,
            issuedByPersonId: board.personId,
          },
        });
        await holderDone;
      },
      // The reasoning on the link's interleaving test, and the same numbers.
      { timeout: 60_000, maxWait: 20_000 },
    );

    try {
      await waitFor(async () => (await agendaLockCount(meetingId, true)) > 0n);

      const pending = inject({
        method: "PUT",
        url: `/api/meetings/${meetingId}/agenda`,
        payload: { items: [{ title: "Nagot helt annat" }] },
        headers: { cookie: boardCookie },
      });
      await waitFor(async () => (await agendaLockCount(meetingId, false)) > 0n);

      releaseHolder();
      await holder;

      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json<{ reason: string }>().reason).toBe(
        "notice-already-issued",
      );
      const items = await prisma.agendaItem.findMany({
        where: { meetingId },
        select: { title: true },
      });
      expect(items.map((item) => item.title)).toEqual(["Stammans oppnande"]);
    } finally {
      /*
       * Released and then waited for, so the transaction has committed or
       * rolled back - and let go of the key - before the next test in this
       * shared database asks for it. Its own error is swallowed rather than
       * thrown from a `finally`, which would replace a failed assertion above
       * with a rollback nobody is asking about.
       */
      releaseHolder();
      await holder.catch(() => undefined);
    }
  });

  /**
   * The entry says how many were summoned and by what means, and nothing about
   * who they were: the log is append-only and exempt from every purge.
   */
  it("records the act with a recipient count and no recipient", async () => {
    const meetingId = await arrangeMeeting();
    const notice = (await issueNotice(meetingId)).json<MeetingNoticeView>();

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "MEETING_NOTICE_ISSUED", targetId: meetingId },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.targetPersonId).toBeNull();
    const context = entry?.context as { channel: string; recipients: number };
    expect(context.channel).toBe("EMAIL");
    expect(context.recipients).toBeGreaterThanOrEqual(memberIds.length);
    const written = JSON.stringify(entry?.context);
    for (const personId of memberIds) {
      expect(written).not.toContain(personId);
    }
    expect(written).not.toContain("Foreningslokalen");
    expect(notice.deliveries.pending).toBe(context.recipients);
  });
});

describe("sending the notice", () => {
  /**
   * A copy that could not go out is written on the row, and the notice stands.
   *
   * The member with no address is the case: she is in the ledger deliberately,
   * because a member the platform cannot reach is one the board still has to
   * call (EFL 6 kap. 21 §). Her failure must not take the summons of everybody
   * else with it.
   */
  it("records a failure on the row without rolling the notice back", async () => {
    const meetingId = await arrangeMeeting();
    const notice = (await issueNotice(meetingId)).json<MeetingNoticeView>();

    await app.get(MeetingNoticeMailerService).runSending(notice.id);

    const ledger = await ownLedger(notice.id);
    const failed = ledger.find((row) => row.personId === unreachable.personId);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.failureReason).toBe("no-email-address");
    expect(failed?.sentAt).toBeNull();

    for (const personId of [author.personId, other.personId]) {
      const row = ledger.find((one) => one.personId === personId);
      expect(row?.status).toBe("SENT");
      expect(row?.failureReason).toBeNull();
      expect(row?.sentAt).not.toBeNull();
    }

    // The notice itself is untouched: the meeting has been summoned.
    expect(await prisma.meetingNotice.count({ where: { id: notice.id } })).toBe(
      1,
    );

    const meeting = (
      await inject({
        method: "GET",
        url: `/api/meetings/${meetingId}`,
        headers: { cookie: boardCookie },
      })
    ).json<MeetingView>();
    expect(meeting.notice?.deliveries.unreachedPersonIds).toContain(
      unreachable.personId,
    );
  });

  /**
   * A second run reaches nobody again.
   *
   * The claim is a conditional update from PENDING, so a retried job mails only
   * the rows nobody has claimed - which is what keeps a member from being
   * summoned twice to one meeting.
   */
  it("reaches nobody twice when the sending runs again", async () => {
    const meetingId = await arrangeMeeting();
    const notice = (await issueNotice(meetingId)).json<MeetingNoticeView>();
    const mailer = app.get(MeetingNoticeMailerService);

    const first = await mailer.runSending(notice.id);
    expect(first.sent).toBeGreaterThan(0);
    const after = await ownLedger(notice.id);

    const second = await mailer.runSending(notice.id);
    expect(second).toEqual({ sent: 0, failed: 0 });
    expect(await ownLedger(notice.id)).toEqual(after);
  });
});

describe("the meeting a motion is taken up at", () => {
  it("records the meeting, and shows it to the member who submitted it", async () => {
    const meetingId = await arrangeMeeting();
    const motionId = await submitMotion("Ladda bilen");

    const response = await setMotionMeeting(motionId, meetingId);
    expect(response.statusCode).toBe(200);
    const view = response.json<QueuedMotionView>();
    expect(view.meeting?.id).toBe(meetingId);
    expect(view.meeting?.heldOn).toBe(MEETING_DAY_TEXT);
    expect(view.meeting?.summoned).toBe(false);

    const own = await inject({
      method: "GET",
      url: "/api/motions/mine",
      headers: { cookie: authorCookie },
    });
    const mine = own
      .json<{ motions: QueuedMotionView[] }>()
      .motions.find((one) => one.id === motionId);
    expect(mine?.meeting?.id).toBe(meetingId);
  });

  it("takes the answer back while the meeting is still being arranged", async () => {
    const meetingId = await arrangeMeeting();
    const motionId = await submitMotion("Nya cykelstall");
    expect((await setMotionMeeting(motionId, meetingId)).statusCode).toBe(200);

    const response = await setMotionMeeting(motionId, null);
    expect(response.statusCode).toBe(200);
    expect(response.json<QueuedMotionView>().meeting).toBeNull();
  });

  /**
   * The notice settles which items the meeting deals with.
   *
   * EFL 6 kap. 25 § leaves the meeting unable to decide a matter the notice did
   * not take up, so attaching an item afterwards would claim the meeting could
   * deal with something the members were never called to - and detaching one
   * would leave the platform silent about an item the notice stated. Both are
   * refused.
   */
  it("refuses a meeting whose notice has been issued, and refuses to leave one", async () => {
    const summoned = await arrangeMeeting();
    const later = await arrangeMeeting();
    const attached = await submitMotion("Hyra ut lokalen");
    const loose = await submitMotion("Byta portkod");

    expect((await setMotionMeeting(attached, summoned)).statusCode).toBe(200);
    expect((await issueNotice(summoned)).statusCode).toBe(201);

    const joining = await setMotionMeeting(loose, summoned);
    expect(joining.statusCode).toBe(409);
    expect(joining.json<{ reason: string }>().reason).toBe(
      "meeting-notice-issued",
    );

    const leaving = await setMotionMeeting(attached, later);
    expect(leaving.statusCode).toBe(409);
    expect(leaving.json<{ reason: string }>().reason).toBe(
      "meeting-notice-issued",
    );

    const clearing = await setMotionMeeting(attached, null);
    expect(clearing.statusCode).toBe(409);

    const stored = await prisma.motion.findUnique({
      where: { id: attached },
      select: { meetingId: true },
    });
    expect(stored?.meetingId).toBe(summoned);
  });

  /**
   * The refusal above holds against a notice issued while the request is
   * already in flight, which is the only property here that needs two
   * transactions interleaved.
   *
   * Everything runs at READ COMMITTED. A link that read "no notice yet" and
   * then wrote would attach an item to a meeting whose agenda a notice
   * committing a moment later had already frozen, and nothing in the database
   * would refuse it: the notice is a row in one table and the link is a column
   * on another. EFL 6 kap. 25 § then leaves the meeting unable to decide that
   * matter, so the platform would be holding an item the members were never
   * summoned to - and the board would have been told the item was on the
   * agenda.
   *
   * Driven by holding the agenda key in a transaction of this test's own, which
   * writes the notice and waits, so the link has to queue behind it. The wait is
   * read out of `pg_locks` rather than inferred from a delay, so a link that
   * blocked and one that sailed past the key are told apart by what the
   * database says - and racing two requests instead would pass with no lock at
   * all whenever the two happened not to interleave, which is most of the time.
   */
  it("refuses a notice issued while the link was already in flight", async () => {
    const meetingId = await arrangeMeeting();
    const motionId = await submitMotion("Skotsel av garden");

    let releaseHolder = (): void => {
      /* replaced below */
    };
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    // A transaction that takes the agenda key, issues the notice, and waits.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`meeting-agenda:${meetingId}`}))`;
        await tx.meetingNotice.create({
          data: {
            meetingId,
            startsAt: new Date(`${MEETING_DAY_TEXT}T16:30:00.000Z`),
            place: "Foreningslokalen",
            digitalParticipation: null,
            issuedByPersonId: board.personId,
          },
        });
        await holderDone;
      },
      /*
       * Longer than the wait below is willing to spend. An interactive
       * transaction defaults to five seconds, and this one is held open on
       * purpose while the link queues behind its key - so on the default it
       * would abort before the test let it go, the lock would be released by the
       * rollback, and the link would sail through and be written. The assertion
       * would then fail as though the freeze had not been honoured. The same
       * numbers as the other interleaving tests in this repository.
       */
      { timeout: 60_000, maxWait: 20_000 },
    );

    try {
      await waitFor(async () => (await agendaLockCount(meetingId, true)) > 0n);

      // The link starts now and must block on the key rather than read past it.
      const pending = setMotionMeeting(motionId, meetingId);
      await waitFor(async () => (await agendaLockCount(meetingId, false)) > 0n);

      releaseHolder();
      await holder;

      // Answered only after the notice committed, and answered by the refusal
      // rather than by a link written after the agenda was settled.
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json<{ reason: string }>().reason).toBe(
        "meeting-notice-issued",
      );
      const stored = await prisma.motion.findUnique({
        where: { id: motionId },
        select: { meetingId: true },
      });
      expect(stored?.meetingId).toBeNull();
    } finally {
      /*
       * Released and then waited for, so the transaction has committed or
       * rolled back - and let go of the key - before the next test in this
       * shared database asks for it. Its own error is swallowed rather than
       * thrown from a `finally`, which would replace a failed assertion above
       * with a rollback nobody is asking about.
       */
      releaseHolder();
      await holder.catch(() => undefined);
    }
  });

  /**
   * The withdrawal refusal holds against a withdrawal that lands while the
   * request is already in flight.
   *
   * Taking a motion back is the member's own act in a transaction of its own,
   * and it takes no agenda key - it is about the motion rather than about any
   * meeting's matters. So at READ COMMITTED it can commit after this request
   * read the motion as open and before the write, and a write conditional on
   * the link alone would go through: the board would have recorded that it will
   * take up a request the member had already taken back, and the member's own
   * data subject access report would say so.
   *
   * Driven through the agenda key, which this request takes *after* it reads
   * the motion. Holding the key from a transaction of this test's own therefore
   * parks the request in exactly the window under test - between its read of
   * the motion and its write - and the withdrawal is sent while it waits there.
   * A race would not reach this window reliably at all.
   */
  it("refuses a withdrawal that lands while the link was in flight", async () => {
    const meetingId = await arrangeMeeting();
    const motionId = await submitMotion("Utbyte av tvattmaskiner");

    let releaseHolder = (): void => {
      /* replaced below */
    };
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`meeting-agenda:${meetingId}`}))`;
        await holderDone;
      },
      // The reasoning on the notice's interleaving test, and the same numbers.
      { timeout: 60_000, maxWait: 20_000 },
    );

    try {
      await waitFor(async () => (await agendaLockCount(meetingId, true)) > 0n);

      // Reads the motion as open, then queues on the key.
      const pending = setMotionMeeting(motionId, meetingId);
      await waitFor(async () => (await agendaLockCount(meetingId, false)) > 0n);

      // The member takes it back while the board's request waits.
      const withdrawal = await inject({
        method: "POST",
        url: `/api/motions/${motionId}/withdrawal`,
        headers: { cookie: authorCookie },
      });
      expect(withdrawal.statusCode).toBe(201);

      releaseHolder();
      await holder;

      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json<{ reason: string }>().reason).toBe(
        "motion-withdrawn",
      );
      const stored = await prisma.motion.findUnique({
        where: { id: motionId },
        select: { meetingId: true, status: true },
      });
      expect(stored?.meetingId).toBeNull();
      expect(stored?.status).toBe("WITHDRAWN");
    } finally {
      /*
       * Released and then waited for, so the transaction has committed or
       * rolled back - and let go of the key - before the next test in this
       * shared database asks for it. Its own error is swallowed rather than
       * thrown from a `finally`, which would replace a failed assertion above
       * with a rollback nobody is asking about.
       */
      releaseHolder();
      await holder.catch(() => undefined);
    }
  });

  it("refuses a meeting recorded as held", async () => {
    const meetingId = await arrangeMeeting();
    const motionId = await submitMotion("Male trapphuset");
    expect(
      (
        await inject({
          method: "POST",
          url: `/api/meetings/${meetingId}/conclusion`,
          headers: { cookie: boardCookie },
        })
      ).statusCode,
    ).toBe(201);

    const response = await setMotionMeeting(motionId, meetingId);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe(
      "meeting-already-held",
    );

    const stored = await prisma.motion.findUnique({
      where: { id: motionId },
      select: { meetingId: true },
    });
    expect(stored?.meetingId).toBeNull();
  });

  it("refuses a meeting that does not exist", async () => {
    const motionId = await submitMotion("Sopsortering");

    const response = await setMotionMeeting(motionId, `mn-nothing-${suffix}`);
    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "meeting-not-found",
    );
  });

  /**
   * A motion the member took back is not an item for a meeting. The right in
   * EFL 6 kap. 15 § is theirs to exercise, and taking it back is theirs too.
   */
  it("refuses a motion the member withdrew", async () => {
    const meetingId = await arrangeMeeting();
    const motionId = await submitMotion("Dra tillbaka");
    expect(
      (
        await inject({
          method: "POST",
          url: `/api/motions/${motionId}/withdrawal`,
          headers: { cookie: authorCookie },
        })
      ).statusCode,
    ).toBe(201);

    const response = await setMotionMeeting(motionId, meetingId);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe("motion-withdrawn");
  });

  /**
   * The subject is the member who submitted it, as at acknowledgement: what the
   * board did with somebody's item has to be answerable from their own data
   * subject access report.
   */
  it("records the act against the member who submitted the motion", async () => {
    const meetingId = await arrangeMeeting();
    const motionId = await submitMotion("Ny grill");
    expect((await setMotionMeeting(motionId, meetingId)).statusCode).toBe(200);

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "MOTION_MEETING_SET", targetId: motionId },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.targetPersonId).toBe(author.personId);
    const context = entry?.context as { meetingId: string };
    expect(context.meetingId).toBe(meetingId);
    expect(JSON.stringify(entry?.context)).not.toContain("Ny grill");
  });
});
