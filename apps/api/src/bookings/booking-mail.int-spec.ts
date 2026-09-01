import { Logger } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { MailService, type SendMailInput } from "../mail/mail.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { BookableSlotView, OwnBookingView } from "./booking.service";
import {
  addLocalDays,
  formatLocalDay,
  type LocalDay,
  localDayOf,
} from "./stockholm-calendar";

/**
 * The booking mails, through the real routes.
 *
 * Three properties, none of which the unit tests can show, because all three
 * are about what the request does rather than about what the mailer decides.
 *
 * **A mail server that is down does not fail a booking.** The confirmation is
 * sent after the transaction has committed, so a refusal from the mail layer
 * reaches a booking that already exists. If it were allowed to travel out of
 * the handler the resident would read a failure, press the button again, and be
 * refused for a slot their own booking is holding. Both flows are driven with
 * the mail layer rejecting: the booking is still 201 and still BOOKED, and the
 * cancellation still cancels.
 *
 * **The failure is logged by identifier and never by address.** A mail server
 * quotes the envelope it rejected, and that envelope holds an address decrypted
 * a few lines earlier - so the rejection here carries the resident's real
 * address in its message, and the log line is asserted not to.
 *
 * **The cancellation reaches the household only when somebody else cancelled
 * it, and in the household's own language.** The resident's route and the
 * board's route are the same service method with a different actor, so which of
 * the two sends is proved by driving both.
 *
 * The seam is MailService.send: everything up to it is exercised for real -
 * the transaction, the audit entry, the person lookup and the decryption of the
 * recipient's address - and no SMTP server is involved.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let mail: MailService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `bm-address-${suffix}`;
const apartmentId = `bm-apartment-${suffix}`;
const laundryId = `bm-resource-laundry-${suffix}`;

/**
 * The resident, who reads English.
 *
 * Deliberately not the default: the board member below is left on Swedish, so a
 * cancellation rendered in the actor's language rather than the recipient's
 * would come out in the wrong one and the assertion would catch it.
 */
const resident = {
  personId: `bm-resident-${suffix}`,
  email: `bm-resident-${suffix}@exempel.se`,
  locale: "en",
};
const board = {
  personId: `bm-board-${suffix}`,
  email: `bm-board-${suffix}@exempel.se`,
  locale: "sv",
};
const actors = [resident, board];
const personIds = actors.map((actor) => actor.personId);

/**
 * A rejection shaped like the one that actually happens.
 *
 * A mail server refusing a recipient quotes the envelope back, so the message
 * carries the address the send was given. That is the whole reason the log line
 * names the failure by class and by booking id, and this is what makes the
 * assertion about it mean something.
 */
class EnvelopeRefused extends Error {
  constructor(envelope: string) {
    super(`550 5.1.1 <${envelope}>: recipient rejected`);
    this.name = "EnvelopeRefused";
  }
}

/** The week the bookings are made in: far enough ahead to still be bookable. */
const WEEK: LocalDay = addLocalDays(localDayOf(new Date()), 21);

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST";
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
        // 10.35.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.35.${String(subnet)}.${String(host + 1)}`,
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

/** The slot at a given position of a given day, which every claim starts from. */
async function slotOn(day: LocalDay, index: number): Promise<BookableSlotView> {
  const response = await inject({
    method: "GET",
    url:
      `/api/bookings/resources/${laundryId}/slots` +
      `?from=${formatLocalDay(day)}&to=${formatLocalDay(day)}`,
    headers: { cookie: residentCookie },
  });
  expect(response.statusCode).toBe(200);
  const slots = response.json<BookableSlotView[]>();
  const slot = slots[index];
  if (slot === undefined) {
    throw new Error(
      `The laundry offers no slot ${String(index)} on ${formatLocalDay(day)}.`,
    );
  }
  return slot;
}

/** Books one slot as the resident, and answers with the booking it made. */
async function book(slot: BookableSlotView): Promise<OwnBookingView> {
  const response = await inject({
    method: "POST",
    url: "/api/bookings",
    payload: { resourceId: laundryId, apartmentId, startsAt: slot.startsAt },
    headers: { cookie: residentCookie },
  });
  expect(response.statusCode).toBe(201);
  return response.json<OwnBookingView>();
}

/** Every message the mail layer was handed, with the send stubbed out. */
function captureSends(): SendMailInput<unknown>[] {
  const captured: SendMailInput<unknown>[] = [];
  vi.spyOn(mail, "send").mockImplementation(async (input) => {
    captured.push(input as SendMailInput<unknown>);
  });
  return captured;
}

let residentCookie = "";
let boardCookie = "";
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
  mail = app.get(MailService);
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
      street: "Bokningsposten",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "0301", floor: 3 },
  });

  for (const person of [
    { ...resident, firstName: "Rune", lastName: "Boende" },
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
        preferredLocale: person.locale,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: `${person.firstName} ${person.lastName}`,
      password: PASSWORD,
    });
  }

  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2025-01-01"),
    },
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2026-05-15"),
    },
  });

  await prisma.bookableResource.create({
    data: {
      id: laundryId,
      // 07:00 to 21:00 in two-hour slots: seven a day, and no quota, so this
      // suite can book as many as it needs without meeting a limit.
      name: `Tvattstuga post ${suffix}`,
      mode: "TIME_SLOTS",
      slotMinutes: 120,
      opensAtMinute: 7 * 60,
      closesAtMinute: 21 * 60,
    },
  });

  residentCookie = await signIn(resident.email);
  boardCookie = await signIn(board.email);
}, 180_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.booking.deleteMany({ where: { resourceId: laundryId } });
    await prisma.bookableResource.deleteMany({ where: { id: laundryId } });
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
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.apartment.deleteMany({ where: { id: apartmentId } });
    await prisma.address.deleteMany({ where: { id: addressId } });

    // Audit entries stay: the table is append-only by trigger, and nothing here
    // asserts on a count.
    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
  }

  await app.close();
});

describe("a mail server that is down", () => {
  it("does not fail a booking that has already committed", async () => {
    const slot = await slotOn(WEEK, 0);
    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValue(new EnvelopeRefused(resident.email));

    const response = await inject({
      method: "POST",
      url: "/api/bookings",
      payload: { resourceId: laundryId, apartmentId, startsAt: slot.startsAt },
      headers: { cookie: residentCookie },
    });

    // The whole property: the mail layer refused, and the resident is told the
    // booking was made, because it was.
    expect(send).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(201);

    const booked = response.json<OwnBookingView>();
    const stored = await prisma.booking.findUnique({
      where: { id: booked.id },
      select: { status: true },
    });
    expect(stored?.status).toBe("BOOKED");
  });

  it("does not fail a cancellation that has already committed", async () => {
    const slot = await slotOn(WEEK, 1);
    const held = await book(slot);

    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValue(new EnvelopeRefused(resident.email));

    const response = await inject({
      method: "POST",
      url: `/api/booking-admin/${held.id}/cancel`,
      headers: { cookie: boardCookie },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(201);

    const stored = await prisma.booking.findUnique({
      where: { id: held.id },
      select: { status: true },
    });
    expect(stored?.status).toBe("CANCELLED");
  });

  it("names the failure by booking and never by address", async () => {
    const slot = await slotOn(WEEK, 2);
    const logged = vi.spyOn(Logger.prototype, "error");
    vi.spyOn(mail, "send").mockRejectedValue(
      new EnvelopeRefused(resident.email),
    );

    const response = await inject({
      method: "POST",
      url: "/api/bookings",
      payload: { resourceId: laundryId, apartmentId, startsAt: slot.startsAt },
      headers: { cookie: residentCookie },
    });
    expect(response.statusCode).toBe(201);

    const booked = response.json<OwnBookingView>();
    const lines = logged.mock.calls.map((call) => String(call[0]));
    const line = lines.find((text) => text.includes(booked.id));

    // The identifier is there, so the failure can be found and the send run
    // again.
    expect(line).toContain(booked.id);
    // The class of the failure, which says which layer gave way.
    expect(line).toContain("EnvelopeRefused");
    // And nothing the rejection was carrying. Container logs are read by more
    // people and kept longer than the data they would be repeating.
    for (const text of lines) {
      expect(text).not.toContain(resident.email);
    }
  });
});

describe("who a booking mail reaches", () => {
  it("confirms a booking to the resident who made it, in their language", async () => {
    const slot = await slotOn(WEEK, 3);
    const captured = captureSends();

    await book(slot);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      to: resident.email,
      // The recipient's own row, and not the default the board member is on.
      locale: resident.locale,
      template: { id: "booking-confirmation" },
    });
  });

  it("tells the resident when the board cancelled on their behalf", async () => {
    const slot = await slotOn(WEEK, 4);
    const held = await book(slot);
    const captured = captureSends();

    const response = await inject({
      method: "POST",
      url: `/api/booking-admin/${held.id}/cancel`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(201);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      // The household, not the board member who acted.
      to: resident.email,
      // Rendered in the household's language even though the board member who
      // pressed the button reads Swedish.
      locale: resident.locale,
      template: { id: "booking-cancellation" },
    });
  });

  it("writes to nobody when the resident cancelled their own booking", async () => {
    const slot = await slotOn(WEEK, 5);
    const held = await book(slot);
    const captured = captureSends();

    const response = await inject({
      method: "POST",
      url: `/api/bookings/${held.id}/cancel`,
      headers: { cookie: residentCookie },
    });
    expect(response.statusCode).toBe(201);

    // They pressed the button and the screen answered. A message saying so is
    // a message about nothing, and a household booking the laundry weekly would
    // get one every week.
    expect(captured).toHaveLength(0);
  });

  it("writes to nobody when a board member cancels their own booking", async () => {
    /*
     * The board member holds no residency, so they cannot book. The row is
     * written directly, which is what makes this case reachable at all - and it
     * is the case a route-shaped rule would get wrong: the board's route is
     * being used, and the actor is still the booker.
     */
    const slot = await slotOn(WEEK, 6);
    const own = await prisma.booking.create({
      data: {
        resourceId: laundryId,
        apartmentId,
        bookedByPersonId: board.personId,
        startsAt: new Date(slot.startsAt),
        endsAt: new Date(slot.endsAt),
      },
      select: { id: true },
    });
    const captured = captureSends();

    const response = await inject({
      method: "POST",
      url: `/api/booking-admin/${own.id}/cancel`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(201);

    expect(captured).toHaveLength(0);
  });
});
