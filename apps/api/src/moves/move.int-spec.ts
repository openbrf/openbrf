import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { MailService } from "../mail/mail.service";
import { moveInMail } from "../mail/templates";
import type {
  BoardMoveOutReminderMailProps,
  MoveInMailProps,
} from "../mail/templates";
import { computePurgeDate } from "../retention/purge-date";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { MoveError, MoveService } from "./move.service";

/**
 * One message as the spy captured it.
 *
 * MailService.send is generic over its template's props, which a spy cannot
 * express: the mock has to accept whatever template the code under test hands
 * it. Narrowing back to the props of a named template is the test's own job,
 * done where the message is inspected.
 */
interface CapturedMail {
  to: string;
  locale: string | null | undefined;
  template: { id: string };
  props: Record<string, unknown>;
}

/**
 * The move flows against a real database, a real job queue and the real mail
 * renderer.
 *
 * These are the two paths that write the statutory member register, and the
 * register cannot be updated or deleted afterwards. So what is pinned here is
 * not that a residency row appears: it is that the ENTRY row is written exactly
 * when a membership begins, that the EXIT row is written only when the person's
 * LAST tenant-ownership ends, and that the board's reminder actually reaches
 * the board through the queue rather than only being enqueued.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let mail: MailService;
let moves: MoveService;
let retentionDays: number;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const surname = `Flyttman${suffix}`;

const addressId = `mv-address-${suffix}`;
const apartments = {
  first: `mv-apartment-a-${suffix}`,
  second: `mv-apartment-b-${suffix}`,
  third: `mv-apartment-c-${suffix}`,
  reminder: `mv-apartment-d-${suffix}`,
  /** Moved in and out again while the mail server is refusing. */
  outage: `mv-apartment-e-${suffix}`,
  /** Used by the reminder that reaches only part of the board. */
  partial: `mv-apartment-f-${suffix}`,
  /** Taken over by one person in two move-ins running at the same instant. */
  raceA: `mv-apartment-g-${suffix}`,
  raceB: `mv-apartment-h-${suffix}`,
  /** Moved out of twice, the second against a precondition already stale. */
  stale: `mv-apartment-i-${suffix}`,
  /** Granted for the first time: an upplatelse, with the duty it opens. */
  granted: `mv-apartment-j-${suffix}`,
  /** A grant refused because it names a seller. */
  refusedGrant: `mv-apartment-k-${suffix}`,
  /** A transfer whose seller the register does not hold. */
  unknownSeller: `mv-apartment-l-${suffix}`,
  /** Moved into on a date the calendar does not have, and refused. */
  misdated: `mv-apartment-m-${suffix}`,
  /** Entered after a later purchase, with a move-in dated before it. */
  backDated: `mv-apartment-n-${suffix}`,
  /** The later purchase the back-dated move-in is entered after. */
  laterPurchase: `mv-apartment-o-${suffix}`,
  /** Two apartments whose move-outs are entered against their date order. */
  leftLast: `mv-apartment-p-${suffix}`,
  leftFirst: `mv-apartment-q-${suffix}`,
  /** Left while an apartment bought for later waits. */
  leftBeforeGap: `mv-apartment-r-${suffix}`,
  boughtAfterGap: `mv-apartment-s-${suffix}`,
  /** Held by two sellers in turn, and sold on by the second. */
  sold: `mv-apartment-t-${suffix}`,
  /** Held by somebody who never held `sold`. */
  strangerHome: `mv-apartment-u-${suffix}`,
};

const actors = {
  board: {
    personId: `mv-board-${suffix}`,
    email: `mv-board-${suffix}@exempel.se`,
  },
  resident: {
    personId: `mv-resident-${suffix}`,
    email: `mv-resident-${suffix}@exempel.se`,
  },
  /** Moves in as a member; the welcome mail must reach them in English. */
  buyer: {
    personId: `mv-buyer-${suffix}`,
    email: `mv-buyer-${suffix}@exempel.se`,
  },
  /** Takes an upplatelse: the first holder of a bostadsratt. */
  grantee: {
    personId: `mv-grantee-${suffix}`,
    email: `mv-grantee-${suffix}@exempel.se`,
  },
  /** A grant that names a seller is refused before this person moves in. */
  refusedGrantee: {
    personId: `mv-refused-${suffix}`,
    email: `mv-refused-${suffix}@exempel.se`,
  },
  /** Buys from somebody the register does not hold. */
  unknownBuyer: {
    personId: `mv-unknown-${suffix}`,
    email: `mv-unknown-${suffix}@exempel.se`,
  },
  /** Sells to the buyer. */
  seller: {
    personId: `mv-seller-${suffix}`,
    email: `mv-seller-${suffix}@exempel.se`,
  },
  /** Holds two apartments, so selling one does not end the membership. */
  twoApartments: {
    personId: `mv-two-${suffix}`,
    email: `mv-two-${suffix}@exempel.se`,
  },
  /** Used only by the board reminder job. */
  leaver: {
    personId: `mv-leaver-${suffix}`,
    email: `mv-leaver-${suffix}@exempel.se`,
  },
  /** A second board member, so a reminder has more than one recipient. */
  deputy: {
    personId: `mv-deputy-${suffix}`,
    email: `mv-deputy-${suffix}@exempel.se`,
  },
  /** Moves while the mail server is refusing every message. */
  mover: {
    personId: `mv-mover-${suffix}`,
    email: `mv-mover-${suffix}@exempel.se`,
  },
  /** Takes over two apartments at once: two residencies, one membership. */
  racer: {
    personId: `mv-racer-${suffix}`,
    email: `mv-racer-${suffix}@exempel.se`,
  },
  /** Moved out twice, the second request holding a stale precondition. */
  stale: {
    personId: `mv-stale-${suffix}`,
    email: `mv-stale-${suffix}@exempel.se`,
  },
  /** Refused a move-in dated on a day the calendar does not have. */
  misdated: {
    personId: `mv-misdated-${suffix}`,
    email: `mv-misdated-${suffix}@exempel.se`,
  },
  /** Has a move-in entered after a later one. */
  backDater: {
    personId: `mv-back-${suffix}`,
    email: `mv-back-${suffix}@exempel.se`,
  },
  /** Has two move-outs entered against their date order. */
  lateRecorder: {
    personId: `mv-late-${suffix}`,
    email: `mv-late-${suffix}@exempel.se`,
  },
  /** Holds no tenant-ownership for two months between two apartments. */
  gapHolder: {
    personId: `mv-gap-${suffix}`,
    email: `mv-gap-${suffix}@exempel.se`,
  },
  /** Held `sold` years ago, and sold it on long before the transfers below. */
  formerHolder: {
    personId: `mv-former-${suffix}`,
    email: `mv-former-${suffix}@exempel.se`,
  },
  /** Holds `sold` until the day it passes on, and moves out on that day. */
  soldBy: {
    personId: `mv-sold-by-${suffix}`,
    email: `mv-sold-by-${suffix}@exempel.se`,
  },
  /** A tenant-owner, but of another apartment than `sold`. */
  stranger: {
    personId: `mv-stranger-${suffix}`,
    email: `mv-stranger-${suffix}@exempel.se`,
  },
  /** Buys `sold`, after every refusal below has left it untouched. */
  soldTo: {
    personId: `mv-sold-to-${suffix}`,
    email: `mv-sold-to-${suffix}@exempel.se`,
  },
} as const;

const personIds = Object.values(actors).map((actor) => actor.personId);

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PATCH";
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
        "x-forwarded-for": `10.55.0.${String(ipCounter % 250)}`,
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

async function createPerson(input: {
  personId: string;
  firstName: string;
  email: string;
  preferredLocale?: string;
}): Promise<void> {
  const email = await encryption.encrypt("person.email", input.email);
  await prisma.person.create({
    data: {
      id: input.personId,
      firstName: input.firstName,
      lastName: surname,
      postalStreet: "Flyttgatan 2",
      postalCode: "11122",
      postalCity: "Stockholm",
      emailCipher: email.cipher,
      emailIndex: email.index,
      preferredLocale: input.preferredLocale ?? "sv",
    },
  });
}

async function registerEntries(personId: string) {
  return prisma.memberRegisterEntry.findMany({
    where: { personId },
    orderBy: [{ eventOn: "asc" }],
    select: { eventType: true, eventOn: true, apartmentId: true },
  });
}

/** Resolves when the code under test reaches a chosen point. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
  encryption = app.get(FieldEncryptionService);
  mail = app.get(MailService);
  moves = app.get(MoveService);

  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { retentionDaysAfterMoveOut: true },
  });
  retentionDays = association?.retentionDaysAfterMoveOut ?? 365;

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Flyttstigen",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 920,
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

  await createPerson({
    personId: actors.board.personId,
    firstName: "Bea",
    email: actors.board.email,
  });
  await createPerson({
    personId: actors.resident.personId,
    firstName: "Rita",
    email: actors.resident.email,
  });
  await createPerson({
    personId: actors.buyer.personId,
    firstName: "Ben",
    email: actors.buyer.email,
    preferredLocale: "en",
  });
  await createPerson({
    personId: actors.grantee.personId,
    firstName: "Gunilla",
    email: actors.grantee.email,
  });
  await createPerson({
    personId: actors.refusedGrantee.personId,
    firstName: "Rune",
    email: actors.refusedGrantee.email,
  });
  await createPerson({
    personId: actors.unknownBuyer.personId,
    firstName: "Ulla",
    email: actors.unknownBuyer.email,
  });
  await createPerson({
    personId: actors.seller.personId,
    firstName: "Sara",
    email: actors.seller.email,
  });
  await createPerson({
    personId: actors.twoApartments.personId,
    firstName: "Tove",
    email: actors.twoApartments.email,
  });
  await createPerson({
    personId: actors.leaver.personId,
    firstName: "Lena",
    email: actors.leaver.email,
  });
  await createPerson({
    personId: actors.deputy.personId,
    firstName: "Doris",
    email: actors.deputy.email,
  });
  await createPerson({
    personId: actors.mover.personId,
    firstName: "Mats",
    email: actors.mover.email,
  });
  await createPerson({
    personId: actors.racer.personId,
    firstName: "Ronja",
    email: actors.racer.email,
  });
  await createPerson({
    personId: actors.stale.personId,
    firstName: "Stina",
    email: actors.stale.email,
  });
  await createPerson({
    personId: actors.misdated.personId,
    firstName: "Maja",
    email: actors.misdated.email,
  });
  await createPerson({
    personId: actors.backDater.personId,
    firstName: "Bodil",
    email: actors.backDater.email,
  });
  await createPerson({
    personId: actors.lateRecorder.personId,
    firstName: "Lars",
    email: actors.lateRecorder.email,
  });
  await createPerson({
    personId: actors.gapHolder.personId,
    firstName: "Gustav",
    email: actors.gapHolder.email,
  });
  await createPerson({
    personId: actors.formerHolder.personId,
    firstName: "Frida",
    email: actors.formerHolder.email,
  });
  await createPerson({
    personId: actors.soldBy.personId,
    firstName: "Sixten",
    email: actors.soldBy.email,
  });
  await createPerson({
    personId: actors.stranger.personId,
    firstName: "Stig",
    email: actors.stranger.email,
  });
  await createPerson({
    personId: actors.soldTo.personId,
    firstName: "Siri",
    email: actors.soldTo.email,
  });

  await prisma.residency.createMany({
    data: [
      {
        personId: actors.resident.personId,
        apartmentId: apartments.first,
        role: "RESIDENT",
        movedInOn: new Date("2022-01-01T00:00:00.000Z"),
      },
      // The seller of the buyer's apartment, up to the day the buyer moves in.
      {
        personId: actors.seller.personId,
        apartmentId: apartments.second,
        role: "MEMBER",
        movedInOn: new Date("2018-06-01T00:00:00.000Z"),
        movedOutOn: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        personId: actors.formerHolder.personId,
        apartmentId: apartments.sold,
        role: "MEMBER",
        movedInOn: new Date("2012-01-01T00:00:00.000Z"),
        movedOutOn: new Date("2019-09-01T00:00:00.000Z"),
      },
      {
        personId: actors.soldBy.personId,
        apartmentId: apartments.sold,
        role: "MEMBER",
        movedInOn: new Date("2019-09-01T00:00:00.000Z"),
        movedOutOn: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        personId: actors.stranger.personId,
        apartmentId: apartments.strangerHome,
        role: "MEMBER",
        movedInOn: new Date("2019-01-01T00:00:00.000Z"),
      },
    ],
  });

  await prisma.boardPosition.createMany({
    data: [
      {
        personId: actors.board.personId,
        position: "CHAIR",
        electedOn: new Date("2025-05-15T00:00:00.000Z"),
      },
      {
        personId: actors.deputy.personId,
        position: "DEPUTY_BOARD_MEMBER",
        electedOn: new Date("2025-05-15T00:00:00.000Z"),
      },
    ],
  });

  const auth = app.get(AuthService);
  for (const actor of [actors.board, actors.resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
}, 180_000);

afterAll(async () => {
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
  // Transfers and member register entries stay: the archive is append-only by
  // design, and their apartments and persons stay with them.
  await app.close();
});

describe("who may move someone in or out", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.buyer.personId,
        apartmentId: apartments.first,
        role: "RESIDENT",
        movedInOn: "2026-01-01",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.buyer.personId,
        apartmentId: apartments.first,
        role: "RESIDENT",
        movedInOn: "2026-01-01",
      },
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("an upplatelse and an overgang are different events", () => {
  /**
   * The distinction this suite exists for, and what it costs to get wrong.
   *
   * A grant (upplatelse, BRL 4 kap.) and a transfer out of a hand the register
   * never held (overgang, 6 kap.) both arrive with no seller, and they were the
   * same row until `Transfer.kind`. Only the first is reportable to the
   * cooperative housing register on the day it happened - Lag (2026:484) 3 kap.
   * 2 §, "inom tva veckor fran upplatelsen" - while a transfer's window opens on
   * a membership decision that is recorded later or not at all (3 kap. 3 §).
   *
   * So the assertions here are about which duty each one opens, not about a
   * label: a grant takes a deadline dated the day of the grant, and a transfer
   * with no seller takes none until somebody records the decision.
   */
  it("puts the grant's own day on the ledger, fourteen days ahead", async () => {
    const grantedOn = "2026-04-07";
    /*
     * A different day from the grant, deliberately. Lag (2026:484) 3 kap. 2 §
     * counts from the upplatelse and not from the day anybody took possession,
     * and with one date for both the assertion below would pass against a
     * service that used the wrong one.
     */
    const movedInOn = "2026-05-02";
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.grantee.personId,
        apartmentId: apartments.granted,
        role: "MEMBER",
        movedInOn,
        transfer: {
          kind: "GRANT",
          transferredOn: grantedOn,
          agreementReference: `Upplatelse ${suffix}`,
        },
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(201);
    const { transferId } = JSON.parse(response.body) as {
      transferId: string | null;
    };

    const transfer = await prisma.transfer.findUniqueOrThrow({
      where: { id: transferId ?? "" },
      select: { kind: true, fromPersonId: true },
    });
    expect(transfer.kind).toBe("GRANT");
    expect(transfer.fromPersonId).toBeNull();

    const obligation = await prisma.registerReportObligation.findFirstOrThrow({
      where: { transferId: transferId ?? "" },
      select: { kind: true, triggeredOn: true, dueOn: true },
    });
    expect(obligation.kind).toBe("GRANT");
    // The day of the upplatelse itself, and not the day anybody moved in.
    expect(obligation.triggeredOn.toISOString().slice(0, 10)).toBe(grantedOn);
    expect(obligation.triggeredOn.toISOString().slice(0, 10)).not.toBe(
      movedInOn,
    );
    // "inom tva veckor", which the table also states as a CHECK. Not null: the
    // deadline is nullable only for the one duty 3 kap. sets no period for, and
    // an upplatelse is not it.
    expect(obligation.dueOn?.toISOString().slice(0, 10)).toBe("2026-04-21");
  });

  it("refuses a grant that names a seller", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.refusedGrantee.personId,
        apartmentId: apartments.refusedGrant,
        role: "MEMBER",
        movedInOn: "2026-04-08",
        transfer: {
          kind: "GRANT",
          fromPersonId: actors.seller.personId,
          transferredOn: "2026-04-08",
          agreementReference: `Upplatelse med saljare ${suffix}`,
        },
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    // The right comes into being at an upplatelse; there is nobody for it to
    // pass from. A row like this would put an overgang on 3 kap. 2 §'s clock.
    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "grant-has-no-seller",
    );
    expect(
      await prisma.transfer.count({
        where: { apartmentId: apartments.refusedGrant },
      }),
    ).toBe(0);
  });

  /*
   * `Date` reads "2026-02-30" as the 2nd of March, and the entry, the transfer
   * and the obligation a move-in writes are rows the database will not let
   * anyone correct. A month of 13 is an Invalid Date, which reached the
   * database as a server error rather than a refusal.
   */
  it.each([
    { movedInOn: "2026-02-30", transferredOn: "2026-02-14" },
    { movedInOn: "2026-03-01", transferredOn: "2026-02-29" },
    { movedInOn: "2026-13-01", transferredOn: "2026-02-14" },
  ])(
    "refuses a move-in on $movedInOn transferred on $transferredOn and writes nothing",
    async ({ movedInOn, transferredOn }) => {
      const response = await inject({
        method: "POST",
        url: "/api/moves/move-in",
        payload: {
          personId: actors.misdated.personId,
          apartmentId: apartments.misdated,
          role: "MEMBER",
          movedInOn,
          transfer: {
            kind: "GRANT",
            transferredOn,
            agreementReference: `Upplatelse ${suffix}`,
          },
        },
        headers: { cookie: await signIn(actors.board.email) },
      });

      expect(response.statusCode).toBe(400);
      // The request schema answers, not the service: the move forms map this
      // reason to a sentence, so the two must not drift apart unnoticed.
      expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
        "invalid-body",
      );
      expect(
        await prisma.residency.count({
          where: { personId: actors.misdated.personId },
        }),
      ).toBe(0);
      expect(await registerEntries(actors.misdated.personId)).toEqual([]);
      expect(
        await prisma.transfer.count({
          where: { apartmentId: apartments.misdated },
        }),
      ).toBe(0);
    },
  );

  it("refuses a date the calendar does not have in the service too", async () => {
    // The controller refuses first; this is the service's own guard, for a
    // caller that reaches it without going through the request schema.
    await expect(
      moves.moveIn({
        actorPersonId: actors.board.personId,
        personId: actors.misdated.personId,
        apartmentId: apartments.misdated,
        role: "MEMBER",
        movedInOn: "2026-02-30",
      }),
    ).rejects.toMatchObject({
      reason: "date-not-a-calendar-date",
      status: 400,
    });
    expect(await registerEntries(actors.misdated.personId)).toEqual([]);
  });

  it("leaves a transfer with an unrecorded seller without a deadline", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.unknownBuyer.personId,
        apartmentId: apartments.unknownSeller,
        role: "MEMBER",
        movedInOn: "2026-04-09",
        transfer: {
          kind: "TRANSFER",
          transferredOn: "2026-04-09",
          agreementReference: `Overlatelse utan saljare ${suffix}`,
        },
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(201);
    const { transferId } = JSON.parse(response.body) as {
      transferId: string | null;
    };

    const transfer = await prisma.transfer.findUniqueOrThrow({
      where: { id: transferId ?? "" },
      select: { kind: true, fromPersonId: true },
    });
    expect(transfer.kind).toBe("TRANSFER");
    expect(transfer.fromPersonId).toBeNull();

    /*
     * No deadline, and that is the point of recording the kind. This row looks
     * exactly like the grant above on every column but `kind`, and before it
     * existed the platform could not tell them apart - so it raised the duty
     * for neither. 3 kap. 3 § andra stycket counts this one's two weeks from a
     * membership decision, which the board records separately and has not.
     */
    expect(
      await prisma.registerReportObligation.count({
        where: { transferId: transferId ?? "" },
      }),
    ).toBe(0);
  });
});

describe("a transfer names a seller who held the apartment", () => {
  /**
   * A transfer row cannot be deleted, and the seller it names is on the
   * apartment register extract and on their own access report from then on.
   * So the seller is checked against the register before the row is written:
   * a MEMBER residency on this apartment, held when it passed on.
   *
   * Every refusal here is on the same apartment, and the last test sells it
   * for real, so each refusal is also checked to have left nothing behind -
   * no transfer and no residency for the buyer.
   */
  async function moveInBuying(input: {
    apartmentId: string;
    fromPersonId: string;
    transferredOn: string;
  }) {
    return inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.soldTo.personId,
        apartmentId: input.apartmentId,
        role: "MEMBER",
        movedInOn: "2026-04-10",
        transfer: {
          kind: "TRANSFER",
          fromPersonId: input.fromPersonId,
          transferredOn: input.transferredOn,
          agreementReference: `Overlatelse ${input.fromPersonId}`,
        },
      },
      headers: { cookie: await signIn(actors.board.email) },
    });
  }

  async function expectNothingWritten(apartmentId: string): Promise<void> {
    expect(await prisma.transfer.count({ where: { apartmentId } })).toBe(0);
    expect(
      await prisma.residency.count({
        where: { apartmentId, personId: actors.soldTo.personId },
      }),
    ).toBe(0);
    expect(await registerEntries(actors.soldTo.personId)).toEqual([]);
  }

  it("refuses a seller who never held the apartment", async () => {
    // A tenant-owner, and a person the register holds - just not of this one.
    const response = await moveInBuying({
      apartmentId: apartments.sold,
      fromPersonId: actors.stranger.personId,
      transferredOn: "2026-04-10",
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "seller-not-tenant-owner",
    );
    await expectNothingWritten(apartments.sold);
  });

  it("refuses a seller who had sold the apartment on before the transfer", async () => {
    const response = await moveInBuying({
      apartmentId: apartments.sold,
      fromPersonId: actors.formerHolder.personId,
      transferredOn: "2026-04-10",
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "seller-not-tenant-owner",
    );
    await expectNothingWritten(apartments.sold);
  });

  it("refuses a seller whose holding began after the transfer", async () => {
    // The right seller, and a transfer day before they held the apartment.
    const response = await moveInBuying({
      apartmentId: apartments.sold,
      fromPersonId: actors.soldBy.personId,
      transferredOn: "2019-08-01",
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "seller-not-tenant-owner",
    );
    await expectNothingWritten(apartments.sold);
  });

  it("refuses a seller who lived there without holding the tenant-ownership", async () => {
    // A RESIDENT residency: somebody living in the apartment, not a holder.
    const response = await moveInBuying({
      apartmentId: apartments.first,
      fromPersonId: actors.resident.personId,
      transferredOn: "2026-04-10",
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "seller-not-tenant-owner",
    );
    await expectNothingWritten(apartments.first);
  });

  it("refuses a seller who is the acquirer", async () => {
    const response = await moveInBuying({
      apartmentId: apartments.sold,
      fromPersonId: actors.soldTo.personId,
      transferredOn: "2026-04-10",
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "seller-is-acquirer",
    );
    await expectNothingWritten(apartments.sold);
  });

  it("refuses a move-out that transfers the apartment to whoever is leaving it", async () => {
    const residency = await prisma.residency.findFirstOrThrow({
      where: {
        personId: actors.stranger.personId,
        apartmentId: apartments.strangerHome,
      },
      select: { id: true },
    });

    const response = await inject({
      method: "POST",
      url: "/api/moves/move-out",
      payload: {
        residencyId: residency.id,
        movedOutOn: "2026-05-01",
        transfer: {
          toPersonId: actors.stranger.personId,
          transferredOn: "2026-05-01",
          agreementReference: `Overlatelse till sig sjalv ${suffix}`,
        },
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "seller-is-acquirer",
    );
    expect(
      await prisma.transfer.count({
        where: { apartmentId: apartments.strangerHome },
      }),
    ).toBe(0);
    // The move-out shares the transaction, so it is refused with the transfer.
    const after = await prisma.residency.findUniqueOrThrow({
      where: { id: residency.id },
      select: { movedOutOn: true },
    });
    expect(after.movedOutOn).toBeNull();
  });

  it("refuses a move-out whose transfer falls after the seller left", async () => {
    const residency = await prisma.residency.findFirstOrThrow({
      where: {
        personId: actors.stranger.personId,
        apartmentId: apartments.strangerHome,
      },
      select: { id: true },
    });

    const response = await inject({
      method: "POST",
      url: "/api/moves/move-out",
      payload: {
        residencyId: residency.id,
        movedOutOn: "2026-05-01",
        transfer: {
          toPersonId: actors.soldTo.personId,
          transferredOn: "2026-06-01",
          agreementReference: `Overlatelse efter utflyttning ${suffix}`,
        },
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "seller-not-tenant-owner",
    );
    expect(
      await prisma.transfer.count({
        where: { apartmentId: apartments.strangerHome },
      }),
    ).toBe(0);
  });

  it("records a transfer from a seller who moved out on the day it passed on", async () => {
    // The move-out date is the first day a residency is not held, so this
    // seller held the apartment up to the transfer day and not on it. That is
    // the ordinary order of a sale, and it has to go through.
    const response = await moveInBuying({
      apartmentId: apartments.sold,
      fromPersonId: actors.soldBy.personId,
      transferredOn: "2026-04-10",
    });

    expect(response.statusCode).toBe(201);
    const { transferId } = JSON.parse(response.body) as {
      transferId: string | null;
    };
    const transfer = await prisma.transfer.findUniqueOrThrow({
      where: { id: transferId ?? "" },
      select: { fromPersonId: true, toPersonId: true },
    });
    expect(transfer.fromPersonId).toBe(actors.soldBy.personId);
    expect(transfer.toPersonId).toBe(actors.soldTo.personId);
  });
});

describe("moving in", () => {
  it("creates the residency, writes the register entry and welcomes the person in their own language", async () => {
    const sent: CapturedMail[] = [];
    const send = vi.spyOn(mail, "send").mockImplementation(async (input) => {
      sent.push(input as unknown as CapturedMail);
      return { messageId: null };
    });

    try {
      const response = await inject({
        method: "POST",
        url: "/api/moves/move-in",
        payload: {
          personId: actors.buyer.personId,
          apartmentId: apartments.second,
          role: "MEMBER",
          movedInOn: "2026-03-01",
          transfer: {
            kind: "TRANSFER",
            fromPersonId: actors.seller.personId,
            transferredOn: "2026-02-14",
            price: "3450000.00",
            agreementReference: `Avtal ${suffix}`,
          },
        },
        headers: { cookie: await signIn(actors.board.email) },
      });

      expect(response.statusCode).toBe(201);
      const result = JSON.parse(response.body) as {
        residencyId: string;
        memberRegisterEntryRecorded: boolean;
        transferId: string | null;
        welcomeEmailSent: boolean;
      };
      expect(result.memberRegisterEntryRecorded).toBe(true);
      expect(result.welcomeEmailSent).toBe(true);
      expect(result.transferId).not.toBeNull();

      const entries = await registerEntries(actors.buyer.personId);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.eventType).toBe("ENTRY");
      expect(entries[0]?.apartmentId).toBe(apartments.second);

      const transfer = await prisma.transfer.findUniqueOrThrow({
        where: { id: result.transferId ?? "" },
      });
      expect(transfer.agreementReference).toBe(`Avtal ${suffix}`);
      expect(transfer.fromPersonId).toBe(actors.seller.personId);

      // The welcome mail is rendered for the recipient's locale, not the
      // board member's: the buyer's record says English.
      const welcome = sent.find((message) => message.template.id === "move-in");
      expect(welcome?.locale).toBe("en");
      const rendered = await mail.renderMail({
        locale: welcome?.locale,
        template: moveInMail,
        props: welcome?.props as unknown as MoveInMailProps,
      });
      expect(rendered.subject).toContain("Welcome");
      expect(rendered.text).toContain("1102");
    } finally {
      send.mockRestore();
    }
  });

  it("writes no register entry for a resident who is not a member", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.seller.personId,
        apartmentId: apartments.first,
        role: "RESIDENT",
        movedInOn: "2026-03-01",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(201);
    expect(
      (JSON.parse(response.body) as { memberRegisterEntryRecorded: boolean })
        .memberRegisterEntryRecorded,
    ).toBe(false);
    expect(await registerEntries(actors.seller.personId)).toEqual([]);
  });

  it("does not make an existing member a member twice", async () => {
    // Membership is derived from holding at least one tenant-ownership. Taking
    // over a second apartment does not begin a second membership, and a second
    // ENTRY row could never be taken back.
    const cookie = await signIn(actors.board.email);

    const first = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.twoApartments.personId,
        apartmentId: apartments.third,
        role: "MEMBER",
        movedInOn: "2020-01-01",
      },
      headers: { cookie },
    });
    const second = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.twoApartments.personId,
        apartmentId: apartments.reminder,
        role: "MEMBER",
        movedInOn: "2023-01-01",
      },
      headers: { cookie },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(
      (JSON.parse(second.body) as { memberRegisterEntryRecorded: boolean })
        .memberRegisterEntryRecorded,
    ).toBe(false);
    expect(await registerEntries(actors.twoApartments.personId)).toHaveLength(
      1,
    );
  });

  it("refuses a second residency on the same apartment", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.buyer.personId,
        apartmentId: apartments.second,
        role: "MEMBER",
        movedInOn: "2026-04-01",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "already-resident",
    );
  });

  it("writes one register entry when two move-ins for the same person overlap", async () => {
    // Whether a move-in begins a membership is read inside the transaction,
    // before the row that would answer the question exists. Two move-ins for
    // one person running at the same instant each read "no membership running"
    // and each append an ENTRY - to a register that refuses UPDATE and DELETE,
    // so the duplicate stays. Two tenant-ownerships are one membership, and the
    // second transaction has to see the first one's row.
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });

    try {
      await Promise.all([
        moves.moveIn({
          actorPersonId: actors.board.personId,
          personId: actors.racer.personId,
          apartmentId: apartments.raceA,
          role: "MEMBER",
          movedInOn: "2025-01-01",
        }),
        moves.moveIn({
          actorPersonId: actors.board.personId,
          personId: actors.racer.personId,
          apartmentId: apartments.raceB,
          role: "MEMBER",
          movedInOn: "2025-01-01",
        }),
      ]);

      expect(
        await prisma.residency.count({
          where: { personId: actors.racer.personId },
        }),
      ).toBe(2);
      expect(
        (await registerEntries(actors.racer.personId)).map(
          (entry) => entry.eventType,
        ),
      ).toEqual(["ENTRY"]);
    } finally {
      send.mockRestore();
    }
  });

  it("refuses a transfer with no reference to its agreement, and moves nobody in", async () => {
    // The apartment register extract states a reference for every transfer it
    // lists (BRL 9 kap.), and a transfer row cannot be deleted afterwards, so a
    // reference that is merely optional is one the extract can be asked to
    // print and not have. The refusal takes the whole move-in with it: the
    // residency and the register entry share the transaction the transfer is
    // written in.
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.leaver.personId,
        apartmentId: apartments.raceA,
        role: "MEMBER",
        movedInOn: "2026-04-01",
        transfer: {
          kind: "TRANSFER",
          transferredOn: "2026-03-20",
          agreementReference: "   ",
        },
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "transfer-reference-required",
    );
    expect(
      await prisma.residency.count({
        where: {
          personId: actors.leaver.personId,
          apartmentId: apartments.raceA,
        },
      }),
    ).toBe(0);
  });

  it("keeps a transfer without a reference out of the database as well", async () => {
    // The service refuses one, and so does the table: the invariant belongs to
    // the register rather than to the one code path that happens to write it
    // today.
    await expect(
      prisma.transfer.create({
        data: {
          apartmentId: apartments.raceB,
          toPersonId: actors.leaver.personId,
          transferredOn: new Date("2026-03-20T00:00:00.000Z"),
        },
      }),
    ).rejects.toThrow();
  });

  /*
   * Every string String.prototype.trim reduces to nothing, which is what the
   * service treats as no reference at all. The table has to refuse the same
   * set: the service is not the only writer, and a constraint that accepts a
   * tab where the service refuses one is not the boundary it was added to be.
   *
   * Written as escapes rather than as the characters themselves. A source file
   * carrying invisible code points cannot be read or reviewed, and a test whose
   * whole subject is invisible characters is the last place to hide any.
   */
  const blankReferences: readonly (readonly [string, string])[] = [
    ["empty", ""],
    ["spaces", "   "],
    ["a tab", "\u0009"],
    ["a line feed", "\u000A"],
    ["a vertical tab", "\u000B"],
    ["a form feed", "\u000C"],
    ["a carriage return", "\u000D"],
    ["a non-breaking space", "\u00A0"],
    ["an ogham space mark", "\u1680"],
    ["an en quad", "\u2000"],
    ["a hair space", "\u200A"],
    ["a line separator", "\u2028"],
    ["a paragraph separator", "\u2029"],
    ["a narrow non-breaking space", "\u202F"],
    ["a medium mathematical space", "\u205F"],
    ["an ideographic space", "\u3000"],
    ["a byte order mark", "\uFEFF"],
    ["mixed whitespace", "\u0009 \u000A\u00A0\uFEFF"],
  ];

  it.each(blankReferences)(
    "keeps a transfer whose reference is only %s out of the database",
    async (_label, reference) => {
      await expect(
        prisma.transfer.create({
          data: {
            apartmentId: apartments.raceB,
            toPersonId: actors.leaver.personId,
            transferredOn: new Date("2026-03-20T00:00:00.000Z"),
            agreementReference: reference,
          },
        }),
      ).rejects.toThrow();

      // The document path satisfies the same requirement, so it has to refuse
      // the same set rather than leaving a second way in.
      await expect(
        prisma.transfer.create({
          data: {
            apartmentId: apartments.raceB,
            toPersonId: actors.leaver.personId,
            transferredOn: new Date("2026-03-20T00:00:00.000Z"),
            agreementDocumentPath: reference,
          },
        }),
      ).rejects.toThrow();
    },
  );

  it("accepts a reference made of a character that only looks blank", async () => {
    /*
     * The control for the case above. A zero-width space is not whitespace:
     * String.prototype.trim keeps it, so the constraint has to keep it too.
     * Without this, a constraint that refused everything unprintable would pass
     * every case above for the wrong reason.
     *
     * Rolled back rather than deleted afterwards. A transfer is a statutory row
     * and the table's own trigger refuses a DELETE, so a test that committed one
     * would have to leave it in the register.
     */
    class Rollback extends Error {}

    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.transfer.create({
          data: {
            apartmentId: apartments.raceB,
            // Stated because the table now requires it of every new row, and
            // this test is about the reference rather than about the kind.
            kind: "TRANSFER",
            toPersonId: actors.leaver.personId,
            transferredOn: new Date("2026-03-20T00:00:00.000Z"),
            agreementReference: "\u200B",
          },
          select: { id: true },
        });
        expect(transfer.id).toBeTruthy();
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);

    expect(
      await prisma.transfer.count({ where: { apartmentId: apartments.raceB } }),
    ).toBe(0);
  });

  it("refuses an apartment that is not in the register", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: actors.buyer.personId,
        apartmentId: `mv-missing-${suffix}`,
        role: "MEMBER",
        movedInOn: "2026-04-01",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("moving out", () => {
  it("ends the residency, computes the purge date and closes the membership", async () => {
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });

    try {
      const residency = await prisma.residency.findFirstOrThrow({
        where: {
          personId: actors.buyer.personId,
          apartmentId: apartments.second,
        },
        select: { id: true },
      });

      const response = await inject({
        method: "POST",
        url: "/api/moves/move-out",
        payload: {
          residencyId: residency.id,
          movedOutOn: "2026-06-30",
          transfer: {
            toPersonId: actors.seller.personId,
            transferredOn: "2026-06-15",
            agreementReference: `Avtal ut ${suffix}`,
          },
        },
        headers: { cookie: await signIn(actors.board.email) },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body) as {
        purgeOn: string;
        memberRegisterExitRecorded: boolean;
        transferId: string | null;
        boardReminderOn: string;
      };

      const expected = computePurgeDate(
        new Date("2026-06-30T00:00:00.000Z"),
        retentionDays,
      );
      expect(result.purgeOn).toBe(expected?.toISOString().slice(0, 10));
      expect(result.memberRegisterExitRecorded).toBe(true);
      expect(result.boardReminderOn).toBe("2026-06-30");

      const entries = await registerEntries(actors.buyer.personId);
      expect(entries.map((entry) => entry.eventType)).toEqual([
        "ENTRY",
        "EXIT",
      ]);

      const transfer = await prisma.transfer.findUniqueOrThrow({
        where: { id: result.transferId ?? "" },
      });
      expect(transfer.fromPersonId).toBe(actors.buyer.personId);
      expect(transfer.toPersonId).toBe(actors.seller.personId);
    } finally {
      send.mockRestore();
    }
  });

  it("keeps the membership open while another tenant-ownership remains", async () => {
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });

    try {
      const residency = await prisma.residency.findFirstOrThrow({
        where: {
          personId: actors.twoApartments.personId,
          apartmentId: apartments.third,
        },
        select: { id: true },
      });

      const response = await inject({
        method: "POST",
        url: "/api/moves/move-out",
        payload: { residencyId: residency.id, movedOutOn: "2026-05-01" },
        headers: { cookie: await signIn(actors.board.email) },
      });

      expect(response.statusCode).toBe(200);
      expect(
        (JSON.parse(response.body) as { memberRegisterExitRecorded: boolean })
          .memberRegisterExitRecorded,
      ).toBe(false);
      expect(
        (await registerEntries(actors.twoApartments.personId)).map(
          (entry) => entry.eventType,
        ),
      ).toEqual(["ENTRY"]);
    } finally {
      send.mockRestore();
    }
  });

  it("refuses a residency that already has a move-out date", async () => {
    const residency = await prisma.residency.findFirstOrThrow({
      where: {
        personId: actors.buyer.personId,
        apartmentId: apartments.second,
      },
      select: { id: true },
    });

    const response = await inject({
      method: "POST",
      url: "/api/moves/move-out",
      payload: { residencyId: residency.id, movedOutOn: "2026-07-01" },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "already-moved-out",
    );
  });

  it("refuses a move-out earlier than the move-in", async () => {
    const residency = await prisma.residency.findFirstOrThrow({
      where: {
        personId: actors.resident.personId,
        apartmentId: apartments.first,
      },
      select: { id: true },
    });

    const response = await inject({
      method: "POST",
      url: "/api/moves/move-out",
      payload: { residencyId: residency.id, movedOutOn: "2019-01-01" },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "moved-out-before-moved-in",
    );
  });

  it("refuses a move-out whose precondition went stale, rather than closing the membership twice", async () => {
    // The residency and its move-out date are read before the transaction
    // opens, so that check is only as fresh as the moment it ran. Two requests
    // arriving together both passed it, and an unconditional update let both go
    // on to append an EXIT row to a register that refuses to have rows removed.
    //
    // The overlap is built rather than raced. Creating the reminder queue sits
    // between the check and the transaction, so holding the first request there
    // while the second runs to completion reproduces exactly the stale
    // precondition, without depending on how two requests happen to interleave.
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });
    const jobs = app.get(JobQueueService);
    const createQueue = jobs.ensureQueue.bind(jobs);
    const held = deferred<undefined>();
    const reached = deferred<undefined>();
    let first = true;
    const gate = vi
      .spyOn(jobs, "ensureQueue")
      .mockImplementation(async (name) => {
        if (first) {
          first = false;
          reached.resolve(undefined);
          await held.promise;
        }
        await createQueue(name);
      });

    try {
      const moveIn = await moves.moveIn({
        actorPersonId: actors.board.personId,
        personId: actors.stale.personId,
        apartmentId: apartments.stale,
        role: "MEMBER",
        movedInOn: "2024-05-01",
      });

      const staleRequest = moves
        .moveOut({ residencyId: moveIn.residencyId, movedOutOn: "2026-08-01" })
        .catch((error: unknown) => error);
      await reached.promise;

      await moves.moveOut({
        residencyId: moveIn.residencyId,
        movedOutOn: "2026-08-01",
      });
      held.resolve(undefined);

      const outcome = await staleRequest;
      expect(outcome).toBeInstanceOf(MoveError);
      expect((outcome as MoveError).reason).toBe("already-moved-out");
      expect(
        (await registerEntries(actors.stale.personId)).map(
          (entry) => entry.eventType,
        ),
      ).toEqual(["ENTRY", "EXIT"]);
    } finally {
      gate.mockRestore();
      send.mockRestore();
    }
  });

  it("keeps the archive entry immutable once written", async () => {
    const exit = await prisma.memberRegisterEntry.findFirstOrThrow({
      where: { personId: actors.buyer.personId, eventType: "EXIT" },
      select: { id: true },
    });

    await expect(
      prisma.memberRegisterEntry.delete({ where: { id: exit.id } }),
    ).rejects.toThrow();
  });
});

describe("moves entered out of date order", () => {
  /*
   * A buyer is entered before they take over, a move-in is back-dated, two
   * move-outs arrive in the order the paperwork did. The register has to read
   * the same as if each had been entered on its day: whether a move begins or
   * ends a membership depends on what else the person held on that day, not on
   * what had merely not ended by it. Each case here wrote the wrong rows before
   * that was the rule, into a register that cannot have a row removed.
   */

  async function residencyOf(personId: string, apartmentId: string) {
    return prisma.residency.findFirstOrThrow({
      where: { personId, apartmentId },
      select: { id: true },
    });
  }

  function rows(entries: Awaited<ReturnType<typeof registerEntries>>) {
    return entries.map((entry) => ({
      eventType: entry.eventType,
      eventOn: entry.eventOn.toISOString().slice(0, 10),
      apartmentId: entry.apartmentId,
    }));
  }

  it("enters a back-dated move-in recorded after a later one", async () => {
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });

    try {
      await moves.moveIn({
        actorPersonId: actors.board.personId,
        personId: actors.backDater.personId,
        apartmentId: apartments.laterPurchase,
        role: "MEMBER",
        movedInOn: "2027-01-01",
      });
      const backDated = await moves.moveIn({
        actorPersonId: actors.board.personId,
        personId: actors.backDater.personId,
        apartmentId: apartments.backDated,
        role: "MEMBER",
        movedInOn: "2026-10-01",
      });

      // The purchase entered first had not begun on 2026-10-01, so it held
      // nothing that day and the membership begins with the back-dated one.
      expect(backDated.memberRegisterEntryRecorded).toBe(true);
      expect(rows(await registerEntries(actors.backDater.personId))).toEqual([
        {
          eventType: "ENTRY",
          eventOn: "2026-10-01",
          apartmentId: apartments.backDated,
        },
        {
          eventType: "ENTRY",
          eventOn: "2027-01-01",
          apartmentId: apartments.laterPurchase,
        },
      ]);
    } finally {
      send.mockRestore();
    }
  });

  it("writes the EXIT when a move-out is recorded before an earlier one", async () => {
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });

    try {
      for (const [apartmentId, movedInOn] of [
        [apartments.leftLast, "2020-01-01"],
        [apartments.leftFirst, "2021-01-01"],
      ] as const) {
        await moves.moveIn({
          actorPersonId: actors.board.personId,
          personId: actors.lateRecorder.personId,
          apartmentId,
          role: "MEMBER",
          movedInOn,
        });
      }

      const later = await moves.moveOut({
        residencyId: (
          await residencyOf(actors.lateRecorder.personId, apartments.leftLast)
        ).id,
        movedOutOn: "2026-12-01",
      });
      const earlier = await moves.moveOut({
        residencyId: (
          await residencyOf(actors.lateRecorder.personId, apartments.leftFirst)
        ).id,
        movedOutOn: "2026-11-01",
      });

      // The other apartment was still held when the first move-out was
      // entered, so that one ends nothing. The second closes the last one, and
      // the membership ends on the later of the two dates.
      expect(later.memberRegisterExitRecorded).toBe(false);
      expect(earlier.memberRegisterExitRecorded).toBe(true);
      // Nothing begins again: neither apartment is held later than the other
      // was left.
      expect(later.memberRegisterEntryOn).toBeNull();
      expect(earlier.memberRegisterEntryOn).toBeNull();
      expect(rows(await registerEntries(actors.lateRecorder.personId))).toEqual(
        [
          {
            eventType: "ENTRY",
            eventOn: "2020-01-01",
            apartmentId: apartments.leftLast,
          },
          {
            eventType: "EXIT",
            eventOn: "2026-12-01",
            apartmentId: apartments.leftLast,
          },
        ],
      );
    } finally {
      send.mockRestore();
    }
  });

  it("records the gap before an apartment bought for later", async () => {
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });

    try {
      await moves.moveIn({
        actorPersonId: actors.board.personId,
        personId: actors.gapHolder.personId,
        apartmentId: apartments.leftBeforeGap,
        role: "MEMBER",
        movedInOn: "2020-01-01",
      });
      await moves.moveIn({
        actorPersonId: actors.board.personId,
        personId: actors.gapHolder.personId,
        apartmentId: apartments.boughtAfterGap,
        role: "MEMBER",
        movedInOn: "2026-12-01",
      });
      const left = await moves.moveOut({
        residencyId: (
          await residencyOf(actors.gapHolder.personId, apartments.leftBeforeGap)
        ).id,
        movedOutOn: "2026-09-30",
      });

      // Two months in which the person held no tenant-ownership, which the
      // register has to show rather than bridge.
      expect(left.memberRegisterExitRecorded).toBe(true);
      // And the board is told it begins again, on the day the later apartment
      // is taken over, rather than only that it ended.
      expect(left.memberRegisterEntryOn).toBe("2026-12-01");
      expect(rows(await registerEntries(actors.gapHolder.personId))).toEqual([
        {
          eventType: "ENTRY",
          eventOn: "2020-01-01",
          apartmentId: apartments.leftBeforeGap,
        },
        {
          eventType: "EXIT",
          eventOn: "2026-09-30",
          apartmentId: apartments.leftBeforeGap,
        },
        {
          eventType: "ENTRY",
          eventOn: "2026-12-01",
          apartmentId: apartments.boughtAfterGap,
        },
      ]);
    } finally {
      send.mockRestore();
    }
  });
});

describe("when the mail server is refusing", () => {
  it("keeps the register write and the board reminder", async () => {
    // Both writes have committed by the time a message is sent, and neither can
    // be taken back: the member register refuses UPDATE and DELETE, and a
    // second move-out on the same residency is refused. So a mail failure must
    // not reject the request, and the reminder - the only part that cannot be
    // reconstructed afterwards - is written by the same transaction as the
    // register, which is before any message is attempted and before there is a
    // committed move-out for it to be missing from.
    const order: string[] = [];
    const send = vi.spyOn(mail, "send").mockImplementation(async () => {
      order.push("mail");
      throw new Error("smtp refused the connection");
    });
    const jobs = app.get(JobQueueService);
    const sendAt = vi
      .spyOn(jobs, "sendAtInTransaction")
      .mockImplementation(async () => {
        order.push("reminder");
      });

    try {
      const moveIn = await moves.moveIn({
        actorPersonId: actors.board.personId,
        personId: actors.mover.personId,
        apartmentId: apartments.outage,
        role: "MEMBER",
        movedInOn: "2024-02-01",
      });
      expect(moveIn.memberRegisterEntryRecorded).toBe(true);
      // Reported as not sent rather than reported as a failed move-in.
      expect(moveIn.welcomeEmailSent).toBe(false);

      order.length = 0;
      const moveOut = await moves.moveOut({
        residencyId: moveIn.residencyId,
        movedOutOn: "2026-02-01",
      });

      expect(moveOut.memberRegisterExitRecorded).toBe(true);
      expect(order).toEqual(["reminder", "mail"]);
      expect(sendAt).toHaveBeenCalledTimes(1);
      expect(
        (await registerEntries(actors.mover.personId)).map(
          (entry) => entry.eventType,
        ),
      ).toEqual(["ENTRY", "EXIT"]);
    } finally {
      send.mockRestore();
      sendAt.mockRestore();
    }
  });

  it("sends the reminder to the rest of the board past a failing recipient", async () => {
    // The job is retried from the first recipient, so a rejection escaping the
    // loop would send the reminder twice to everyone before the failure and
    // never to anyone after it.
    const residency = await prisma.residency.create({
      data: {
        personId: actors.mover.personId,
        apartmentId: apartments.partial,
        role: "RESIDENT",
        movedInOn: new Date("2024-03-01T00:00:00.000Z"),
        movedOutOn: new Date("2026-03-01T00:00:00.000Z"),
      },
      select: { id: true },
    });

    let attempts = 0;
    const send = vi.spyOn(mail, "send").mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("mailbox unavailable");
      }
      return { messageId: null };
    });

    try {
      const sent = await moves.sendBoardMoveOutReminder(residency.id);

      // Counted against what was attempted rather than an absolute: the
      // integration database carries the seeded association's board as well as
      // this suite's, and how many people sit on it is not what is under test.
      expect(attempts).toBeGreaterThan(1);
      // Every recipient was attempted, and only the delivered ones counted.
      expect(sent).toBe(attempts - 1);
    } finally {
      send.mockRestore();
    }
  });
});

describe("the board's move-out reminder", () => {
  it("reaches the board through the job queue", async () => {
    // The reminder is the one part of the move-out that happens later, so it is
    // worth nothing unless the queue actually delivers it. The queue and the
    // worker are started here rather than at boot, so nothing races the tests
    // above.
    const queue = app.get(JobQueueService);
    await queue.start();

    let resolveReminder: (props: BoardMoveOutReminderMailProps) => void = () =>
      undefined;
    const reminder = new Promise<BoardMoveOutReminderMailProps>((resolve) => {
      resolveReminder = resolve;
    });

    const send = vi.spyOn(mail, "send").mockImplementation(async (input) => {
      const message = input as unknown as CapturedMail;
      if (
        message.template.id === "board-move-out-reminder" &&
        message.props.apartmentNumber === "1104"
      ) {
        resolveReminder(
          message.props as unknown as BoardMoveOutReminderMailProps,
        );
      }
      return { messageId: null };
    });

    try {
      await moves.startBoardReminderWorker();

      await moves.moveIn({
        actorPersonId: actors.board.personId,
        personId: actors.leaver.personId,
        apartmentId: apartments.reminder,
        role: "RESIDENT",
        movedInOn: "2024-01-01",
      });
      const residency = await prisma.residency.findFirstOrThrow({
        where: {
          personId: actors.leaver.personId,
          apartmentId: apartments.reminder,
        },
        select: { id: true },
      });

      // A move-out entered after the fact is scheduled for a date already past,
      // which the queue runs at once - and which is the case a board actually
      // produces, because the paperwork arrives late.
      const result = await moves.moveOut({
        residencyId: residency.id,
        movedOutOn: "2026-01-31",
      });

      const props = await reminder;
      expect(props.personName).toBe(`Lena ${surname}`);
      expect(props.purgeOn.toISOString().slice(0, 10)).toBe(result.purgeOn);
    } finally {
      send.mockRestore();
    }
  }, 60_000);
});
