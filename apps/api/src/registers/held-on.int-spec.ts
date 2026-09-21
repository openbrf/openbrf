import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppModule } from "../app.module";
import { PrincipalService } from "../authorization/principal.service";
import { PrismaService } from "../database/prisma.service";
import { MailService } from "../mail/mail.service";
import { MoveService } from "../moves/move.service";
import { BoardPositionService } from "../roles/board-position.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { MemberRegisterService } from "./member-register.service";

/**
 * Who holds a residency or a seat on a day, against a real database.
 *
 * A residency is held from its move-in date up to the day before its move-out
 * date, and a board seat from its election date up to the day before its end
 * date - both read on the association's calendar, because every one of those
 * columns is a `@db.Date`. The move flow and the board-position API both accept
 * a date ahead of today, so a buyer recorded before the day they take over the
 * apartment, or a board member recorded before the day their term starts, is a
 * row the readers meet in ordinary use.
 *
 * The clock is set to half past midnight on the 22nd of June here, which is
 * still the 21st in UTC (CEST). An answer read off the UTC day, or off the
 * instant itself, is a day out at that moment and right for the other
 * twenty-two hours; only a clock set to the boundary tells the two apart.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let principals: PrincipalService;
let moves: MoveService;
let seats: BoardPositionService;
let memberRegister: MemberRegisterService;

const suffix = runSuffix();

/** 00:30 on the 22nd of June in Stockholm; 22:30 on the 21st in UTC. */
const AFTER_MIDNIGHT = new Date("2026-06-21T22:30:00.000Z");
const TODAY = "2026-06-22";
const TOMORROW = "2026-06-23";
const LONG_AGO = "2026-01-01";

const addressId = `held-address-${suffix}`;

const persons = {
  /** Records the moves and the elections. */
  board: `held-board-${suffix}`,
  /** Moved in as a member from tomorrow, through the move flow. */
  buyer: `held-buyer-${suffix}`,
  /** Moved in as a member today, which began at local midnight. */
  arrived: `held-arrived-${suffix}`,
  /** A member whose move-out date is today. */
  leaver: `held-leaver-${suffix}`,
  /** A member whose move-out date is tomorrow. */
  stayer: `held-stayer-${suffix}`,
  /** Lived here as a resident until today, and moves back in as a member. */
  returner: `held-returner-${suffix}`,
  /** Elected from tomorrow, through the board-position service. */
  electee: `held-electee-${suffix}`,
  /** Elected today. */
  seated: `held-seated-${suffix}`,
  /** Their term ends today. */
  retiring: `held-retiring-${suffix}`,
} as const;

const apartments = {
  buyer: `held-apartment-a-${suffix}`,
  arrived: `held-apartment-b-${suffix}`,
  leaver: `held-apartment-c-${suffix}`,
  stayer: `held-apartment-d-${suffix}`,
  returner: `held-apartment-e-${suffix}`,
} as const;

const personIds = Object.values(persons);
const surname = `Tilltrade${suffix}`;

/** A `@db.Date` value for an ISO calendar date. */
function column(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A member register row, as the move flow would have written it. */
function registerEvent(
  personId: string,
  apartmentId: string,
  eventType: "ENTRY" | "EXIT",
  eventOn: string,
) {
  return {
    personId,
    apartmentId,
    eventType,
    eventOn: column(eventOn),
    recordedFirstName: personId,
    recordedLastName: surname,
  };
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
  principals = app.get(PrincipalService);
  moves = app.get(MoveService);
  seats = app.get(BoardPositionService);
  memberRegister = app.get(MemberRegisterService);

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Tilltradesgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 930,
    },
  });
  await prisma.apartment.createMany({
    data: Object.values(apartments).map((id, index) => ({
      id,
      addressId,
      number: String(1101 + index),
      floor: 1,
    })),
  });
  await prisma.person.createMany({
    data: personIds.map((id) => ({
      id,
      firstName: id.split("-")[1] ?? "Person",
      lastName: surname,
    })),
  });

  await prisma.residency.createMany({
    data: [
      {
        personId: persons.arrived,
        apartmentId: apartments.arrived,
        role: "MEMBER",
        movedInOn: column(TODAY),
      },
      {
        personId: persons.leaver,
        apartmentId: apartments.leaver,
        role: "MEMBER",
        movedInOn: column(LONG_AGO),
        movedOutOn: column(TODAY),
      },
      {
        personId: persons.stayer,
        apartmentId: apartments.stayer,
        role: "MEMBER",
        movedInOn: column(LONG_AGO),
        movedOutOn: column(TOMORROW),
      },
      {
        personId: persons.returner,
        apartmentId: apartments.returner,
        role: "RESIDENT",
        movedInOn: column(LONG_AGO),
        movedOutOn: column(TODAY),
      },
    ],
  });
  await prisma.memberRegisterEntry.createMany({
    data: [
      registerEvent(persons.arrived, apartments.arrived, "ENTRY", TODAY),
      registerEvent(persons.leaver, apartments.leaver, "ENTRY", LONG_AGO),
      registerEvent(persons.leaver, apartments.leaver, "EXIT", TODAY),
      registerEvent(persons.stayer, apartments.stayer, "ENTRY", LONG_AGO),
      registerEvent(persons.stayer, apartments.stayer, "EXIT", TOMORROW),
    ],
  });
  await prisma.boardPosition.createMany({
    data: [
      {
        personId: persons.board,
        position: "CHAIR",
        electedOn: column(LONG_AGO),
      },
      {
        personId: persons.seated,
        position: "BOARD_MEMBER",
        electedOn: column(TODAY),
      },
      {
        personId: persons.retiring,
        position: "BOARD_MEMBER",
        electedOn: column(LONG_AGO),
        endedOn: column(TODAY),
      },
    ],
  });
});

afterAll(async () => {
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  // The member register and the audit log are append-only, so the persons and
  // apartments they name stay with them.
  await app.close();
});

beforeEach(() => {
  // Date alone: the database driver's timers keep running on the real clock.
  vi.useFakeTimers({ toFake: ["Date"], now: AFTER_MIDNIGHT });
  vi.spyOn(app.get(MailService), "send").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a residency, as the principal reads it", () => {
  it("does not make somebody moved in from tomorrow a resident today", async () => {
    // The move flow takes the date as given: nothing refuses a move-in ahead
    // of today, which is how a buyer is recorded before they take over.
    await moves.moveIn({
      actorPersonId: persons.board,
      personId: persons.buyer,
      apartmentId: apartments.buyer,
      role: "MEMBER",
      movedInOn: TOMORROW,
    });

    const principal = await principals.forPerson(persons.buyer);

    expect(principal).toMatchObject({
      isResident: false,
      isMember: false,
    });
    // Nothing but the record of their own that every account manages.
    expect([...(principal?.capabilities ?? [])]).toEqual(["self:manage"]);
  });

  it("makes somebody moved in today a resident from the association's midnight", async () => {
    const principal = await principals.forPerson(persons.arrived);

    expect(principal).toMatchObject({ isResident: true, isMember: true });
  });

  it("ends a residency at the association's midnight on its move-out date", async () => {
    const principal = await principals.forPerson(persons.leaver);

    expect(principal).toMatchObject({ isResident: false, isMember: false });
  });

  it("keeps a residency whose move-out date is tomorrow", async () => {
    const principal = await principals.forPerson(persons.stayer);

    expect(principal).toMatchObject({ isResident: true, isMember: true });
  });
});

describe("a board seat, as the principal reads it", () => {
  it("does not seat somebody elected from tomorrow", async () => {
    // Accepted as given, like a move-in: the election is minuted ahead of the
    // day the term starts.
    await seats.elect(
      {
        personId: persons.electee,
        position: "DEPUTY_BOARD_MEMBER",
        electedOn: TOMORROW,
        actorPersonId: persons.board,
      },
      AFTER_MIDNIGHT,
    );

    const principal = await principals.forPerson(persons.electee);

    expect(principal?.isBoardMember).toBe(false);
    expect([...(principal?.capabilities ?? [])]).toEqual(["self:manage"]);
  });

  it("seats somebody elected today from the association's midnight", async () => {
    const principal = await principals.forPerson(persons.seated);

    expect(principal?.isBoardMember).toBe(true);
  });

  it("ends a seat at the association's midnight on its end date", async () => {
    const principal = await principals.forPerson(persons.retiring);

    expect(principal?.isBoardMember).toBe(false);
  });
});

describe("the member register's current extract", () => {
  async function currentRows() {
    const extract = await memberRegister.extract({
      actorPersonId: persons.board,
      scope: "current",
      now: AFTER_MIDNIGHT,
    });
    return extract.rows.filter((row) =>
      (personIds as readonly string[]).includes(row.personId),
    );
  }

  it("leaves out a member whose entry is dated tomorrow", async () => {
    // The buyer above: the move flow wrote their ENTRY with tomorrow's date.
    const rows = await currentRows();

    expect(rows.map((row) => row.personId)).not.toContain(persons.buyer);
  });

  it("leaves out a member whose exit is dated today", async () => {
    const rows = await currentRows();

    expect(rows.map((row) => row.personId)).not.toContain(persons.leaver);
  });

  it("lists a member who entered today", async () => {
    const rows = await currentRows();

    expect(rows.map((row) => row.personId)).toContain(persons.arrived);
  });

  it("states the apartment a member holds until a move-out still to come", async () => {
    const rows = await currentRows();
    const stayer = rows.find((row) => row.personId === persons.stayer);

    expect(stayer?.apartments.map((apartment) => apartment.id)).toEqual([
      apartments.stayer,
    ]);
  });
});

describe("moving back in", () => {
  it("accepts a move-in on the day an earlier residency on the apartment ended", async () => {
    // A partner who lived here becomes a joint holder: the residency as a
    // resident ends today and the one as a member begins today. The move-out
    // date is the first day the first is no longer held, so no day is held
    // twice.
    await moves.moveIn({
      actorPersonId: persons.board,
      personId: persons.returner,
      apartmentId: apartments.returner,
      role: "MEMBER",
      movedInOn: TODAY,
    });

    const principal = await principals.forPerson(persons.returner);

    expect(principal).toMatchObject({ isResident: true, isMember: true });
  });
});
