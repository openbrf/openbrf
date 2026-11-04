import { Logger } from "@nestjs/common";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { MediaService } from "../media/media.service";
import { IssueFreeTextService } from "./issue-free-text.service";

/**
 * What the log says when a removal of the free-text layer is refused, over a
 * database and a storage of the test's own: files taken before the refusal
 * cannot be put back, so a `kept` outcome that took some says how many, and
 * one that took none says nothing.
 */

const ISSUE_ID = "issue-1";
const NOW = new Date("2026-11-04T03:21:00Z");

/**
 * An issue with `files` photographs, whose removal stays due for the first
 * `dueFor` times it is asked and is refused after that. Each file is asked
 * once, then the text once.
 */
function build(files: number, dueFor: number) {
  const tx = {} as Prisma.TransactionClient;
  const fileIds = Array.from(
    { length: files },
    (_, index) => `file-${String(index)}`,
  );
  const prisma = {
    issuePhoto: {
      findMany: vi.fn(async () => fileIds.map((fileId) => ({ fileId }))),
    },
    issueAttachment: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(
      async (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx),
    ),
  } as unknown as PrismaService;
  // A file the removal still wants goes; one it refuses stays.
  const media = {
    remove: vi.fn(
      async (
        _id: string,
        _actor: null,
        _channel: string,
        options: {
          keep: (client: Prisma.TransactionClient) => Promise<boolean>;
        },
      ) => !(await options.keep(tx)),
    ),
  } as unknown as MediaService;
  const record = vi.fn();
  const audit = { record } as unknown as AuditLogService;
  let asked = 0;
  const removal = {
    stillDue: vi.fn(async () => {
      asked += 1;
      return asked <= dueFor;
    }),
    targetPersonId: null,
    context: { ground: "test" },
  };
  return {
    remove: () =>
      new IssueFreeTextService(prisma, media, audit).remove(
        ISSUE_ID,
        NOW,
        removal,
      ),
    record,
  };
}

describe("a removal of the free-text layer that is refused", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs how many files went when it is refused between two of them", async () => {
    const { remove, record } = build(3, 1);

    await expect(remove()).resolves.toBe("kept");

    expect(logged).toHaveBeenCalledExactlyOnceWith(
      `Issue ${ISSUE_ID} kept its free text after 1 files were removed`,
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("logs how many files went when it is refused at the text", async () => {
    const { remove, record } = build(2, 2);

    await expect(remove()).resolves.toBe("kept");

    expect(logged).toHaveBeenCalledExactlyOnceWith(
      `Issue ${ISSUE_ID} kept its free text after 2 files were removed`,
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("logs nothing when it is refused before any file went", async () => {
    const { remove } = build(2, 0);

    await expect(remove()).resolves.toBe("kept");

    expect(logged).not.toHaveBeenCalled();
  });

  it("logs nothing when it is refused on an issue with no files", async () => {
    const { remove } = build(0, 0);

    await expect(remove()).resolves.toBe("kept");

    expect(logged).not.toHaveBeenCalled();
  });
});
