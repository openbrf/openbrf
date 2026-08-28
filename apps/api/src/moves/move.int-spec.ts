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
import { MoveService } from "./move.service";

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

  await prisma.residency.create({
    data: {
      personId: actors.resident.personId,
      apartmentId: apartments.first,
      role: "RESIDENT",
      movedInOn: new Date("2022-01-01T00:00:00.000Z"),
    },
  });

  await prisma.boardPosition.create({
    data: {
      personId: actors.board.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15T00:00:00.000Z"),
    },
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
