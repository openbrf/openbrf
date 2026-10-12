import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { dateColumnOf, localDayOf } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { BoardMailboxPurgeService } from "../board-mailbox/board-mailbox-purge.service";
import { BookingPurgeService } from "../bookings/booking-purge.service";
import { ChatPurgeService } from "../chat/chat-purge.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { EventSignupPurgeService } from "../events/event-signup-purge.service";
import { KeyOrderPurgeService } from "../key-orders/key-order-purge.service";
import { MotionPurgeService } from "../motions/motion-purge.service";
import { NewsCommentPurgeService } from "../news/news-comment-purge.service";
import { SubletPurgeService } from "../sublets/sublet-purge.service";
import { grantErasure } from "../testing/erasure-requests";
import { runSuffix } from "../testing/integration-env";
import { ERASURE_DOMAINS } from "./erasure-domains";
import { PurgeService } from "./purge.service";

/**
 * What refuses a granted erasure, asked of every job that carries one out.
 *
 * A granted request brings the purge forward and lifts the retention window,
 * and nothing else: a legal hold, a restriction of processing, a residency or
 * a board seat that has not ended, and a system role each refuse it
 * (`withheld-persons.ts`, `nothingRefusesErasure`). Eight domain jobs erase a
 * person's rows on the request and the service-data purge then erases the
 * contact details and closes it. Each of the nine asks the question itself,
 * inside its own transaction, so each can drift on its own back to the older
 * check that asked only about a hold - and a sitting board member's messages
 * or a resident's bookings would go while the closing job refused the same
 * request that night.
 *
 * So one table of refusals, run against every job. Each row a job is handed
 * here is inside its own retention window, which leaves the request as the
 * only thing that could erase it: the control erases it, and every refusal
 * keeps it. The jobs are matched against `ERASURE_DOMAINS` by name, so a domain
 * registered later fails here until it is given a fixture and held to the same
 * table.
 *
 * Each job is driven for one person or one thread rather than through `run`,
 * which scans the whole database the suites share.
 */

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let associationCreatedHere = false;

const suffix = runSuffix();
const DAY = 24 * 60 * 60 * 1000;

/** The moment every job judges at. */
const NOW = new Date();
/** Yesterday, which no retention window has run out on. */
const RECENT = new Date(NOW.getTime() - DAY);
const TOMORROW = new Date(NOW.getTime() + DAY);

/** A `@db.Date` column for the day so many days from now. */
function dayColumn(days: number): Date {
  return dateColumnOf(localDayOf(new Date(NOW.getTime() + days * DAY)));
}

/** Who places the holds and decides the requests. */
const deciderId = `refusal-decider-${suffix}`;
const addressId = `refusal-address-${suffix}`;
const apartmentId = `refusal-apartment-${suffix}`;

/** The rows the domain rows hang from, made once. */
let resourceId: string;
let chatId: string;
let eventId: string;
let occurrenceId: string;
let newsId: string;

/** Every person a test made, for the clean-up. */
const personIds: string[] = [];

/** Booked an hour apart, so no two rows meet the one-live-booking index. */
let bookingHour = 0;

/** One row a job erases on the request, and how to tell it is still there. */
interface Seeded {
  /** Runs the job over it, as the night would. */
  erase(): Promise<unknown>;
  standing(): Promise<boolean>;
}

/** A job that carries out a granted erasure, and a row for it to carry out. */
interface ErasureJob {
  /**
   * The domain's name in `ERASURE_DOMAINS`, or the closing job's, which is in
   * no registry because it is the one the registry is for.
   */
  readonly name: string;
  seed(personId: string): Promise<Seeded>;
}

const CLOSING_JOB = "the service-data purge";

const JOBS: readonly ErasureJob[] = [
  {
    name: "board mailbox threads",
    async seed(personId) {
      const correspondent = await encryption.encrypt(
        "boardMailboxThread.correspondentEmail",
        `${personId}@exempel.se`,
      );
      const { id } = await prisma.boardMailboxThread.create({
        data: {
          subject: `Avgransad ${personId}`,
          correspondentEmailCipher: correspondent.cipher,
          correspondentEmailIndex: correspondent.index,
          correspondentPersonId: personId,
          lastMessageAt: RECENT,
        },
        select: { id: true },
      });
      return {
        erase: () => app.get(BoardMailboxPurgeService).purgeThread(id, NOW),
        standing: async () =>
          (await prisma.boardMailboxThread.count({ where: { id } })) > 0,
      };
    },
  },
  {
    name: "bookings",
    async seed(personId) {
      bookingHour += 1;
      const startsAt = new Date(
        NOW.getTime() + 2 * DAY + bookingHour * 3_600_000,
      );
      const { id } = await prisma.booking.create({
        data: {
          resourceId,
          bookedByPersonId: personId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
        },
        select: { id: true },
      });
      return {
        erase: () => app.get(BookingPurgeService).purgePerson(personId, NOW),
        standing: async () =>
          (await prisma.booking.count({ where: { id } })) > 0,
      };
    },
  },
  {
    name: "chat",
    async seed(personId) {
      const { id } = await prisma.chatMessage.create({
        data: {
          chatId,
          authorPersonId: personId,
          body: "Hej.",
          createdAt: RECENT,
        },
        select: { id: true },
      });
      return {
        erase: () => app.get(ChatPurgeService).purgePerson(personId, NOW),
        standing: async () =>
          (await prisma.chatMessage.count({ where: { id } })) > 0,
      };
    },
  },
  {
    name: "event sign-ups",
    async seed(personId) {
      const { id } = await prisma.eventSignup.create({
        data: { occurrenceId, personId },
        select: { id: true },
      });
      return {
        erase: () =>
          app.get(EventSignupPurgeService).purgePerson(personId, NOW),
        standing: async () =>
          (await prisma.eventSignup.count({ where: { id } })) > 0,
      };
    },
  },
  {
    name: "key orders",
    async seed(personId) {
      const { id } = await prisma.keyOrder.create({
        data: {
          orderedByPersonId: personId,
          kind: "KEY",
          status: "HANDED_OVER",
          closedAt: RECENT,
        },
        select: { id: true },
      });
      return {
        erase: () => app.get(KeyOrderPurgeService).purgePerson(personId, NOW),
        standing: async () =>
          (await prisma.keyOrder.count({ where: { id } })) > 0,
      };
    },
  },
  {
    name: "motions",
    async seed(personId) {
      const { id } = await prisma.motion.create({
        data: {
          title: `Motion ${personId}`,
          body: "Att foreningen satter upp en cykelstallning.",
          submittedByPersonId: personId,
          status: "ACKNOWLEDGED",
          closedAt: RECENT,
        },
        select: { id: true },
      });
      return {
        erase: () => app.get(MotionPurgeService).purgePerson(personId, NOW),
        standing: async () =>
          (await prisma.motion.count({ where: { id } })) > 0,
      };
    },
  },
  {
    name: "news comments",
    async seed(personId) {
      const { id } = await prisma.newsComment.create({
        data: {
          newsId,
          authorPersonId: personId,
          body: "Tack for informationen.",
          createdAt: RECENT,
        },
        select: { id: true },
      });
      return {
        erase: () =>
          app.get(NewsCommentPurgeService).purgePerson(personId, NOW),
        standing: async () =>
          (await prisma.newsComment.count({ where: { id } })) > 0,
      };
    },
  },
  {
    name: "subletting applications",
    async seed(personId) {
      // Withdrawn last month: closed, and no consented letting still running.
      const { id } = await prisma.subletApplication.create({
        data: {
          appliedByPersonId: personId,
          periodFrom: dayColumn(-60),
          periodTo: dayColumn(-1),
          reason: "Arbete pa annan ort.",
          status: "WITHDRAWN",
          closedAt: RECENT,
        },
        select: { id: true },
      });
      return {
        erase: () => app.get(SubletPurgeService).purgePerson(personId, NOW),
        standing: async () =>
          (await prisma.subletApplication.count({ where: { id } })) > 0,
      };
    },
  },
  {
    // The contact details, which only the request erases from somebody who
    // never moved out because they never moved in.
    name: CLOSING_JOB,
    async seed(personId) {
      const email = await encryption.encrypt(
        "person.email",
        `${personId}@exempel.se`,
      );
      await prisma.person.update({
        where: { id: personId },
        data: { emailCipher: email.cipher, emailIndex: email.index },
      });
      return {
        erase: () => app.get(PurgeService).purgePerson(personId, NOW),
        standing: async () =>
          (
            await prisma.person.findUniqueOrThrow({
              where: { id: personId },
              select: { emailCipher: true },
            })
          ).emailCipher !== null,
      };
    },
  },
];

/** One thing that refuses an erasure, placed on a person. */
interface Refusal {
  readonly name: string;
  impose(personId: string): Promise<unknown>;
}

const REFUSALS: readonly Refusal[] = [
  {
    name: "a legal hold",
    impose: (personId) =>
      prisma.legalHold.create({
        data: {
          personId,
          reason: `Tvist ${suffix}`,
          placedByPersonId: deciderId,
        },
      }),
  },
  {
    name: "a restriction of processing",
    impose: (personId) =>
      prisma.person.update({
        where: { id: personId },
        data: { processingRestrictedAt: RECENT },
      }),
  },
  {
    name: "a residency with no end",
    impose: (personId) =>
      prisma.residency.create({
        data: {
          personId,
          apartmentId,
          role: "RESIDENT",
          movedInOn: dayColumn(-400),
        },
      }),
  },
  {
    // Moving out tomorrow is living here today.
    name: "a residency that ends tomorrow",
    impose: (personId) =>
      prisma.residency.create({
        data: {
          personId,
          apartmentId,
          role: "RESIDENT",
          movedInOn: dayColumn(-400),
          movedOutOn: TOMORROW,
        },
      }),
  },
  {
    name: "a board seat with no end",
    impose: (personId) =>
      prisma.boardPosition.create({
        data: {
          personId,
          position: "BOARD_MEMBER",
          electedOn: dayColumn(-100),
        },
      }),
  },
  {
    name: "a board seat that ends tomorrow",
    impose: (personId) =>
      prisma.boardPosition.create({
        data: {
          personId,
          position: "DEPUTY_BOARD_MEMBER",
          electedOn: dayColumn(-100),
          endedOn: TOMORROW,
        },
      }),
  },
  {
    name: "a system role",
    impose: (personId) =>
      prisma.systemRole.create({
        data: { personId, role: "PROPERTY_MANAGER" },
      }),
  },
];

/** A person granted erasure, with one row for the job and nothing else. */
async function personWithGrantedErasure(
  job: ErasureJob,
  label: string,
): Promise<{ personId: string; requestId: string; seeded: Seeded }> {
  const personId = `refusal-${String(personIds.length)}-${suffix}`;
  personIds.push(personId);
  await prisma.person.create({
    data: { id: personId, firstName: "Rut", lastName: `${label} ${suffix}` },
  });
  const seeded = await job.seed(personId);
  const request = await grantErasure(prisma, personId, deciderId, RECENT);
  return { personId, requestId: request.id, seeded };
}

/** Whether the person's request is still granted and not carried out. */
async function requestOpen(requestId: string): Promise<boolean> {
  const request = await prisma.dataSubjectRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { executedAt: true, closedAt: true },
  });
  return request.executedAt === null && request.closedAt === null;
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

  // The service-data purge reads the association's settings.
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

  await prisma.person.create({
    data: { id: deciderId, firstName: "Bo", lastName: `Beslut ${suffix}` },
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: "Raderingsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: { id: apartmentId, number: "1201", floor: 2 },
      },
    },
  });

  resourceId = (
    await prisma.bookableResource.create({
      data: { name: `Tvattstuga ${suffix}`, mode: "WHOLE_DAY" },
      select: { id: true },
    })
  ).id;
  chatId = (
    await prisma.chat.create({
      data: { kind: "GROUP", name: `Grupp ${suffix}` },
      select: { id: true },
    })
  ).id;
  eventId = (
    await prisma.event.create({
      data: {
        title: `Stadday ${suffix}`,
        authorPersonId: deciderId,
        firstOn: dayColumn(2),
        startsAtMinute: 600,
        durationMinutes: 240,
      },
      select: { id: true },
    })
  ).id;
  occurrenceId = (
    await prisma.eventOccurrence.create({
      data: {
        eventId,
        startsAt: new Date(NOW.getTime() + 2 * DAY),
        endsAt: new Date(NOW.getTime() + 2 * DAY + 4 * 3_600_000),
      },
      select: { id: true },
    })
  ).id;
  newsId = (
    await prisma.news.create({
      data: {
        slug: `radering-${suffix}`,
        title: `Nyhet ${suffix}`,
        content: { blocks: [] },
      },
      select: { id: true },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    await run().catch((cause: unknown) => failures.push(cause));
  };
  const everyone = [...personIds, deciderId];

  await step(() =>
    prisma.boardMailboxThread.deleteMany({
      where: { correspondentPersonId: { in: personIds } },
    }),
  );
  await step(() =>
    prisma.booking.deleteMany({
      where: { bookedByPersonId: { in: personIds } },
    }),
  );
  await step(() =>
    prisma.bookableResource.deleteMany({ where: { id: resourceId } }),
  );
  // Each cascades to what hangs from it.
  await step(() => prisma.chat.deleteMany({ where: { id: chatId } }));
  await step(() => prisma.event.deleteMany({ where: { id: eventId } }));
  await step(() =>
    prisma.keyOrder.deleteMany({
      where: { orderedByPersonId: { in: personIds } },
    }),
  );
  await step(() =>
    prisma.motion.deleteMany({
      where: { submittedByPersonId: { in: personIds } },
    }),
  );
  await step(() =>
    prisma.newsComment.deleteMany({
      where: { authorPersonId: { in: personIds } },
    }),
  );
  await step(() => prisma.news.deleteMany({ where: { id: newsId } }));
  await step(() =>
    prisma.subletApplication.deleteMany({
      where: { appliedByPersonId: { in: personIds } },
    }),
  );
  await step(() =>
    prisma.dataSubjectRequest.deleteMany({
      where: { personId: { in: personIds } },
    }),
  );
  await step(() =>
    prisma.legalHold.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() =>
    prisma.residency.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() =>
    prisma.boardPosition.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() =>
    prisma.systemRole.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() => prisma.apartment.deleteMany({ where: { id: apartmentId } }));
  await step(() => prisma.address.deleteMany({ where: { id: addressId } }));
  await step(() =>
    prisma.person.deleteMany({ where: { id: { in: everyone } } }),
  );
  if (associationCreatedHere) {
    await step(() => prisma.association.deleteMany({ where: { id: 1 } }));
  }
  await app.close();

  if (failures.length > 0) {
    throw new AggregateError(failures, "erasure refusal clean-up failed");
  }
});

describe("the jobs that carry out a granted erasure", () => {
  it("are every domain the closing job verifies, and the closing job", () => {
    expect(JOBS.map((job) => job.name).sort()).toEqual(
      [...ERASURE_DOMAINS.map((domain) => domain.name), CLOSING_JOB].sort(),
    );
  });
});

describe.each(JOBS)("$name", (job) => {
  it("carries out a granted erasure that nothing refuses", async () => {
    // The control: without it every refusal below would pass against a job
    // that erased nothing at all.
    const { requestId, seeded } = await personWithGrantedErasure(job, "Fri");

    await seeded.erase();

    expect(await seeded.standing()).toBe(false);
    if (job.name === CLOSING_JOB) {
      expect(await requestOpen(requestId)).toBe(false);
    }
  });

  it.each(REFUSALS)("is refused by $name", async (refusal) => {
    const { personId, requestId, seeded } = await personWithGrantedErasure(
      job,
      "Hindrad",
    );
    await refusal.impose(personId);

    await seeded.erase();

    expect(await seeded.standing()).toBe(true);
    expect(await requestOpen(requestId)).toBe(true);
  });
});
