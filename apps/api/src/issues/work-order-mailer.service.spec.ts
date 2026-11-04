import { describe, expect, it, vi } from "vite-plus/test";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import type { MailService } from "../mail/mail.service";
import {
  WORK_ORDER_ABANDONED_QUEUE,
  WORK_ORDER_QUEUE,
  WorkOrderMailerService,
} from "./work-order-mailer.service";

/**
 * The consumers of the work-order queues.
 *
 * The integration suite drives `send` and `recordAbandoned` itself, because a
 * worker left running on the shared test database would take the jobs of
 * other suites. So this holds the one thing that suite cannot see: that the
 * worker the application starts hands each queue's job to the right method,
 * with the job's work order.
 */

type Handler = (data: { workOrderId: string }) => Promise<void>;

function mailerWithWorkers(env: Partial<Env> = {}) {
  const handlers = new Map<string, Handler>();
  const jobs = {
    work: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
      return Promise.resolve();
    }),
  };
  const mailer = new WorkOrderMailerService(
    { NODE_ENV: "production", ...env } as Env,
    {} as PrismaService,
    {} as FieldEncryptionService,
    {} as MailService,
    jobs as unknown as JobQueueService,
  );
  return { mailer, jobs, handlers };
}

describe("WorkOrderMailerService workers", () => {
  it("hands a sending job to send and an abandoned one to recordAbandoned", async () => {
    const { mailer, handlers } = mailerWithWorkers();
    const send = vi.spyOn(mailer, "send").mockResolvedValue("sent");
    const recordAbandoned = vi
      .spyOn(mailer, "recordAbandoned")
      .mockResolvedValue(undefined);

    await mailer.onModuleInit();
    expect([...handlers.keys()].sort()).toEqual(
      [WORK_ORDER_QUEUE, WORK_ORDER_ABANDONED_QUEUE].sort(),
    );

    await handlers.get(WORK_ORDER_QUEUE)?.({ workOrderId: "wo-1" });
    expect(send).toHaveBeenCalledWith("wo-1");
    expect(recordAbandoned).not.toHaveBeenCalled();

    await handlers.get(WORK_ORDER_ABANDONED_QUEUE)?.({ workOrderId: "wo-2" });
    expect(recordAbandoned).toHaveBeenCalledWith("wo-2");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("starts no worker under test, where the integration suite drives the job", async () => {
    const { mailer, jobs } = mailerWithWorkers({ NODE_ENV: "test" });
    await mailer.onModuleInit();
    expect(jobs.work).not.toHaveBeenCalled();
  });
});
