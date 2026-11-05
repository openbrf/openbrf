import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { MediaService } from "../media/media.service";
import { pngBytes } from "../media/testing/image-fixtures";
import { erasureRemainder } from "../retention/erasure-domains";
import { PurgeService } from "../retention/purge.service";
import { StorageService } from "../storage/storage.service";
import { grantErasure } from "../testing/erasure-requests";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { IssueErasureService } from "./issue-erasure.service";
import {
  IssueFreeTextService,
  type FreeTextRemoval,
} from "./issue-free-text.service";
import { IssueRedactionService } from "./issue-redaction.service";
import { IssueTextPurgeService } from "./issue-text-purge.service";
import { IssueService } from "./issue.service";
import { WorkOrderMailerService } from "./work-order-mailer.service";

/**
 * An issue's two layers (ADR 0057, decision 33), against a real database.
 *
 * The clock removes the free-text layer - the description, the location, the
 * conversation, the notes and every file, from storage - once the issue has
 * been closed for the board's number of years, and leaves the building record:
 * the type, the status, the outcome, the apartment, the dates, the priority. A
 * legal hold on the issue, or a legal hold or a restriction on its reporter,
 * keeps it. A handler redacts a text or removes a file at any time, recorded
 * without the text, unless one of those stands. A granted erasure
 * request removes the free text of the issues the person reported on the date
 * the board granted, keeps an open or held one and says so, and the person
 * purge detaches the reporter only from an issue whose text is gone, so a
 * request granted after the person's own window still finds the issue. A
 * handler redacts a work order's text the same way, and the work order stays.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let media: MediaService;
let storage: StorageService;
let clock: IssueTextPurgeService;
let freeText: IssueFreeTextService;
let erasure: IssueErasureService;
let personPurge: PurgeService;
let redaction: IssueRedactionService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const DAY = 24 * 60 * 60 * 1000;

const board = {
  personId: `ir-board-${suffix}`,
  email: `ir-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `ir-resident-${suffix}`,
  email: `ir-resident-${suffix}@exempel.se`,
};
/** A reporter under a legal hold of their own. */
const heldReporterId = `ir-held-${suffix}`;
/** Former residents, whose erasure a test grants. */
const formerIds = [1, 2, 3, 4, 5].map(
  (n) => `ir-former-${String(n)}-${suffix}`,
);
/** Reporters whose erasure was carried out, one of them held since. */
const erasedReporterId = `ir-erased-${suffix}`;
const erasedHeldReporterId = `ir-erased-held-${suffix}`;
const personIds = [
  board.personId,
  resident.personId,
  heldReporterId,
  ...formerIds,
  erasedReporterId,
  erasedHeldReporterId,
];

const addressId = `ir-address-${suffix}`;
const apartmentId = `ir-apartment-${suffix}`;
const typeId = `ir-type-${suffix}`;
let type: IssueTypeFixture;

let boardCookie = "";
let residentCookie = "";
let associationCreatedHere = false;
let previousYears = 2;

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
        // 10.209.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.209.${String(subnet)}.${String(host + 1)}`,
        ...options.headers,
      },
    });
}

/**
 * Silences and watches the line the redaction service logs for an act that
 * changed something. The spy is on the service's own logger, so what another
 * service logs neither fills it nor is silenced, and a check that it was never
 * called does not depend on the words of a line.
 */
function spyOnRedactionLog() {
  return vi.spyOn(redaction["logger"], "log").mockImplementation(() => {});
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

const DESCRIPTION = `Fuktflack i badrummet hos grannen ${suffix}`;
const LOCATION = `Badrummet i 0101 ${suffix}`;
const MESSAGE = `Vi kommer på tisdag ${suffix}`;
const NOTE = `Grannen har hund ${suffix}`;
const WORK_ORDER_TEXT = `Byt packningen hos grannen i 0101 ${suffix}`;

/** A work order on an issue, as the sending leaves one. */
async function createWorkOrder(
  issueId: string,
  input: {
    body?: string | null;
    deliveryStatus?: "PENDING" | "SENT";
  } = {},
): Promise<string> {
  const order = await prisma.workOrder.create({
    data: {
      issueId,
      recipientName: `Rormokare ${suffix}`,
      recipientEmailCipher: "kept-as-it-was",
      body: input.body === undefined ? WORK_ORDER_TEXT : input.body,
      sentByPersonId: board.personId,
      deliveryStatus: input.deliveryStatus ?? "SENT",
    },
    select: { id: true },
  });
  return order.id;
}

async function readWorkOrder(id: string) {
  return prisma.workOrder.findUniqueOrThrow({
    where: { id },
    select: {
      body: true,
      redactedAt: true,
      recipientName: true,
      recipientEmailCipher: true,
      deliveryStatus: true,
      deliveryFailure: true,
      createdAt: true,
    },
  });
}

/**
 * A closed issue whose free-text layer is already gone and on which only a
 * work order's text stands, reported by `reporterPersonId`.
 */
async function seedWithOnlyWorkOrderText(
  reporterPersonId: string,
): Promise<{ id: string; workOrderId: string }> {
  const issue = await prisma.issue.create({
    data: {
      typeId,
      statusId: type.statusIds.DONE,
      outcome: "FIXED",
      priority: "NORMAL",
      reporterPersonId,
      apartmentId,
      location: null,
      description: "",
      closedAt: new Date(Date.now() - 400 * DAY),
      freeTextRemovedAt: new Date(Date.now() - 30 * DAY),
    },
    select: { id: true },
  });
  return { id: issue.id, workOrderId: await createWorkOrder(issue.id) };
}

interface SeededIssue {
  id: string;
  messageId: string;
  noteId: string;
  photo: { id: string; fileId: string; storageKey: string };
  attachment: { id: string; fileId: string; storageKey: string };
}

/** A file in storage, as the upload path leaves one. */
async function upload(): Promise<{ fileId: string; storageKey: string }> {
  const file = await media.upload({
    bytes: pngBytes(24, 24),
    fileName: `bild-${suffix}.png`,
    visibility: "INTERNAL",
    requiredCapability: "issues:handle",
    showsIdentifiablePersons: true,
    uploadedByPersonId: board.personId,
    channel: "WEB",
  });
  const row = await prisma.mediaFile.findUniqueOrThrow({
    where: { id: file.id },
    select: { storageKey: true },
  });
  return { fileId: file.id, storageKey: row.storageKey };
}

/**
 * An issue with every part of the free-text layer: a description, a location,
 * a message, a note, a reporter's photograph and a handler's file. Closed
 * `closedDaysAgo` days ago, or open when that is null.
 */
async function seed(input: {
  reporterPersonId: string | null;
  closedDaysAgo: number | null;
  statusId?: string;
}): Promise<SeededIssue> {
  const closed = input.closedDaysAgo !== null;
  const issue = await prisma.issue.create({
    data: {
      typeId,
      statusId:
        input.statusId ??
        (closed ? type.statusIds.DONE : type.statusIds.IN_PROGRESS),
      outcome: closed ? "FIXED" : null,
      priority: "URGENT",
      reporterPersonId: input.reporterPersonId,
      apartmentId,
      location: LOCATION,
      description: DESCRIPTION,
      closedAt:
        input.closedDaysAgo === null
          ? null
          : new Date(Date.now() - input.closedDaysAgo * DAY),
      createdAt: new Date("2021-03-01T08:00:00Z"),
    },
    select: { id: true },
  });
  const message = await prisma.issueMessage.create({
    data: {
      issueId: issue.id,
      side: "REPORTER",
      authorPersonId: input.reporterPersonId,
      body: MESSAGE,
    },
  });
  const note = await prisma.issueNote.create({
    data: { issueId: issue.id, authorPersonId: board.personId, body: NOTE },
  });
  const photoFile = await upload();
  const photo = await prisma.issuePhoto.create({
    data: { issueId: issue.id, fileId: photoFile.fileId },
  });
  const attachmentFile = await upload();
  const attachment = await prisma.issueAttachment.create({
    data: { issueId: issue.id, fileId: attachmentFile.fileId },
  });
  return {
    id: issue.id,
    messageId: message.id,
    noteId: note.id,
    photo: { id: photo.id, ...photoFile },
    attachment: { id: attachment.id, ...attachmentFile },
  };
}

/** Everything the issue still holds, of both layers. */
async function read(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: {
      typeId: true,
      statusId: true,
      outcome: true,
      priority: true,
      apartmentId: true,
      createdAt: true,
      closedAt: true,
      reporterPersonId: true,
      description: true,
      descriptionRedactedAt: true,
      location: true,
      locationRedactedAt: true,
      freeTextRemovedAt: true,
      legalHoldAt: true,
      _count: {
        select: {
          messages: true,
          notes: true,
          photos: true,
          attachments: true,
        },
      },
    },
  });
}

async function stored(storageKey: string): Promise<boolean> {
  const stream = await storage.open(storageKey);
  stream?.destroy();
  return stream !== null;
}

/** The entries written about one issue, by action. */
async function entriesFor(issueId: string, action: string) {
  return prisma.auditLogEntry.findMany({
    where: {
      targetKind: "issue",
      targetId: issueId,
      action: action as "ISSUE_REDACTED",
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** A former resident, eligible for erasure, with contact details on file. */
async function createFormerResident(id: string, movedOutOn: Date) {
  const email = await encryption.encrypt("person.email", `${id}@exempel.se`);
  await prisma.person.create({
    data: {
      id,
      firstName: "Fia",
      lastName: "Flyttad",
      emailCipher: email.cipher,
      emailIndex: email.index,
    },
  });
  await prisma.residency.create({
    data: {
      personId: id,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2019-01-01"),
      movedOutOn,
    },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(baseEnv)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  encryption = app.get(FieldEncryptionService);
  media = app.get(MediaService);
  storage = app.get(StorageService);
  clock = app.get(IssueTextPurgeService);
  freeText = app.get(IssueFreeTextService);
  erasure = app.get(IssueErasureService);
  personPurge = app.get(PurgeService);
  redaction = app.get(IssueRedactionService);

  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { issueTextRetentionYears: true },
  });
  associationCreatedHere = existing === null;
  previousYears = existing?.issueTextRetentionYears ?? 2;
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Gallringsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "0101", floor: 1 },
  });

  for (const person of [
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...resident, firstName: "Rune", lastName: "Boende" },
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
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: board.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2024-01-01"),
      },
      {
        personId: resident.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2024-01-01"),
      },
    ],
  });
  await prisma.person.create({
    data: { id: heldReporterId, firstName: "Hedda", lastName: "Hallen" },
  });
  for (const id of [erasedReporterId, erasedHeldReporterId]) {
    await prisma.person.create({
      data: { id, firstName: "Erik", lastName: "Raderad" },
    });
    const request = await grantErasure(prisma, id, board.personId);
    await prisma.dataSubjectRequest.update({
      where: { id: request.id },
      data: { executedAt: new Date() },
    });
  }
  await prisma.legalHold.create({
    data: {
      personId: heldReporterId,
      reason: "Tvist om vattenskada",
      placedByPersonId: board.personId,
    },
  });

  type = await createIssueTypeFixture(prisma, {
    id: typeId,
    name: `Vattenskada ${suffix}`,
    reporters: ["RESIDENTS"],
  });

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

afterAll(async () => {
  // The objects first: the rows are their only record.
  const files = await prisma.mediaFile.findMany({
    where: { uploadedByPersonId: board.personId },
    select: { id: true, storageKey: true },
  });
  for (const file of files) {
    await storage.remove(file.storageKey);
  }
  await prisma.mediaFile.deleteMany({
    where: { id: { in: files.map((file) => file.id) } },
  });
  await prisma.issue.deleteMany({ where: { typeId } });
  await prisma.issueType.deleteMany({ where: { id: typeId } });
  await prisma.dataSubjectRequest.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.legalHold.deleteMany({ where: { personId: { in: personIds } } });
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
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({ where: { id: apartmentId } });
  await prisma.address.deleteMany({ where: { id: addressId } });

  if (associationCreatedHere) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  } else {
    await prisma.association.update({
      where: { id: 1 },
      data: { issueTextRetentionYears: previousYears },
    });
  }

  await app.close();
});

describe("the clock", () => {
  it("removes the free text and the files of an issue past it, and keeps the building record", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 2 * 365 + 1,
    });
    const before = await read(issue.id);

    expect(await clock.eligible(new Date(), 2)).toContain(issue.id);
    expect(await clock.purgeIssue(issue.id, new Date(), 2)).toBe("removed");

    const after = await read(issue.id);
    // The free-text layer is gone, from storage too.
    expect(after.description).toBe("");
    expect(after.location).toBeNull();
    expect(after._count).toEqual({
      messages: 0,
      notes: 0,
      photos: 0,
      attachments: 0,
    });
    expect(after.freeTextRemovedAt).not.toBeNull();
    for (const file of [issue.photo, issue.attachment]) {
      expect(
        await prisma.mediaFile.findUnique({ where: { id: file.fileId } }),
      ).toBeNull();
      expect(await stored(file.storageKey)).toBe(false);
    }
    // The building record stays: what, where, when and the outcome.
    expect({
      typeId: after.typeId,
      statusId: after.statusId,
      outcome: after.outcome,
      priority: after.priority,
      apartmentId: after.apartmentId,
      createdAt: after.createdAt,
      closedAt: after.closedAt,
    }).toEqual({
      typeId: before.typeId,
      statusId: before.statusId,
      outcome: before.outcome,
      priority: before.priority,
      apartmentId: before.apartmentId,
      createdAt: before.createdAt,
      closedAt: before.closedAt,
    });
    // The reporter stays until the person purge finds the text gone.
    expect(after.reporterPersonId).toBe(resident.personId);

    // Recorded with counts, never with a word of what went.
    const [entry] = await entriesFor(issue.id, "SERVICE_DATA_PURGED");
    expect(entry?.context).toMatchObject({
      layer: "freeText",
      issueMessages: 1,
      internalNotes: 1,
      files: 2,
      retentionYearsAfterClosing: 2,
    });
    const files = await prisma.auditLogEntry.findMany({
      where: {
        action: "MEDIA_DELETED",
        targetId: { in: [issue.photo.fileId, issue.attachment.fileId] },
      },
    });
    expect(files).toHaveLength(2);
    const written = JSON.stringify([entry, ...files]);
    for (const text of [DESCRIPTION, LOCATION, MESSAGE, NOTE, "bild-"]) {
      expect(written).not.toContain(text);
    }

    // Nothing is left to select, so nothing is written again tomorrow.
    expect(await clock.eligible(new Date(), 2)).not.toContain(issue.id);
  });

  it("writes nothing a second time when another run already took the layer", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 2 * 365 + 1,
    });
    expect(await clock.purgeIssue(issue.id, new Date(), 2)).toBe("removed");
    const first = (await read(issue.id)).freeTextRemovedAt;

    // A run whose scan was taken before the first committed asks again.
    expect(
      await clock.purgeIssue(issue.id, new Date(Date.now() + DAY), 2),
    ).toBe("kept");

    expect((await read(issue.id)).freeTextRemovedAt).toEqual(first);
    expect(await entriesFor(issue.id, "SERVICE_DATA_PURGED")).toHaveLength(1);
  });

  it("reads on past an issue whose removal failed, so newer ones are reached", async () => {
    const oldest = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 5 * 365,
    });
    const newer = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 4 * 365,
    });

    // The page after the oldest starts at the next issue, not at the oldest.
    const firstPage = await clock.eligiblePage(new Date(), 2);
    const index = firstPage.findIndex((entry) => entry.id === oldest.id);
    expect(index).toBeGreaterThanOrEqual(0);
    const at = firstPage[index];
    if (at === undefined) throw new Error("the oldest issue is on the page");
    const after = await clock.eligiblePage(new Date(), 2, {
      closedAt: at.closedAt,
      id: at.id,
    });
    expect(after.map((entry) => entry.id)).not.toContain(oldest.id);
    expect(after.map((entry) => entry.id)).toContain(newer.id);

    // And a run whose removal of the oldest keeps failing still takes the rest.
    // It reads one issue at a time, so the newer issue is on a later page than
    // the oldest and a run that reads only its first page never reaches it.
    const refuse = vi
      .spyOn(storage, "remove")
      .mockImplementation((key: string) =>
        key === oldest.photo.storageKey
          ? Promise.reject(new Error("The storage is unreachable."))
          : Promise.resolve(),
      );
    try {
      const summary = await clock.run(new Date(), 2, 1);
      expect(summary.failed).toBeGreaterThanOrEqual(1);
    } finally {
      refuse.mockRestore();
    }
    expect((await read(oldest.id)).description).toBe(DESCRIPTION);
    expect((await read(newer.id)).freeTextRemovedAt).not.toBeNull();
  });

  it("does not reach an issue inside the clock, an open one, or one past a longer clock", async () => {
    const recent = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 2 * 365 - 1,
    });
    const open = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const threeYears = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 3 * 365 + 1,
    });

    const eligible = await clock.eligible(new Date(), 2);
    expect(eligible).not.toContain(recent.id);
    expect(eligible).not.toContain(open.id);
    expect(eligible).toContain(threeYears.id);
    // The board's ten years keeps the three-year-old issue.
    expect(await clock.eligible(new Date(), 10)).not.toContain(threeYears.id);
    expect(await clock.purgeIssue(threeYears.id, new Date(), 10)).toBe("kept");
    expect((await read(threeYears.id)).description).toBe(DESCRIPTION);
  });

  it("reads a status the board added under done as closed", async () => {
    const archived = await prisma.issueStatus.create({
      data: {
        typeId,
        meaning: "DONE",
        label: `Arkiverat ${suffix}`,
        sortOrder: 1,
      },
    });
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 2 * 365 + 1,
      statusId: archived.id,
    });
    expect(await clock.eligible(new Date(), 2)).toContain(issue.id);
    expect(await clock.purgeIssue(issue.id, new Date(), 2)).toBe("removed");
  });

  it("keeps an issue under a legal hold, and reaches it once the hold is released", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 2 * 365 + 1,
    });
    const placed = await inject({
      method: "POST",
      url: `/api/issue-queue/${issue.id}/legal-hold`,
      headers: { cookie: boardCookie },
      payload: { held: true },
    });
    expect(placed.statusCode).toBe(201);
    expect(placed.json<{ legalHoldAt: string | null }>().legalHoldAt).not.toBe(
      null,
    );

    expect(await clock.eligible(new Date(), 2)).not.toContain(issue.id);
    // And the transaction that removes reads it again rather than trusting
    // the scan.
    expect(await clock.purgeIssue(issue.id, new Date(), 2)).toBe("kept");
    const held = await read(issue.id);
    expect(held.description).toBe(DESCRIPTION);
    expect(held._count.photos).toBe(1);
    expect(await stored(issue.photo.storageKey)).toBe(true);

    const released = await inject({
      method: "POST",
      url: `/api/issue-queue/${issue.id}/legal-hold`,
      headers: { cookie: boardCookie },
      payload: { held: false },
    });
    expect(released.statusCode).toBe(201);
    expect(await clock.purgeIssue(issue.id, new Date(), 2)).toBe("removed");

    const placings = await entriesFor(issue.id, "ISSUE_LEGAL_HOLD_PLACED");
    const releases = await entriesFor(issue.id, "ISSUE_LEGAL_HOLD_RELEASED");
    expect(placings).toHaveLength(1);
    expect(placings[0]?.actorPersonId).toBe(board.personId);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.context).toHaveProperty("placedAt");
  });

  it("marks the text as removed when a file attached during the run stands, and finishes with the file", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 5 * 365,
    });
    // A handler had redacted the description before the run.
    expect(
      (
        await inject({
          method: "POST",
          url: `/api/issue-queue/${issue.id}/redactions`,
          headers: { cookie: boardCookie },
          payload: { target: "description" },
        })
      ).statusCode,
    ).toBe(204);
    const late = await upload();
    const tonight = new Date();
    const tomorrow = new Date(tonight.getTime() + 24 * 60 * 60 * 1000);

    // The file arrives on the transaction that takes the text, after the
    // files were read: the last `stillDue` is the text's.
    let asked = 0;
    const outcome = await app
      .get(IssueFreeTextService)
      .remove(issue.id, tonight, {
        targetPersonId: null,
        context: {},
        stillDue: async (tx) => {
          asked += 1;
          if (asked === 3) {
            await tx.issuePhoto.create({
              data: { issueId: issue.id, fileId: late.fileId },
            });
          }
          return true;
        },
      });
    expect(outcome).toBe("unfinished");

    // The marks of the redaction went with the text, so the purge's own mark
    // stands in its place rather than a description read as filed blank.
    const midway = await read(issue.id);
    expect(midway.description).toBe("");
    expect(midway.descriptionRedactedAt).toBeNull();
    expect(midway.freeTextRemovedAt).toEqual(tonight);
    expect(midway._count.photos).toBe(1);

    // The next run takes the file and moves the mark to that run.
    expect(await clock.purgeIssue(issue.id, tomorrow, 1)).toBe("removed");
    const after = await read(issue.id);
    expect(after._count.photos).toBe(0);
    expect(after.freeTextRemovedAt).toEqual(tomorrow);
    expect(await stored(late.storageKey)).toBe(false);
  });

  it("keeps an issue whose reporter is under a legal hold", async () => {
    const issue = await seed({
      reporterPersonId: heldReporterId,
      closedDaysAgo: 5 * 365,
    });
    expect(await clock.eligible(new Date(), 1)).not.toContain(issue.id);
    expect(await clock.purgeIssue(issue.id, new Date(), 1)).toBe("kept");
    expect((await read(issue.id)).description).toBe(DESCRIPTION);
  });
});

describe("a free-text removal that is refused after files went", () => {
  /**
   * A removal whose `stillDue` answers from a script, one answer for each ask:
   * once for each file and once more in the closing transaction. An ask past
   * the script's end answers yes.
   */
  function scripted(
    answers: boolean[],
    inTransaction?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): FreeTextRemoval {
    let asked = 0;
    return {
      targetPersonId: null,
      context: { test: true },
      stillDue: async (tx) => {
        const answer = answers[asked] ?? true;
        asked += 1;
        if (asked === answers.length && inTransaction !== undefined) {
          await inTransaction(tx);
        }
        return answer;
      },
    };
  }

  /**
   * Every line the free-text service logged during one issue's removal. The
   * spy is on the service's own logger, as for the redaction log, so a check
   * for no lines does not depend on the words of one.
   */
  async function partialLines(
    issueId: string,
    removal: FreeTextRemoval,
  ): Promise<{ outcome: string; lines: string[] }> {
    const log = vi
      .spyOn(freeText["logger"], "log")
      .mockImplementation(() => {});
    try {
      const outcome = await freeText.remove(issueId, new Date(), removal);
      const lines = log.mock.calls.map(([message]) => String(message));
      return { outcome, lines };
    } finally {
      log.mockRestore();
    }
  }

  /** An issue with a description and no files at all. */
  async function seedWithoutFiles(): Promise<string> {
    const issue = await prisma.issue.create({
      data: {
        typeId,
        statusId: type.statusIds.DONE,
        outcome: "FIXED",
        priority: "NORMAL",
        reporterPersonId: resident.personId,
        apartmentId,
        description: DESCRIPTION,
        closedAt: new Date(Date.now() - 3 * 365 * DAY),
        createdAt: new Date("2021-03-01T08:00:00Z"),
      },
      select: { id: true },
    });
    return issue.id;
  }

  it("logs once, with the count, when the second file is refused", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 3 * 365,
    });

    const { outcome, lines } = await partialLines(
      issue.id,
      scripted([true, false]),
    );

    expect(outcome).toBe("kept");
    expect(lines).toEqual([
      `Issue ${issue.id} kept its free text after 1 files were removed`,
    ]);
    // The first file stays taken, the second and the text stand.
    const after = await read(issue.id);
    expect(after._count.photos + after._count.attachments).toBe(1);
    expect(after.description).toBe(DESCRIPTION);
  });

  it("logs nothing when the first file is refused", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 3 * 365,
    });

    const { outcome, lines } = await partialLines(issue.id, scripted([false]));

    expect(outcome).toBe("kept");
    expect(lines).toEqual([]);
    const after = await read(issue.id);
    expect(after._count.photos + after._count.attachments).toBe(2);
  });

  it("logs nothing when an issue with no files is refused", async () => {
    const issueId = await seedWithoutFiles();

    const { outcome, lines } = await partialLines(issueId, scripted([false]));

    expect(outcome).toBe("kept");
    expect(lines).toEqual([]);
    expect((await read(issueId)).description).toBe(DESCRIPTION);
  });

  it("logs once when the closing transaction refuses after the files went", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 3 * 365,
    });

    const { outcome, lines } = await partialLines(
      issue.id,
      scripted([true, true, false]),
    );

    expect(outcome).toBe("kept");
    expect(lines).toEqual([
      `Issue ${issue.id} kept its free text after 2 files were removed`,
    ]);
    const after = await read(issue.id);
    expect(after._count.photos + after._count.attachments).toBe(0);
    // The messages and notes go only after the closing check passes.
    expect(after._count).toMatchObject({ messages: 1, notes: 1 });
    expect(after.description).toBe(DESCRIPTION);
    expect(after.freeTextRemovedAt).toBeNull();
  });

  it("logs once when the issue is gone by the closing transaction", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 3 * 365,
    });

    const { outcome, lines } = await partialLines(
      issue.id,
      scripted([true, true, true], async (tx) => {
        await tx.issue.delete({ where: { id: issue.id } });
      }),
    );

    expect(outcome).toBe("kept");
    expect(lines).toEqual([
      `Issue ${issue.id} kept its free text after 2 files were removed`,
    ]);
  });
});

describe("the board's setting", () => {
  it("takes a whole number of years from one to ten, and records the change", async () => {
    for (const years of [0, 11, 2.5]) {
      const refused = await inject({
        method: "PUT",
        url: "/api/issue-retention",
        headers: { cookie: boardCookie },
        payload: { years },
      });
      expect(refused.statusCode).toBe(400);
    }

    const before = await inject({
      method: "GET",
      url: "/api/issue-retention",
      headers: { cookie: boardCookie },
    });
    const from = before.json<{ years: number }>().years;
    const to = from === 5 ? 6 : 5;

    const saved = await inject({
      method: "PUT",
      url: "/api/issue-retention",
      headers: { cookie: boardCookie },
      payload: { years: to },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ years: to });
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "ISSUE_RETENTION_RECORDED",
        actorPersonId: board.personId,
      },
      orderBy: [{ createdAt: "desc" }],
    });
    expect(entry?.context).toEqual({
      yearsAfterClosingFrom: from,
      yearsAfterClosingTo: to,
    });

    // A resident cannot set it.
    const resident = await inject({
      method: "PUT",
      url: "/api/issue-retention",
      headers: { cookie: residentCookie },
      payload: { years: 3 },
    });
    expect(resident.statusCode).toBe(403);
  });
});

describe("redaction", () => {
  it("empties a text with a mark, removes a file from storage, and records neither", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const redact = (payload: object) =>
      inject({
        method: "POST",
        url: `/api/issue-queue/${issue.id}/redactions`,
        headers: { cookie: boardCookie },
        payload,
      });

    for (const payload of [
      { target: "description" },
      { target: "location" },
      { target: "message", id: issue.messageId },
      { target: "note", id: issue.noteId },
      { target: "photo", id: issue.photo.id },
      { target: "attachment", id: issue.attachment.id },
    ]) {
      expect((await redact(payload)).statusCode).toBe(204);
    }

    const after = await read(issue.id);
    expect(after.description).toBe("");
    expect(after.descriptionRedactedAt).not.toBeNull();
    expect(after.location).toBeNull();
    expect(after.locationRedactedAt).not.toBeNull();
    expect(after._count).toMatchObject({ photos: 0, attachments: 0 });
    expect(await stored(issue.photo.storageKey)).toBe(false);
    expect(await stored(issue.attachment.storageKey)).toBe(false);

    // The message keeps its place in the conversation, marked.
    const thread = await inject({
      method: "GET",
      url: `/api/issues/${issue.id}/messages`,
      headers: { cookie: residentCookie },
    });
    expect(thread.json()).toEqual([
      expect.objectContaining({
        id: issue.messageId,
        body: "",
        redactedAt: expect.any(String),
      }),
    ]);

    const entries = await entriesFor(issue.id, "ISSUE_REDACTED");
    expect(entries.map((entry) => entry.context)).toEqual([
      { target: "description" },
      { target: "location" },
      { target: "message", id: issue.messageId },
      { target: "note", id: issue.noteId },
      { target: "photo", id: issue.photo.id },
      { target: "attachment", id: issue.attachment.id },
    ]);
    expect(
      entries.every((entry) => entry.actorPersonId === board.personId),
    ).toBe(true);
    const written = JSON.stringify(entries);
    for (const text of [DESCRIPTION, LOCATION, MESSAGE, NOTE, "bild-"]) {
      expect(written).not.toContain(text);
    }

    // Redacting again writes nothing more.
    expect((await redact({ target: "description" })).statusCode).toBe(204);
    expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(6);
  });

  it("logs a redaction only when it changed the issue", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const log = spyOnRedactionLog();
    try {
      for (const _ of [1, 2]) {
        await inject({
          method: "POST",
          url: `/api/issue-queue/${issue.id}/redactions`,
          headers: { cookie: boardCookie },
          payload: { target: "description" },
        });
      }
      const redacted = log.mock.calls.filter(([message]) =>
        String(message).includes(`Issue ${issue.id} had its description`),
      );
      expect(redacted).toHaveLength(1);

      log.mockClear();
      for (const held of [true, true, false, false]) {
        await inject({
          method: "POST",
          url: `/api/issue-queue/${issue.id}/legal-hold`,
          headers: { cookie: boardCookie },
          payload: { held },
        });
      }
      const holds = log.mock.calls.filter(([message]) =>
        String(message).includes(`Issue ${issue.id} legal hold`),
      );
      expect(holds).toHaveLength(2);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps a reporter's photograph's file name out of the audit log", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const photo = await app.get(IssueService).attachPhoto({
      issueId: issue.id,
      reporterPersonId: resident.personId,
      bytes: pngBytes(24, 24),
      fileName: `badrummet-hos-grannen-${suffix}.png`,
    });
    const fileId = (
      await prisma.issuePhoto.findFirstOrThrow({
        where: { issueId: issue.id, id: photo.id },
        select: { fileId: true },
      })
    ).fileId;

    const entries = await prisma.auditLogEntry.findMany({
      where: { targetKind: "media", targetId: fileId },
    });
    expect(entries.map((entry) => entry.action)).toContain("MEDIA_UPLOADED");
    expect(JSON.stringify(entries)).not.toContain("badrummet-hos-grannen");
  });

  it("keeps a file and writes no entry when its object cannot be removed, and removes it on a retry", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const redact = () =>
      inject({
        method: "POST",
        url: `/api/issue-queue/${issue.id}/redactions`,
        headers: { cookie: boardCookie },
        payload: { target: "photo", id: issue.photo.id },
      });

    const refuse = vi
      .spyOn(storage, "remove")
      .mockRejectedValue(new Error("The storage is unreachable."));
    try {
      expect((await redact()).statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      refuse.mockRestore();
    }

    expect((await read(issue.id))._count.photos).toBe(1);
    expect(await stored(issue.photo.storageKey)).toBe(true);
    expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(0);

    expect((await redact()).statusCode).toBe(204);
    expect((await read(issue.id))._count.photos).toBe(0);
    expect(await stored(issue.photo.storageKey)).toBe(false);
    expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(1);
  });

  // A second handler's redaction takes the file while this one is removing it,
  // which is the only way the removal finds the file gone: asked again
  // afterwards, the photograph no longer exists and the redaction is refused as
  // having nothing to reach. The rival goes in at each of the two places the
  // removal can be overtaken before its own transaction has taken the file.
  it.each([
    ["before the removal opens its transaction", "before"],
    [
      "inside the transaction, before the check on the issue and the photograph",
      "in-keep",
    ],
  ] as const)(
    "answers a file another redaction already removed %s as done, and writes and logs nothing",
    async (_place, when) => {
      const issue = await seed({
        reporterPersonId: resident.personId,
        closedDaysAgo: null,
      });
      const mediaEntries = () =>
        prisma.auditLogEntry.findMany({
          where: {
            targetKind: "media",
            targetId: issue.photo.fileId,
            action: "MEDIA_DELETED",
          },
        });

      const remove = media.remove.bind(media);
      let rival: Promise<boolean> | undefined;
      const takeFile = () => {
        rival = remove(issue.photo.fileId, board.personId, "WEB");
        return rival;
      };
      const rivalled = vi
        .spyOn(media, "remove")
        .mockImplementationOnce(async (id, actor, channel, options = {}) => {
          if (when === "before") {
            await takeFile();
            return remove(id, actor, channel, options);
          }
          // The check the redaction passes runs in the transaction that
          // deletes the row, after the row was read there.
          const { keep } = options;
          if (keep === undefined) {
            throw new Error("The redaction passed no check to run.");
          }
          return remove(id, actor, channel, {
            ...options,
            keep: async (tx, file) => {
              await takeFile();
              return keep(tx, file);
            },
          });
        });
      const log = spyOnRedactionLog();
      try {
        const response = await inject({
          method: "POST",
          url: `/api/issue-queue/${issue.id}/redactions`,
          headers: { cookie: boardCookie },
          payload: { target: "photo", id: issue.photo.id },
        });

        expect(response.statusCode).toBe(204);
        expect(rivalled).toHaveBeenCalledTimes(1);
        expect(await rival).toBe(true);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
        rivalled.mockRestore();
      }

      // The rival's removal is the one entry for the file, and the redaction
      // that found it gone wrote none of its own.
      expect(await mediaEntries()).toHaveLength(1);
      expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(0);
      expect((await read(issue.id))._count.photos).toBe(0);
    },
  );

  it("takes no replacement text, and is refused to a reporter and under a legal hold", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });

    const withText = await inject({
      method: "POST",
      url: `/api/issue-queue/${issue.id}/redactions`,
      headers: { cookie: boardCookie },
      payload: { target: "description", text: "Något annat" },
    });
    expect(withText.statusCode).toBe(400);

    const byReporter = await inject({
      method: "POST",
      url: `/api/issue-queue/${issue.id}/redactions`,
      headers: { cookie: residentCookie },
      payload: { target: "description" },
    });
    expect(byReporter.statusCode).toBe(403);

    const unknown = await inject({
      method: "POST",
      url: `/api/issue-queue/${issue.id}/redactions`,
      headers: { cookie: boardCookie },
      payload: { target: "note", id: `nothing-${suffix}` },
    });
    expect(unknown.statusCode).toBe(404);

    await prisma.issue.update({
      where: { id: issue.id },
      data: { legalHoldAt: new Date() },
    });
    for (const payload of [
      { target: "description" },
      { target: "photo", id: issue.photo.id },
    ]) {
      const refused = await inject({
        method: "POST",
        url: `/api/issue-queue/${issue.id}/redactions`,
        headers: { cookie: boardCookie },
        payload,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "legal-hold" });
    }
    const kept = await read(issue.id);
    expect(kept.description).toBe(DESCRIPTION);
    expect(kept._count.photos).toBe(1);
    expect(await stored(issue.photo.storageKey)).toBe(true);
    expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(0);
  });
});

describe("redaction after the purge and under a reporter's hold", () => {
  const redact = (issueId: string, payload: object) =>
    inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/redactions`,
      headers: { cookie: boardCookie },
      payload,
    });

  it("redacts nothing and writes nothing once the purge has emptied the text", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 5 * 365,
    });
    expect(await clock.purgeIssue(issue.id, new Date(), 1)).toBe("removed");
    const purged = await read(issue.id);
    expect(purged.description).toBe("");
    expect(purged.freeTextRemovedAt).not.toBeNull();

    for (const target of ["description", "location"]) {
      expect((await redact(issue.id, { target })).statusCode).toBe(204);
    }

    const after = await read(issue.id);
    expect(after.descriptionRedactedAt).toBeNull();
    expect(after.locationRedactedAt).toBeNull();
    expect(after.freeTextRemovedAt).toEqual(purged.freeTextRemovedAt);
    expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(0);
  });

  it("is refused while the reporter is under a legal hold, and goes through once it is released", async () => {
    const issue = await seed({
      reporterPersonId: heldReporterId,
      closedDaysAgo: null,
    });
    for (const payload of [
      { target: "description" },
      { target: "message", id: issue.messageId },
      { target: "photo", id: issue.photo.id },
    ]) {
      const refused = await redact(issue.id, payload);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "legal-hold" });
    }
    const kept = await read(issue.id);
    expect(kept.description).toBe(DESCRIPTION);
    expect(kept._count.photos).toBe(1);
    expect(await stored(issue.photo.storageKey)).toBe(true);
    expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(0);

    // A reporter of their own, so the hold above stays for the other tests.
    const releasedId = `ir-released-${suffix}`;
    personIds.push(releasedId);
    await prisma.person.create({
      data: { id: releasedId, firstName: "Rolf", lastName: "Reda" },
    });
    await prisma.legalHold.create({
      data: {
        personId: releasedId,
        reason: "Tvist om vattenskada",
        placedByPersonId: board.personId,
      },
    });
    const other = await seed({
      reporterPersonId: releasedId,
      closedDaysAgo: null,
    });
    expect((await redact(other.id, { target: "description" })).statusCode).toBe(
      409,
    );
    await prisma.legalHold.updateMany({
      where: { personId: releasedId },
      data: { releasedAt: new Date() },
    });
    expect((await redact(other.id, { target: "description" })).statusCode).toBe(
      204,
    );
    expect((await read(other.id)).descriptionRedactedAt).not.toBeNull();
  });

  it("is refused while the reporter is restricted, and while a public-form reporter's address is held or restricted", async () => {
    const restrictedId = `ir-restricted-${suffix}`;
    const addressHeldId = `ir-address-held-${suffix}`;
    const addressRestrictedId = `ir-address-restricted-${suffix}`;
    personIds.push(restrictedId, addressHeldId, addressRestrictedId);
    await prisma.person.create({
      data: {
        id: restrictedId,
        firstName: "Rakel",
        lastName: "Begransad",
        processingRestrictedAt: new Date(),
      },
    });
    const email = `${addressHeldId}@exempel.se`;
    const encrypted = await encryption.encrypt("person.email", email);
    await prisma.person.create({
      data: {
        id: addressHeldId,
        firstName: "Adrian",
        lastName: "Adress",
        emailCipher: encrypted.cipher,
        emailIndex: encrypted.index,
      },
    });
    // Restricted and under no hold, so only the restriction refuses it.
    const restrictedEmail = `${addressRestrictedId}@exempel.se`;
    const restrictedEncrypted = await encryption.encrypt(
      "person.email",
      restrictedEmail,
    );
    await prisma.person.create({
      data: {
        id: addressRestrictedId,
        firstName: "Bodil",
        lastName: "Begransad",
        emailCipher: restrictedEncrypted.cipher,
        emailIndex: restrictedEncrypted.index,
        processingRestrictedAt: new Date(),
      },
    });
    await prisma.legalHold.create({
      data: {
        personId: addressHeldId,
        reason: "Tvist om vattenskada",
        placedByPersonId: board.personId,
      },
    });

    const restricted = await seed({
      reporterPersonId: restrictedId,
      closedDaysAgo: null,
    });
    const fromForm = async (address: string) => {
      const issue = await seed({ reporterPersonId: null, closedDaysAgo: null });
      await prisma.issue.update({
        where: { id: issue.id },
        data: {
          reporterEmailIndex: await encryption.computeIndex(
            "issue.reporterEmail",
            address,
          ),
        },
      });
      return issue;
    };
    const byHeldAddress = await fromForm(email);
    const byRestrictedAddress = await fromForm(restrictedEmail);

    for (const issue of [restricted, byHeldAddress, byRestrictedAddress]) {
      const refused = await redact(issue.id, { target: "description" });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "legal-hold" });
      expect((await read(issue.id)).description).toBe(DESCRIPTION);
      expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(0);
    }
  });
});

describe("redaction of a work order's text", () => {
  const redact = (issueId: string, workOrderId: string) =>
    inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/redactions`,
      headers: { cookie: boardCookie },
      payload: { target: "workOrder", id: workOrderId },
    });

  it("erases the text with a mark, keeps the record of whom it went to, and records no word of it", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const workOrderId = await createWorkOrder(issue.id);
    const before = await readWorkOrder(workOrderId);

    expect((await redact(issue.id, workOrderId)).statusCode).toBe(204);

    const after = await readWorkOrder(workOrderId);
    expect(after.body).toBeNull();
    expect(after.redactedAt).not.toBeNull();
    // The record of the disclosure stays as it was.
    expect(after).toMatchObject({
      recipientName: before.recipientName,
      recipientEmailCipher: before.recipientEmailCipher,
      deliveryStatus: "SENT",
      createdAt: before.createdAt,
    });

    // The handlers' record reads it as redacted.
    const record = await inject({
      method: "GET",
      url: `/api/issue-queue/${issue.id}/work-orders`,
      headers: { cookie: boardCookie },
    });
    expect(record.json()).toMatchObject({
      workOrders: [
        {
          id: workOrderId,
          body: null,
          redactedAt: after.redactedAt?.toISOString(),
        },
      ],
    });

    const entries = await entriesFor(issue.id, "ISSUE_REDACTED");
    expect(entries.map((entry) => entry.context)).toEqual([
      { target: "workOrder", id: workOrderId },
    ]);
    expect(entries[0]?.actorPersonId).toBe(board.personId);
    expect(JSON.stringify(entries)).not.toContain(WORK_ORDER_TEXT);

    // Redacting again writes nothing more.
    expect((await redact(issue.id, workOrderId)).statusCode).toBe(204);
    expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(1);
  });

  it("is held by the database to a mark over an erased text only", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const standing = await createWorkOrder(issue.id);
    const erased = await createWorkOrder(issue.id, { body: null });
    const at = new Date();

    // A mark over words still standing is refused, and so are words written
    // back under a mark.
    await expect(
      prisma.$executeRaw`UPDATE "work_order" SET "redactedAt" = ${at} WHERE "id" = ${standing}`,
    ).rejects.toThrow(/work_order_redacted_empty/);
    await prisma.workOrder.update({
      where: { id: erased },
      data: { redactedAt: at },
    });
    await expect(
      prisma.$executeRaw`UPDATE "work_order" SET "body" = ${WORK_ORDER_TEXT} WHERE "id" = ${erased}`,
    ).rejects.toThrow(/work_order_redacted_empty/);

    expect(await readWorkOrder(standing)).toMatchObject({
      body: WORK_ORDER_TEXT,
      redactedAt: null,
    });
    expect(await readWorkOrder(erased)).toMatchObject({
      body: null,
      redactedAt: at,
    });
  });

  it("leaves a text the clock erased unmarked, and writes no entry", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const workOrderId = await createWorkOrder(issue.id, { body: null });

    expect((await redact(issue.id, workOrderId)).statusCode).toBe(204);

    expect((await readWorkOrder(workOrderId)).redactedAt).toBeNull();
    expect(await entriesFor(issue.id, "ISSUE_REDACTED")).toHaveLength(0);
  });

  it("refuses a work order of another issue, and one under a legal hold on its issue", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const other = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const workOrderId = await createWorkOrder(other.id);

    const elsewhere = await redact(issue.id, workOrderId);
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.json()).toMatchObject({
      reason: "redaction-target-not-found",
    });
    expect((await readWorkOrder(workOrderId)).body).toBe(WORK_ORDER_TEXT);

    await prisma.issue.update({
      where: { id: other.id },
      data: { legalHoldAt: new Date() },
    });
    const held = await redact(other.id, workOrderId);
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ reason: "legal-hold" });

    const kept = await readWorkOrder(workOrderId);
    expect(kept.body).toBe(WORK_ORDER_TEXT);
    expect(kept.redactedAt).toBeNull();
    expect(await entriesFor(other.id, "ISSUE_REDACTED")).toHaveLength(0);
  });

  it("keeps a work order whose mail has not gone out from being sent, and records it as not sent", async () => {
    const issue = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    const workOrderId = await createWorkOrder(issue.id, {
      deliveryStatus: "PENDING",
    });

    expect((await redact(issue.id, workOrderId)).statusCode).toBe(204);
    expect(await app.get(WorkOrderMailerService).send(workOrderId)).toBe(
      "failed",
    );

    expect(await readWorkOrder(workOrderId)).toMatchObject({
      body: null,
      deliveryStatus: "FAILED",
      deliveryFailure: "text-erased",
    });
  });

  it("detaches a reporter whose erasure was carried out once the last text is gone, and is refused while a hold keeps them", async () => {
    const finished = await seedWithOnlyWorkOrderText(erasedReporterId);
    const second = await createWorkOrder(finished.id);

    // One text still stands after the first redaction: the reporter stays.
    expect((await redact(finished.id, finished.workOrderId)).statusCode).toBe(
      204,
    );
    expect((await read(finished.id)).reporterPersonId).toBe(erasedReporterId);

    expect((await redact(finished.id, second)).statusCode).toBe(204);
    expect((await read(finished.id)).reporterPersonId).toBeNull();
    const entries = await entriesFor(finished.id, "ISSUE_REDACTED");
    expect(entries.map((entry) => entry.context)).toEqual([
      { target: "workOrder", id: finished.workOrderId },
      { target: "workOrder", id: second, reporterDetached: true },
    ]);

    // A hold placed on the person since refuses the redaction: the text and
    // the column both stay.
    const held = await seedWithOnlyWorkOrderText(erasedHeldReporterId);
    await prisma.legalHold.create({
      data: {
        personId: erasedHeldReporterId,
        reason: "Tvist om arbetet",
        placedByPersonId: board.personId,
      },
    });
    const refused = await redact(held.id, held.workOrderId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "legal-hold" });
    expect((await readWorkOrder(held.workOrderId)).body).toBe(WORK_ORDER_TEXT);
    expect((await read(held.id)).reporterPersonId).toBe(erasedHeldReporterId);
  });

  it("keeps the reporter of an issue whose free text still stands", async () => {
    const issue = await seed({
      reporterPersonId: erasedReporterId,
      closedDaysAgo: 30,
    });
    const workOrderId = await createWorkOrder(issue.id);

    expect((await redact(issue.id, workOrderId)).statusCode).toBe(204);

    expect((await read(issue.id)).reporterPersonId).toBe(erasedReporterId);
  });
});

describe("a granted erasure request", () => {
  it("removes the free text of a closed issue the person reported, and keeps an open one until it closes", async () => {
    const personId = formerIds[0] ?? "";
    await createFormerResident(personId, new Date("2026-01-31"));
    const closed = await seed({
      reporterPersonId: personId,
      closedDaysAgo: 30,
    });
    const open = await seed({
      reporterPersonId: personId,
      closedDaysAgo: null,
    });
    await grantErasure(prisma, personId, board.personId);

    // Night one: the closed issue's text goes on the date the board granted,
    // not on its clock; the open one is kept and holds the request open.
    await erasure.run();
    expect((await read(closed.id)).freeTextRemovedAt).not.toBeNull();
    expect((await read(open.id)).description).toBe(DESCRIPTION);
    expect(
      await erasureRemainder(prisma, personId, new Date(), encryption),
    ).toEqual([
      expect.objectContaining({ domain: "issues", owed: 0, kept: 1 }),
    ]);

    await personPurge.purgePerson(personId, new Date());
    const request = await prisma.dataSubjectRequest.findFirstOrThrow({
      where: { personId },
    });
    expect(request.executedAt).toBeNull();
    // The account's contact details went tonight; the reference waits on the
    // issue whose text still stands, and only on that one.
    const person = await prisma.person.findUniqueOrThrow({
      where: { id: personId },
      select: { emailCipher: true },
    });
    expect(person.emailCipher).toBeNull();
    expect((await read(closed.id)).reporterPersonId).toBeNull();
    expect((await read(open.id)).reporterPersonId).toBe(personId);

    // The board closes the open issue; the next night finishes the erasure.
    await prisma.issue.update({
      where: { id: open.id },
      data: {
        statusId: type.statusIds.DONE,
        outcome: "FIXED",
        closedAt: new Date(),
      },
    });
    await erasure.run();
    await personPurge.purgePerson(personId, new Date());

    expect((await read(open.id)).freeTextRemovedAt).not.toBeNull();
    expect((await read(open.id)).reporterPersonId).toBeNull();
    const executed = await prisma.dataSubjectRequest.findFirstOrThrow({
      where: { personId },
    });
    expect(executed.executedAt).not.toBeNull();
  });

  it("records the removal when the last thing it takes is a file", async () => {
    const personId = formerIds[4] ?? "";
    await createFormerResident(personId, new Date("2026-01-31"));
    const issue = await seed({ reporterPersonId: personId, closedDaysAgo: 30 });
    // Only the files stand: no words are left to take with them.
    await prisma.issueMessage.deleteMany({ where: { issueId: issue.id } });
    await prisma.issueNote.deleteMany({ where: { issueId: issue.id } });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { description: "", location: null },
    });
    await grantErasure(prisma, personId, board.personId);

    expect(await erasure.eraseIssue(issue.id, personId, new Date())).toBe(
      "removed",
    );

    const after = await read(issue.id);
    expect(after.freeTextRemovedAt).not.toBeNull();
    expect(after._count).toMatchObject({ photos: 0, attachments: 0 });
    const [entry] = await entriesFor(issue.id, "SERVICE_DATA_PURGED");
    expect(entry?.context).toMatchObject({ layer: "freeText", files: 2 });
    expect(await entriesFor(issue.id, "SERVICE_DATA_PURGED")).toHaveLength(1);
  });

  it("is held open by an issue under a legal hold of its own", async () => {
    const personId = formerIds[1] ?? "";
    await createFormerResident(personId, new Date("2026-01-31"));
    const damage = await seed({
      reporterPersonId: personId,
      closedDaysAgo: 30,
    });
    await prisma.issue.update({
      where: { id: damage.id },
      data: { legalHoldAt: new Date() },
    });
    await grantErasure(prisma, personId, board.personId);

    await erasure.run();
    await personPurge.purgePerson(personId, new Date());

    expect((await read(damage.id)).description).toBe(DESCRIPTION);
    expect((await read(damage.id)).reporterPersonId).toBe(personId);
    const request = await prisma.dataSubjectRequest.findFirstOrThrow({
      where: { personId },
    });
    expect(request.executedAt).toBeNull();
  });

  it("still finds an issue whose reporter's own window ran out before the request was granted", async () => {
    /*
     * ADR 0057's third case. The person's window runs out while their closed
     * issue still waits on its clock: the person purge clears their account and
     * contact details, and must leave the reporter column, or a request granted
     * afterwards would find no issue and close with the text still there.
     */
    const personId = formerIds[2] ?? "";
    await createFormerResident(personId, new Date("2023-01-31"));
    const issue = await seed({ reporterPersonId: personId, closedDaysAgo: 30 });

    await personPurge.purgePerson(personId, new Date(), 365);
    expect((await read(issue.id)).reporterPersonId).toBe(personId);

    await grantErasure(prisma, personId, board.personId);
    expect(
      await erasureRemainder(prisma, personId, new Date(), encryption),
    ).toEqual([
      expect.objectContaining({ domain: "issues", owed: 1, kept: 0 }),
    ]);

    await erasure.run();
    await personPurge.purgePerson(personId, new Date(), 365);

    const after = await read(issue.id);
    expect(after.freeTextRemovedAt).not.toBeNull();
    expect(after.reporterPersonId).toBeNull();
    const request = await prisma.dataSubjectRequest.findFirstOrThrow({
      where: { personId },
    });
    expect(request.executedAt).not.toBeNull();
  });

  it("keeps the request open when the storage fails on night one, and finishes it after the recovery", async () => {
    /*
     * ADR 0057's first case: an issue purge that fails on night one. The
     * object cannot be removed, so the file stays on the issue, the text stays,
     * the reporter reference stays and the request stays open, while the
     * person's account and contact details are already cleared. The next night
     * removes the rest, detaches the reporter and closes the request.
     */
    const personId = formerIds[3] ?? "";
    await createFormerResident(personId, new Date("2026-01-31"));
    const issue = await seed({ reporterPersonId: personId, closedDaysAgo: 30 });
    await grantErasure(prisma, personId, board.personId);

    const refuse = vi
      .spyOn(storage, "remove")
      .mockImplementation((key: string) =>
        key === issue.photo.storageKey
          ? Promise.reject(new Error("The storage is unreachable."))
          : Promise.resolve(),
      );
    try {
      const night = await erasure.run();
      expect(night.failed).toBeGreaterThanOrEqual(1);
      await personPurge.purgePerson(personId, new Date());
    } finally {
      refuse.mockRestore();
    }

    // Night one: nothing is recorded as removed that is not.
    const afterOne = await read(issue.id);
    expect(afterOne.freeTextRemovedAt).toBeNull();
    expect(afterOne.description).toBe(DESCRIPTION);
    expect(afterOne.reporterPersonId).toBe(personId);
    expect(afterOne._count.photos).toBe(1);
    expect(await stored(issue.photo.storageKey)).toBe(true);
    expect(
      await prisma.mediaFile.count({ where: { id: issue.photo.fileId } }),
    ).toBe(1);
    expect(
      (
        await prisma.dataSubjectRequest.findFirstOrThrow({
          where: { personId },
        })
      ).executedAt,
    ).toBeNull();
    expect(
      await erasureRemainder(prisma, personId, new Date(), encryption),
    ).toEqual([
      expect.objectContaining({ domain: "issues", owed: 1, kept: 0 }),
    ]);
    // The account's contact details are already cleared.
    expect(
      (
        await prisma.person.findUniqueOrThrow({
          where: { id: personId },
          select: { emailCipher: true },
        })
      ).emailCipher,
    ).toBeNull();

    // The storage is back: the retry removes what is left.
    const night = await erasure.run();
    expect(night.failed).toBe(0);
    await personPurge.purgePerson(personId, new Date());

    const afterTwo = await read(issue.id);
    expect(afterTwo.freeTextRemovedAt).not.toBeNull();
    expect(afterTwo.description).toBe("");
    expect(afterTwo.reporterPersonId).toBeNull();
    expect(afterTwo._count).toEqual({
      messages: 0,
      notes: 0,
      photos: 0,
      attachments: 0,
    });
    expect(await stored(issue.photo.storageKey)).toBe(false);
    expect(await stored(issue.attachment.storageKey)).toBe(false);
    expect(
      (
        await prisma.dataSubjectRequest.findFirstOrThrow({
          where: { personId },
        })
      ).executedAt,
    ).not.toBeNull();
  });
});

describe("the access report", () => {
  it("says an issue's text was removed, by a handler or by the purge", async () => {
    const redacted = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: null,
    });
    for (const target of ["description", "location"]) {
      await inject({
        method: "POST",
        url: `/api/issue-queue/${redacted.id}/redactions`,
        headers: { cookie: boardCookie },
        payload: { target },
      });
    }
    const purged = await seed({
      reporterPersonId: resident.personId,
      closedDaysAgo: 2 * 365 + 1,
    });
    await clock.purgeIssue(purged.id, new Date(), 2);

    const report = await app.get(DataSubjectReportService).generate({
      personId: resident.personId,
      actorPersonId: board.personId,
    });
    const byId = new Map(report.issues.map((issue) => [issue.issueId, issue]));

    expect(byId.get(redacted.id)).toMatchObject({
      description: "",
      location: null,
      descriptionRedactedAt: expect.any(String),
      locationRedactedAt: expect.any(String),
      freeTextRemovedAt: null,
    });
    expect(byId.get(purged.id)).toMatchObject({
      description: "",
      location: null,
      freeTextRemovedAt: expect.any(String),
    });
  });
});
