import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AppModule } from "../app.module";
import { ENV } from "../config/config.module";
import { PrismaService } from "../database/prisma.service";
import { MediaService } from "../media/media.service";
import { pngBytes } from "../media/testing/image-fixtures";
import { lockLegalHold } from "../retention/legal-hold-lock";
import { StorageService } from "../storage/storage.service";
import { waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { backendPid, waitersBehind } from "../testing/lock-waiters";
import { IssueConversationService } from "./issue-conversation.service";
import {
  IssueFileSweepService,
  UNATTACHED_ISSUE_FILE_HOURS,
} from "./issue-file-sweep.service";
import { IssueService } from "./issue.service";

/**
 * The sweep of files an upload in the issues module stored and never put on
 * anything, against a real database.
 *
 * An upload stores the file and then writes the row that puts it on an issue
 * in a transaction of its own, so a process that stops between the two leaves
 * the file on nothing. The sweep removes such a file, its row and its bytes,
 * once a day has passed. It keeps a younger one, a file anything holds, a file
 * another module stored, and a file whose uploader is under a legal hold or a
 * restriction of processing. And it keeps a file whose row, or whose
 * uploader's hold, is being written while it decides, which is the property
 * only a real database can show.
 *
 * The sweep reads the whole database, so every assertion is about this suite's
 * own files, and each run's counts are read as at least what this suite put
 * there.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let media: MediaService;
let storage: StorageService;
let sweep: IssueFileSweepService;

const suffix = process.hrtime.bigint().toString(36);
const HOUR = 60 * 60 * 1000;

const boardPersonId = `ifs-board-${suffix}`;
const residentPersonId = `ifs-resident-${suffix}`;
const personIds = [boardPersonId, residentPersonId];

const addressId = `ifs-address-${suffix}`;
const apartmentId = `ifs-apartment-${suffix}`;
const typeId = `ifs-type-${suffix}`;
let type: IssueTypeFixture;

/** An open issue the resident reported. */
async function createIssue(): Promise<string> {
  const issue = await prisma.issue.create({
    data: {
      typeId,
      statusId: type.statusIds.IN_PROGRESS,
      priority: "NORMAL",
      reporterPersonId: residentPersonId,
      apartmentId,
      description: `Droppande kran ${suffix}`,
    },
    select: { id: true },
  });
  return issue.id;
}

/**
 * Files this suite stored with no uploader, as a contractor's photograph is.
 * The cleanup cannot find them through a person.
 */
const strayFileIds: string[] = [];

/** A file as the issues module stores one, before the row that places it. */
async function storeIssueFile(
  uploadedByPersonId: string | null,
): Promise<string> {
  const file = await media.upload({
    bytes: pngBytes(16, 16),
    fileName: `kranen-${suffix}.png`,
    visibility: "INTERNAL",
    requiredCapability: "issues:handle",
    showsIdentifiablePersons: true,
    uploadedByPersonId,
    channel: "WEB",
    recordFileName: false,
  });
  if (uploadedByPersonId === null) {
    strayFileIds.push(file.id);
  }
  return file.id;
}

/**
 * Runs `upload` with the process stopping as soon as the media layer has
 * stored the file: the error is thrown where the upload would go on to write
 * the row that places the file, so neither that row nor the removal a refused
 * row makes is ever reached. Answers the id of the file left behind.
 */
async function stopAfterStoring(
  upload: () => Promise<unknown>,
): Promise<string> {
  const store = media.upload.bind(media);
  let fileId: string | undefined;
  const spy = vi
    .spyOn(media, "upload")
    .mockImplementationOnce(async (input) => {
      fileId = (await store(input)).id;
      throw new Error("The process stopped.");
    });
  try {
    await expect(upload()).rejects.toThrow("The process stopped.");
  } finally {
    spy.mockRestore();
  }
  if (fileId === undefined) {
    throw new Error("The upload stored no file.");
  }
  return fileId;
}

/** Moves a file's upload `hours` into the past. */
async function age(fileId: string, hours: number): Promise<void> {
  await prisma.mediaFile.update({
    where: { id: fileId },
    data: { createdAt: new Date(Date.now() - hours * HOUR) },
  });
}

async function storageKeyOf(fileId: string): Promise<string> {
  const row = await prisma.mediaFile.findUniqueOrThrow({
    where: { id: fileId },
    select: { storageKey: true },
  });
  return row.storageKey;
}

async function hasRow(fileId: string): Promise<boolean> {
  return (
    (await prisma.mediaFile.findUnique({ where: { id: fileId } })) !== null
  );
}

async function hasObject(storageKey: string): Promise<boolean> {
  const stream = await storage.open(storageKey);
  stream?.destroy();
  return stream !== null;
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
  media = app.get(MediaService);
  storage = app.get(StorageService);
  sweep = app.get(IssueFileSweepService);

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Svepgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "0101", floor: 1 },
  });
  await prisma.person.createMany({
    data: [
      { id: boardPersonId, firstName: "Bea", lastName: "Ordforande" },
      { id: residentPersonId, firstName: "Rune", lastName: "Boende" },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: boardPersonId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: residentPersonId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2024-01-01"),
    },
  });

  type = await createIssueTypeFixture(prisma, {
    id: typeId,
    name: `Kran ${suffix}`,
    reporters: ["RESIDENTS"],
  });
}, 180_000);

afterAll(async () => {
  // The objects first: the rows are their only record.
  const files = await prisma.mediaFile.findMany({
    where: {
      OR: [
        { uploadedByPersonId: { in: personIds } },
        { id: { in: strayFileIds } },
      ],
    },
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
  await prisma.legalHold.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({ where: { id: apartmentId } });
  await prisma.address.deleteMany({ where: { id: addressId } });
  await app.close();
}, 60_000);

describe("the sweep of the issues module's unattached files", () => {
  it("removes a reporter's photograph and a handler's file whose upload stopped before its row, once a day has passed", async () => {
    const issueId = await createIssue();
    const photoId = await stopAfterStoring(() =>
      app.get(IssueService).attachPhoto({
        issueId,
        reporterPersonId: residentPersonId,
        bytes: pngBytes(16, 16),
        fileName: `kranen-${suffix}.png`,
      }),
    );
    const handlersFileId = await stopAfterStoring(() =>
      app.get(IssueConversationService).attach({
        issueId,
        handlerPersonId: boardPersonId,
        bytes: pngBytes(16, 16),
        fileName: `offerten-${suffix}.png`,
      }),
    );
    const left = [photoId, handlersFileId];
    const keys = await Promise.all(left.map(storageKeyOf));
    for (const fileId of left) {
      await age(fileId, UNATTACHED_ISSUE_FILE_HOURS + 1);
    }

    const summary = await sweep.run();

    expect(summary.removed).toBeGreaterThanOrEqual(2);
    for (const fileId of left) {
      expect(await hasRow(fileId)).toBe(false);
    }
    for (const key of keys) {
      expect(await hasObject(key)).toBe(false);
    }
    // Nobody pressed anything, and the name a file was given is free text.
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "MEDIA_DELETED", targetId: { in: left } },
      select: { actorPersonId: true, channel: true, context: true },
    });
    expect(entries).toEqual([
      { actorPersonId: null, channel: "SYSTEM", context: {} },
      { actorPersonId: null, channel: "SYSTEM", context: {} },
    ]);
  });

  it("keeps a file on nothing until a day has passed", async () => {
    const fileId = await storeIssueFile(residentPersonId);
    await age(fileId, UNATTACHED_ISSUE_FILE_HOURS - 1);

    await sweep.run();
    expect(await hasRow(fileId)).toBe(true);

    await sweep.run(new Date(Date.now() + 2 * HOUR));
    expect(await hasRow(fileId)).toBe(false);
  });

  it("keeps a reporter's photograph and a handler's file on an issue, however old", async () => {
    const issueId = await createIssue();
    const photo = await app.get(IssueService).attachPhoto({
      issueId,
      reporterPersonId: residentPersonId,
      bytes: pngBytes(16, 16),
      fileName: `kranen-${suffix}.png`,
    });
    const attachment = await app.get(IssueConversationService).attach({
      issueId,
      handlerPersonId: boardPersonId,
      bytes: pngBytes(16, 16),
      fileName: `offerten-${suffix}.png`,
    });
    const placed = [
      (
        await prisma.issuePhoto.findUniqueOrThrow({
          where: { id: photo.id },
          select: { fileId: true },
        })
      ).fileId,
      (
        await prisma.issueAttachment.findUniqueOrThrow({
          where: { id: attachment.id },
          select: { fileId: true },
        })
      ).fileId,
    ];
    for (const fileId of placed) {
      await age(fileId, 365 * 24);
    }

    await sweep.run();

    for (const fileId of placed) {
      expect(await hasRow(fileId)).toBe(true);
    }
  });

  it("keeps a contractor's photograph on a work order, and sweeps a file only a link's count of shown photographs names", async () => {
    const issueId = await createIssue();
    const order = await prisma.workOrder.create({
      data: {
        issueId,
        recipientName: `Rörfirman ${suffix}`,
        body: `Byt packningen ${suffix}`,
        sentByPersonId: boardPersonId,
        deliveryStatus: "SENT",
      },
      select: { id: true },
    });
    // A contractor's photograph has no uploader in the register.
    const contractorsFileId = await storeIssueFile(null);
    await prisma.workOrderFile.create({
      data: { workOrderId: order.id, fileId: contractorsFileId },
    });
    // The count keeps no file: a photograph shown and then taken off its
    // issue by a removal that failed is on nothing.
    const shownFileId = await storeIssueFile(null);
    await prisma.workOrderPhotoExposure.create({
      data: { workOrderId: order.id, fileId: shownFileId },
    });
    for (const fileId of [contractorsFileId, shownFileId]) {
      await age(fileId, 365 * 24);
    }

    await sweep.run();

    expect(await hasRow(contractorsFileId)).toBe(true);
    expect(await hasRow(shownFileId)).toBe(false);
    const exposure = await prisma.workOrderPhotoExposure.findFirstOrThrow({
      where: { workOrderId: order.id },
      select: { fileId: true },
    });
    expect(exposure.fileId).toBeNull();
  });

  it("leaves a file on nothing that another module stored", async () => {
    // INTERNAL like the issues module's, under another capability.
    const file = await media.upload({
      bytes: pngBytes(16, 16),
      fileName: `brevet-${suffix}.png`,
      visibility: "INTERNAL",
      requiredCapability: "boardMailbox:handle",
      showsIdentifiablePersons: true,
      uploadedByPersonId: boardPersonId,
      channel: "WEB",
      recordFileName: false,
    });
    await age(file.id, UNATTACHED_ISSUE_FILE_HOURS + 1);

    await sweep.run();

    expect(await hasRow(file.id)).toBe(true);
  });

  it("keeps a file on nothing while a legal hold stands over its uploader", async () => {
    const fileId = await storeIssueFile(residentPersonId);
    await age(fileId, UNATTACHED_ISSUE_FILE_HOURS + 1);
    // No uploader, as a contractor's photograph has: nobody a hold could stand
    // over, so the hold leaves it to the sweep.
    const noUploaderId = await storeIssueFile(null);
    await age(noUploaderId, UNATTACHED_ISSUE_FILE_HOURS + 1);
    const hold = await prisma.legalHold.create({
      data: {
        personId: residentPersonId,
        reason: "Tvist om en vattenskada",
        placedByPersonId: boardPersonId,
      },
    });
    try {
      await sweep.run();
      expect(await hasRow(fileId)).toBe(true);
      expect(await hasRow(noUploaderId)).toBe(false);
    } finally {
      await prisma.legalHold.update({
        where: { id: hold.id },
        data: { releasedAt: new Date(), releasedByPersonId: boardPersonId },
      });
    }

    await sweep.run();
    expect(await hasRow(fileId)).toBe(false);
  });

  it("keeps a file on nothing while its uploader's processing is restricted", async () => {
    const fileId = await storeIssueFile(residentPersonId);
    await age(fileId, UNATTACHED_ISSUE_FILE_HOURS + 1);
    await prisma.person.update({
      where: { id: residentPersonId },
      data: { processingRestrictedAt: new Date() },
    });
    try {
      await sweep.run();
      expect(await hasRow(fileId)).toBe(true);
    } finally {
      await prisma.person.update({
        where: { id: residentPersonId },
        data: { processingRestrictedAt: null },
      });
    }

    await sweep.run();
    expect(await hasRow(fileId)).toBe(false);
  });

  it("keeps a file whose uploader a hold is placed over while the sweep decides", async () => {
    /*
     * The hold's transaction has taken the uploader's legal hold key and
     * written the hold, and not yet committed, so the scan does not see the
     * hold and selects the file. The removal then waits for the key, read out
     * of the database rather than inferred from a delay, and finds the hold
     * once it has committed.
     */
    const fileId = await storeIssueFile(residentPersonId);
    await age(fileId, UNATTACHED_ISSUE_FILE_HOURS + 1);

    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderPid: number | undefined;
    let holdId: string | undefined;
    const holder = prisma.$transaction(
      async (tx) => {
        holderPid = await backendPid(tx);
        await lockLegalHold(tx, residentPersonId);
        holdId = (
          await tx.legalHold.create({
            data: {
              personId: residentPersonId,
              reason: "Tvist om en vattenskada",
              placedByPersonId: boardPersonId,
            },
            select: { id: true },
          })
        ).id;
        await released;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );

    let running: Promise<unknown> | undefined;
    try {
      try {
        await waitFor(async () => holdId !== undefined);
        running = sweep.run();
        await waitFor(
          async () =>
            holderPid !== undefined &&
            (await waitersBehind(prisma, holderPid)) > 0,
        );
      } finally {
        release?.();
        await holder;
        // Settled here too, so that when a wait above throws, a run that then
        // fails is not left unhandled to stand in for the wait's own error.
        await running?.catch(() => undefined);
      }
      await running;

      expect(await hasRow(fileId)).toBe(true);
    } finally {
      if (holdId !== undefined) {
        await prisma.legalHold.update({
          where: { id: holdId },
          data: { releasedAt: new Date(), releasedByPersonId: boardPersonId },
        });
      }
    }

    await sweep.run();
    expect(await hasRow(fileId)).toBe(false);
  });

  it("keeps a file whose row is written while the sweep decides, and the row with it", async () => {
    /*
     * The upload's transaction has written the row that places the file and
     * not yet committed it, so the sweep's scan does not see the row and
     * selects the file. The removal then reaches for the file's row lock and
     * waits behind that transaction - read out of the database rather than
     * inferred from a delay - and reads the row once it has committed. Without
     * the lock the removal would read no row, wait only at its delete, and
     * take the committed row with the file.
     */
    const issueId = await createIssue();
    const fileId = await storeIssueFile(residentPersonId);
    await age(fileId, UNATTACHED_ISSUE_FILE_HOURS + 1);

    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderPid: number | undefined;
    let photoId: string | undefined;
    const holder = prisma.$transaction(
      async (tx) => {
        holderPid = await backendPid(tx);
        photoId = (
          await tx.issuePhoto.create({
            data: { issueId, fileId },
            select: { id: true },
          })
        ).id;
        await released;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );

    let running: Promise<unknown> | undefined;
    try {
      await waitFor(async () => photoId !== undefined);
      running = sweep.run();
      await waitFor(
        async () =>
          holderPid !== undefined &&
          (await waitersBehind(prisma, holderPid)) > 0,
      );
    } finally {
      release?.();
      await holder;
      // Settled here too, so that when a wait above throws, a run that then
      // fails is not left unhandled to stand in for the wait's own error.
      await running?.catch(() => undefined);
    }
    await running;

    expect(await hasRow(fileId)).toBe(true);
    expect(
      await prisma.issuePhoto.findUnique({ where: { id: photoId ?? "" } }),
    ).not.toBeNull();
  });

  it("says which file it could not remove by its id alone, and removes it on the next run", async () => {
    const fileId = await storeIssueFile(residentPersonId);
    await age(fileId, UNATTACHED_ISSUE_FILE_HOURS + 1);
    const key = await storageKeyOf(fileId);

    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const refuse = vi
      .spyOn(storage, "remove")
      .mockRejectedValue(new Error(`storage refused ${key}`));
    try {
      const summary = await sweep.run();
      expect(summary.failed).toBeGreaterThanOrEqual(1);
      expect(await hasRow(fileId)).toBe(true);
      const logged = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes(fileId));
      expect(logged).toEqual([
        `Issue file sweep left the file ${fileId}: Error`,
      ]);
    } finally {
      refuse.mockRestore();
      warn.mockRestore();
    }

    await sweep.run();
    expect(await hasRow(fileId)).toBe(false);
    expect(await hasObject(key)).toBe(false);
  });

  it("goes on past a file it could not remove to the files behind it", async () => {
    /*
     * The failing file is the oldest, and a page and the run's bound are one
     * file each: a scan that read the oldest candidates again, or counted a
     * failure against the bound, would reach the failing file alone and never
     * the one behind it. Twenty years back puts both ahead of what any other
     * suite on the database leaves behind, which the assertions on the two
     * rows rely on; the counts are read only as far as the bounds fix them,
     * whatever else the database holds.
     */
    const failingId = await storeIssueFile(residentPersonId);
    const behindId = await storeIssueFile(residentPersonId);
    await age(failingId, 20 * 365 * 24 + 1);
    await age(behindId, 20 * 365 * 24);
    const failingKey = await storageKeyOf(failingId);

    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const remove = storage.remove.bind(storage);
    const refuse = vi
      .spyOn(storage, "remove")
      .mockImplementation(async (storageKey) => {
        if (storageKey === failingKey) {
          throw new Error("storage refused the file");
        }
        await remove(storageKey);
      });
    try {
      const summary = await sweep.run(new Date(), {
        maxRemovals: 1,
        maxFailuresInARow: 20,
        pageSize: 1,
      });
      expect(summary.removed).toBe(1);
      expect(summary.failed).toBeGreaterThanOrEqual(1);
      // Every file the run tried came off or failed: none was kept.
      expect(summary.tried).toBe(summary.removed + summary.failed);
      expect(await hasRow(failingId)).toBe(true);
      expect(await hasRow(behindId)).toBe(false);
    } finally {
      refuse.mockRestore();
      warn.mockRestore();
    }

    await sweep.run();
    expect(await hasRow(failingId)).toBe(false);
  });

  it("reaches the files behind a run of files that fail on their own, which a stop at the front would keep stored", async () => {
    /*
     * The two oldest files fail every time and the limit is two in a row, with
     * a page of one. Storage works for the other two. The newest comes off as
     * the run's try, which leaves the third for the scan itself: that it is
     * removed shows the scan went on past the two. The order of the storage
     * calls shows the newest was the try and the third came after it.
     *
     * The try is on the newest candidate in the whole database, so the run is
     * judged at a moment when only files uploaded more than thirty years ago
     * are past their age: the four, and nothing another suite leaves behind,
     * however recently it stored it. A file older still would be scanned
     * before the four and changes nothing that is asserted here.
     */
    const years = 30 * 365 * 24;
    const failing = [
      await storeIssueFile(residentPersonId),
      await storeIssueFile(residentPersonId),
    ];
    const behindId = await storeIssueFile(residentPersonId);
    const newestId = await storeIssueFile(residentPersonId);
    for (const [index, fileId] of failing.entries()) {
      await age(fileId, years + 3 - index);
    }
    await age(behindId, years);
    await age(newestId, years - 1);
    // Past their age only what was uploaded more than `years - 2` hours ago.
    const judgedAt = new Date(
      Date.now() - (years - 2 - UNATTACHED_ISSUE_FILE_HOURS) * HOUR,
    );
    const failingKeys = await Promise.all(failing.map(storageKeyOf));
    const behindKey = await storageKeyOf(behindId);
    const newestKey = await storageKeyOf(newestId);
    const ownKeys = [...failingKeys, behindKey, newestKey];
    const calls: string[] = [];

    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const remove = storage.remove.bind(storage);
    const refuse = vi
      .spyOn(storage, "remove")
      .mockImplementation(async (storageKey) => {
        if (ownKeys.includes(storageKey)) {
          calls.push(storageKey);
        }
        if (failingKeys.includes(storageKey)) {
          throw new Error("storage refused the file");
        }
        await remove(storageKey);
      });
    try {
      const summary = await sweep.run(judgedAt, {
        maxRemovals: 500,
        maxFailuresInARow: 2,
        pageSize: 1,
      });
      expect(summary.stoppedOnFailures).toBe(false);
      // The two failures, then the try on the newest, then the third.
      expect(calls).toEqual([...failingKeys, newestKey, behindKey]);
      expect(summary.removed).toBeGreaterThanOrEqual(2);
      expect(await hasRow(newestId)).toBe(false);
      expect(await hasRow(behindId)).toBe(false);
      for (const fileId of failing) {
        expect(await hasRow(fileId)).toBe(true);
      }
    } finally {
      refuse.mockRestore();
      warn.mockRestore();
    }

    await sweep.run();
    for (const fileId of failing) {
      expect(await hasRow(fileId)).toBe(false);
    }
  });

  it("stops once removals have failed a number of times in a row, as when storage is down", async () => {
    /*
     * Three of this suite's files, and storage refuses every removal. The run
     * tries the newest candidate at the second failure in a row, whichever
     * files of the database's they were, and stops when that fails too, so
     * storage is asked exactly three times.
     */
    const fileIds = [
      await storeIssueFile(residentPersonId),
      await storeIssueFile(residentPersonId),
      await storeIssueFile(residentPersonId),
    ];
    for (const fileId of fileIds) {
      await age(fileId, UNATTACHED_ISSUE_FILE_HOURS + 1);
    }

    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    const refuse = vi
      .spyOn(storage, "remove")
      .mockRejectedValue(new Error("storage is down"));
    try {
      const summary = await sweep.run(new Date(), {
        maxRemovals: 500,
        maxFailuresInARow: 2,
        pageSize: 100,
      });
      expect(summary).toMatchObject({
        tried: 3,
        removed: 0,
        failed: 3,
        stoppedOnFailures: true,
      });
      expect(refuse).toHaveBeenCalledTimes(3);
      expect(
        error.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.startsWith("Issue file sweep stopped")),
      ).toHaveLength(1);
      for (const fileId of fileIds) {
        expect(await hasRow(fileId)).toBe(true);
      }
    } finally {
      refuse.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }

    await sweep.run();
    for (const fileId of fileIds) {
      expect(await hasRow(fileId)).toBe(false);
    }
  });

  it("stops at twenty removals failing in a row when the run is given no limits of its own", async () => {
    /*
     * The run's defaults, not the small limits the tests above pass in. Storage
     * refuses every removal and this suite stores twenty-one files, so the run
     * fails twenty times in a row, tries the newest candidate, which fails too,
     * and stops: storage is asked exactly twenty-one times, whichever files of
     * the database's they were, and the files behind are left to the next run.
     */
    const fileIds: string[] = [];
    for (let count = 0; count < 21; count += 1) {
      fileIds.push(await storeIssueFile(residentPersonId));
    }
    for (const fileId of fileIds) {
      await age(fileId, UNATTACHED_ISSUE_FILE_HOURS + 1);
    }

    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    const refuse = vi
      .spyOn(storage, "remove")
      .mockRejectedValue(new Error("storage is down"));
    try {
      const summary = await sweep.run();
      expect(summary).toMatchObject({
        tried: 21,
        removed: 0,
        failed: 21,
        stoppedOnFailures: true,
      });
      expect(refuse).toHaveBeenCalledTimes(21);
      expect(
        error.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.startsWith("Issue file sweep stopped")),
      ).toHaveLength(1);
      for (const fileId of fileIds) {
        expect(await hasRow(fileId)).toBe(true);
      }
    } finally {
      refuse.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }

    await sweep.run();
    for (const fileId of fileIds) {
      expect(await hasRow(fileId)).toBe(false);
    }
  });
});
