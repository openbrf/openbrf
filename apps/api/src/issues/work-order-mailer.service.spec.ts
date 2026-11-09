import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { MailApiError } from "../mail/http-api-mail.driver";
import { MailNotConfiguredError, type MailService } from "../mail/mail.service";
import { MailServerNotPublicError } from "../mail/smtp-mail.driver";
import type { PagesService } from "../site/pages.service";
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
    {} as PagesService,
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

/**
 * What a failed mail send records on the work order.
 *
 * The mail service is a stub that fails as a driver does, because what decides
 * the record is what the driver's error says about how far the send had got
 * (`MailHandover`), and the integration suite cannot make a real mail server
 * break at a chosen point.
 */
describe("a work order the mail did not confirm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mailerFailingWith(
    outcome: { rejects: unknown } | { resolves: unknown },
    claimed: { privacyNoticeOwed?: boolean | null } = {},
  ) {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => {
      // The failure is asserted on the row, not in the log.
    });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {
      // Likewise.
    });
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      workOrder: {
        findUnique: vi.fn().mockResolvedValue({ issue: { typeId: "type-1" } }),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([
        {
          recipientName: "Rormokaren AB",
          recipientEmailCipher: "brf:email",
          body: "Byt packningen.",
          contractorId: "contractor-1",
          privacyNoticeOwed: null,
          ...claimed,
        },
      ]),
    };
    const prisma = {
      association: {
        findUnique: vi.fn().mockResolvedValue({ defaultLocale: "sv" }),
      },
      $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)),
      workOrder: { update },
    };
    const send =
      "rejects" in outcome
        ? vi.fn().mockRejectedValue(outcome.rejects)
        : vi.fn().mockResolvedValue(outcome.resolves);
    const mailer = new WorkOrderMailerService(
      { NODE_ENV: "test" } as Env,
      prisma as unknown as PrismaService,
      {
        decrypt: vi.fn().mockResolvedValue("ror@exempel.se"),
      } as unknown as FieldEncryptionService,
      { send } as unknown as MailService,
      {} as JobQueueService,
      {
        privacyNoticePath: vi.fn().mockResolvedValue("/integritetspolicy"),
      } as unknown as PagesService,
    );
    return { mailer, update, send };
  }

  function recorded(failure: string) {
    return {
      where: { id: "wo-1" },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: failure,
        claimedAt: null,
      },
    };
  }

  it.each([
    [
      "a server this instance may not connect to",
      new MailServerNotPublicError({ cause: null }),
    ],
    [
      "the mail API refusing the request",
      new MailApiError("refused", 422, "not-handed-over"),
    ],
  ])(
    "records %s, which the driver says came before the handover, as not sent",
    async (_what, error) => {
      const { mailer, update } = mailerFailingWith({ rejects: error });

      expect(await mailer.send("wo-1")).toBe("failed");
      expect(update).toHaveBeenCalledWith(recorded("send-failed"));
    },
  );

  it.each([
    [
      "the mail API failing after it read the request",
      new MailApiError("refused", 502, "may-have-been-handed-over"),
    ],
    [
      "an SMTP connection that went quiet with the message on its way",
      Object.assign(new Error("Timeout"), {
        code: "ETIMEDOUT",
        handover: "may-have-been-handed-over",
      }),
    ],
    [
      "a failure that does not say how far it got",
      new Error("Connection closed unexpectedly"),
    ],
  ])(
    "records %s as unconfirmed, so the handler does not send it twice",
    async (_what, error) => {
      const { mailer, update } = mailerFailingWith({ rejects: error });

      expect(await mailer.send("wo-1")).toBe("failed");
      expect(update).toHaveBeenCalledWith(recorded("delivery-unconfirmed"));
    },
  );

  it.each([
    [true, "/integritetspolicy"],
    [false, null],
    [null, null],
  ] as const)(
    "links the privacy notice only for a contractor the claim says is owed it (owed: %s)",
    async (owed, path) => {
      const { mailer, send } = mailerFailingWith(
        { rejects: new MailNotConfiguredError() },
        { privacyNoticeOwed: owed },
      );

      await mailer.send("wo-1");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          props: expect.objectContaining({ privacyNoticePath: path }),
        }),
      );
    },
  );

  it("records no mail server as its own code", async () => {
    const { mailer, update } = mailerFailingWith({
      rejects: new MailNotConfiguredError(),
    });

    expect(await mailer.send("wo-1")).toBe("failed");
    expect(update).toHaveBeenCalledWith(recorded("mail-not-configured"));
  });
});
