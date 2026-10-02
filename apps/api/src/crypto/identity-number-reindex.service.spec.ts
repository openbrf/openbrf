import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import type { FieldEncryptionService } from "./field-encryption.service";
import {
  IDENTITY_NUMBER_REINDEX_QUEUE,
  IdentityNumberReindexService,
} from "./identity-number-reindex.service";

/** The walk is queued at start-up only while some index is outdated. */
function boot(outdated: number): {
  service: IdentityNumberReindexService;
  send: ReturnType<typeof vi.fn>;
  work: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue("job");
  const work = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    person: { count: vi.fn().mockResolvedValue(outdated) },
  } as unknown as PrismaService;
  const service = new IdentityNumberReindexService(
    { NODE_ENV: "production" } as Env,
    prisma,
    {} as FieldEncryptionService,
    { send, work } as unknown as JobQueueService,
  );
  return { service, send, work };
}

describe("queueing the identity number reindex at start-up", () => {
  it("queues the walk while an index is outdated", async () => {
    const { service, send, work } = boot(3);

    await service.onModuleInit();

    expect(work).toHaveBeenCalledWith(
      IDENTITY_NUMBER_REINDEX_QUEUE,
      expect.any(Function),
    );
    expect(send).toHaveBeenCalledWith(IDENTITY_NUMBER_REINDEX_QUEUE, {});
  });

  it("queues nothing once every index is current", async () => {
    const { service, send, work } = boot(0);

    await service.onModuleInit();

    expect(work).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
