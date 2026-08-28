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
        "x-forwarded-for": `10.7.0.${String(ipCounter % 250)}`,
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

  await prisma.residency.create({
    data: {
      personId: actors.resident.personId,
      apartmentId: apartments.first,
      role: "RESIDENT",
      movedInOn: new Date("2022-01-01T00:00:00.000Z"),
    },
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

describe("moving in", () => {
  it("creates the residency, writes the register entry and welcomes the person in their own language", async () => {
    const sent: CapturedMail[] = [];
    const send = vi.spyOn(mail, "send").mockImplementation(async (input) => {
      sent.push(input as unknown as CapturedMail);
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
    const send = vi.spyOn(mail, "send").mockResolvedValue(undefined);

    try {
      await Promise.all([
        moves.moveIn({
          personId: actors.racer.personId,
          apartmentId: apartments.raceA,
          role: "MEMBER",
          movedInOn: "2025-01-01",
        }),
        moves.moveIn({
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
        transfer: { transferredOn: "2026-03-20", agreementReference: "   " },
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
    const send = vi.spyOn(mail, "send").mockResolvedValue(undefined);

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
    const send = vi.spyOn(mail, "send").mockResolvedValue(undefined);

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
    const send = vi.spyOn(mail, "send").mockResolvedValue(undefined);
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
    });

    try {
      await moves.startBoardReminderWorker();

      await moves.moveIn({
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
