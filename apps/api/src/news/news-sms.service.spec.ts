import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { I18nService } from "../i18n/i18n.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { SmsNotConfiguredError } from "../sms/sms.driver";
import type { SmsService } from "../sms/sms.service";
import { RecordingSmsDriver } from "../sms/testing/recording.driver";
import { NewsSmsService } from "./news-sms.service";

/**
 * How an SMS mailing reaches each member once and never twice.
 *
 * The same discipline the email mailing lives by, held to here in its own
 * right: a conditional update from PENDING, taken before the message is handed
 * to a provider. The cases also hold this worker to its own channel's rows -
 * two workers on one ledger must not be able to claim each other's.
 */

const NEWS = {
  slug: "tvattstugan",
  title: "Nya tider i tvattstugan",
  published: true,
  smsQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
};

const PERSON: { phoneCipher: string | null; preferredLocale: string } = {
  phoneCipher: "cipher",
  preferredLocale: "sv",
};

function build(
  options: {
    news?: typeof NEWS | null;
    pending?: { id: string; personId: string }[];
    person?: typeof PERSON | null;
    claims?: number;
    sendFails?: Error;
    phone?: string;
  } = {},
) {
  const order: string[] = [];

  const newsDelivery = {
    findMany: vi
      .fn()
      .mockResolvedValue(
        options.pending ?? [{ id: "delivery-1", personId: "person-1" }],
      ),
    updateMany: vi.fn(async () => {
      order.push("claim");
      return { count: options.claims ?? 1 };
    }),
    update: vi.fn(async () => {
      order.push("fail");
      return {};
    }),
  };

  const prisma = {
    news: {
      findUnique: vi
        .fn()
        .mockResolvedValue(options.news === undefined ? NEWS : options.news),
    },
    association: {
      findUnique: vi.fn().mockResolvedValue({ name: "BRF Ekhagen" }),
    },
    newsDelivery,
    person: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.person === undefined ? PERSON : options.person,
        ),
    },
  };

  const encryption = {
    decrypt: vi.fn().mockResolvedValue(options.phone ?? "070-123 45 67"),
  };
  const i18n = {
    translatorFor: vi.fn(
      () => (_key: string, values: Record<string, string>) =>
        `${values.association}: ${values.title}`,
    ),
  };
  /*
   * The messages the worker handed over, kept rather than sent.
   *
   * The double records, so a case can assert what a member would actually have
   * received - the number and the whole text - instead of only that something
   * was called. It reaches no network by construction: there is no address on
   * it to point anywhere.
   */
  const driver = new RecordingSmsDriver();
  driver.failWith = options.sendFails;
  const sms = {
    send: vi.fn(async (message: { to: string; body: string }) => {
      order.push("send");
      await driver.send(message);
    }),
  };
  const jobs = {
    work: vi.fn().mockResolvedValue(undefined),
    ensureQueue: vi.fn().mockResolvedValue(undefined),
    sendInTransaction: vi.fn().mockResolvedValue(undefined),
  };

  return {
    service: new NewsSmsService(
      { NODE_ENV: "test", APP_URL: "https://brf.example" } as unknown as Env,
      prisma as unknown as PrismaService,
      encryption as unknown as FieldEncryptionService,
      i18n as unknown as I18nService,
      sms as unknown as SmsService,
      jobs as unknown as JobQueueService,
    ),
    prisma,
    newsDelivery,
    encryption,
    i18n,
    sms,
    driver,
    jobs,
    order,
  };
}

describe("working through an SMS mailing", () => {
  it("claims each row before it hands the message to a provider", async () => {
    const { service, newsDelivery, order } = build();

    await service.runMailing("news-1");

    expect(order).toEqual(["claim", "send"]);
    expect(newsDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "delivery-1", channel: "SMS", status: "PENDING" },
      data: { status: "SENT", sentAt: expect.any(Date) },
    });
  });

  it("texts the recipient in their own language, at a number it decrypts itself", async () => {
    const { service, driver, encryption, i18n } = build();

    await service.runMailing("news-1");

    expect(encryption.decrypt).toHaveBeenCalledWith("person.phone", "cipher");
    expect(i18n.translatorFor).toHaveBeenCalledWith("sv");
    expect(driver.sent).toEqual([
      {
        // Normalized to E.164 here rather than stored that way: the cipher
        // holds the number as the board typed it.
        to: "+46701234567",
        body: "BRF Ekhagen: Nya tider i tvattstugan\nhttps://brf.example/nyheter/tvattstugan",
      },
    ]);
  });

  it("asks only for this channel's rows, so the mail worker keeps its own", async () => {
    const { service, newsDelivery } = build();

    await service.runMailing("news-1");

    expect(newsDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { newsId: "news-1", channel: "SMS", status: "PENDING" },
      }),
    );
  });

  it("sends nothing for a row another worker already claimed", async () => {
    const { service, sms, order } = build({ claims: 0 });

    const result = await service.runMailing("news-1");

    expect(order).toEqual(["claim"]);
    expect(sms.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it("records the failure on the row when the instance has no SMS provider", async () => {
    const { service, newsDelivery } = build({
      sendFails: new SmsNotConfiguredError(),
    });

    const result = await service.runMailing("news-1");

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(newsDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: {
        status: "FAILED",
        failureReason: "sms-not-configured",
        sentAt: null,
      },
    });
  });

  it("records a gateway's refusal without repeating what it said", async () => {
    const { service, newsDelivery } = build({
      sendFails: new Error("422 invalid msisdn +46701234567"),
    });

    await service.runMailing("news-1");

    expect(newsDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "send-failed" }),
      }),
    );
  });

  it("carries on past one unreachable recipient", async () => {
    const { service, sms, driver } = build({
      pending: [
        { id: "delivery-1", personId: "person-1" },
        { id: "delivery-2", personId: "person-2" },
      ],
    });
    // The first recipient's provider refusal, and nobody else's: one number a
    // gateway will not take must not abandon the members after it.
    sms.send.mockImplementationOnce(() => Promise.reject(new Error("refused")));

    const result = await service.runMailing("news-1");

    expect(result).toEqual({ sent: 1, failed: 1 });
    // The second member was texted even though the first could not be.
    expect(driver.recipients).toEqual(["+46701234567"]);
  });

  it("records a recipient who is no longer in the register", async () => {
    const { service, newsDelivery, sms } = build({ person: null });

    const result = await service.runMailing("news-1");

    expect(sms.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(newsDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "recipient-gone" }),
      }),
    );
  });

  it("records a recipient whose number went away between the publish and the send", async () => {
    const { service, newsDelivery, sms } = build({
      person: { phoneCipher: null, preferredLocale: "sv" },
    });

    expect(await service.runMailing("news-1")).toEqual({ sent: 0, failed: 1 });
    expect(sms.send).not.toHaveBeenCalled();
    expect(newsDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "no-phone-number" }),
      }),
    );
  });

  it("offers nothing to a provider when what is stored is not a number", async () => {
    const { service, newsDelivery, sms } = build({ phone: "not a number" });

    expect(await service.runMailing("news-1")).toEqual({ sent: 0, failed: 1 });
    expect(sms.send).not.toHaveBeenCalled();
    expect(newsDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "no-phone-number" }),
      }),
    );
  });

  it("does nothing for an item that was taken down before the worker ran", async () => {
    const { service, sms } = build({ news: { ...NEWS, published: false } });

    expect(await service.runMailing("news-1")).toEqual({ sent: 0, failed: 0 });
    expect(sms.send).not.toHaveBeenCalled();
  });
});

describe("an SMS mailing that was given up on", () => {
  it("marks this channel's remaining rows as interrupted and leaves the email alone", async () => {
    const { service, newsDelivery } = build();

    await service.recordAbandoned("news-1");

    expect(newsDelivery.updateMany).toHaveBeenCalledWith({
      where: { newsId: "news-1", channel: "SMS", status: "PENDING" },
      data: { status: "FAILED", failureReason: "mailing-interrupted" },
    });
  });
});

describe("the job it enqueues", () => {
  it("carries one news id and no number", async () => {
    const { service, jobs } = build();

    await service.enqueueInTransaction({ $queryRawUnsafe: vi.fn() }, "news-1");

    expect(jobs.sendInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      "news-sms",
      { newsId: "news-1" },
      expect.objectContaining({ deadLetter: "news-sms-abandoned" }),
    );
  });
});
