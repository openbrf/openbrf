import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import type { MailService } from "../mail/mail.service";
import { BreachReminderService } from "./breach-reminder.service";
import { BREACH_REMINDER_QUEUE } from "./breach-reminder.queue";

/**
 * What the worker does around a failed reminder.
 *
 * What a reminder sends, to whom and how often is asserted against a database
 * in `data-protection.int-spec.ts`. The one thing that needs no database is
 * what the worker says when the queue is about to stop trying.
 */

interface Job {
  data: { breachId: string; discoveredAt: string };
  retryCount: number;
  retryLimit: number;
}

function build() {
  let handler: ((batch: Job[]) => Promise<void>) | undefined;
  const jobs = {
    ensureQueue: vi.fn(async () => undefined),
    instance: {
      work: vi.fn(
        async (
          _queue: string,
          _options: unknown,
          run: (batch: Job[]) => Promise<void>,
        ) => {
          handler = run;
        },
      ),
    },
  };
  const service = new BreachReminderService(
    { NODE_ENV: "test" } as Env,
    {} as PrismaService,
    {} as FieldEncryptionService,
    {} as MailService,
    jobs as unknown as JobQueueService,
  );
  const send = vi.spyOn(service, "sendBreachReminder");
  const errors = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {
    /* captured */
  });
  return {
    service,
    jobs,
    send,
    errors,
    run: (job: Job) => handler?.([job]),
  };
}

const DATA = {
  breachId: "breach-1",
  discoveredAt: "2026-10-01T08:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the breach reminder worker", () => {
  it("watches the reminder queue, asking for the retry metadata", async () => {
    const fakes = build();

    await fakes.service.startReminderWorker();

    expect(fakes.jobs.ensureQueue).toHaveBeenCalledWith(BREACH_REMINDER_QUEUE);
    expect(fakes.jobs.instance.work).toHaveBeenCalledWith(
      BREACH_REMINDER_QUEUE,
      { includeMetadata: true },
      expect.any(Function),
    );
  });

  it("fails a run with retries left without saying it gave up", async () => {
    const fakes = build();
    fakes.send.mockRejectedValue(new Error("did not reach 1 of the 2"));
    await fakes.service.startReminderWorker();

    await expect(
      fakes.run({ data: DATA, retryCount: 2, retryLimit: 5 }),
    ).rejects.toThrow(/did not reach/);

    expect(fakes.errors).not.toHaveBeenCalled();
  });

  it("says once, on the run no retry follows, that the reminder was given up on", async () => {
    const fakes = build();
    fakes.send.mockRejectedValue(new Error("did not reach 1 of the 2"));
    await fakes.service.startReminderWorker();

    await expect(
      fakes.run({ data: DATA, retryCount: 5, retryLimit: 5 }),
    ).rejects.toThrow(/did not reach/);

    expect(fakes.errors).toHaveBeenCalledTimes(1);
    expect(fakes.errors.mock.calls[0]?.[0]).toContain("breach-1");
    expect(fakes.errors.mock.calls[0]?.[0]).toContain("6 attempts");
  });

  it("completes a run that sent, so the queue does not try again", async () => {
    const fakes = build();
    fakes.send.mockResolvedValue(2);
    await fakes.service.startReminderWorker();

    await expect(
      fakes.run({ data: DATA, retryCount: 0, retryLimit: 5 }),
    ).resolves.toBeUndefined();
  });
});
