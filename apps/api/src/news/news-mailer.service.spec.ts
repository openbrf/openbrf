import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { MailNotConfiguredError, type MailService } from "../mail/mail.service";
import { paragraphsContent } from "../site/page-content";
import { NewsMailerService } from "./news-mailer.service";

/**
 * How a mailing reaches each member once and never twice.
 *
 * The claim is the whole of it: a conditional update from PENDING, taken before
 * the message is handed to a mail server. The cases below hold the worker to
 * that order, to leaving a row somebody else claimed alone, and to recording a
 * failure on the row rather than abandoning the recipients after it.
 */

const NEWS = {
  slug: "tvattstugan",
  title: "Nya tider i tvättstugan",
  content: paragraphsContent(["Från måndag gäller nya tider."]) as unknown,
  published: true,
  emailQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
};

const PERSON = {
  firstName: "Astrid",
  lastName: "Lindqvist",
  emailCipher: "cipher",
  preferredLocale: "sv",
};

function build(
  options: {
    news?: typeof NEWS | null;
    pending?: { id: string; personId: string }[];
    person?: typeof PERSON | null;
    claims?: number;
    sendFails?: Error;
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
    decrypt: vi.fn().mockResolvedValue("astrid@eksemplet.test"),
  };
  const mail = {
    send: vi.fn(async () => {
      order.push("send");
      if (options.sendFails !== undefined) {
        throw options.sendFails;
      }
    }),
  };
  const jobs = {
    work: vi.fn().mockResolvedValue(undefined),
    ensureQueue: vi.fn().mockResolvedValue(undefined),
    sendInTransaction: vi.fn().mockResolvedValue(undefined),
  };

  return {
    service: new NewsMailerService(
      { NODE_ENV: "test", APP_URL: "https://brf.example" } as unknown as Env,
      prisma as unknown as PrismaService,
      encryption as unknown as FieldEncryptionService,
      mail as unknown as MailService,
      jobs as unknown as JobQueueService,
    ),
    prisma,
    newsDelivery,
    encryption,
    mail,
    jobs,
    order,
  };
}

describe("working through a mailing", () => {
  it("claims each row before it hands the message to a mail server", async () => {
    const { service, newsDelivery, order } = build();

    await service.runMailing("news-1");

    expect(order).toEqual(["claim", "send"]);
    expect(newsDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "delivery-1", channel: "EMAIL", status: "PENDING" },
      data: { status: "SENT", sentAt: expect.any(Date) },
    });
  });

  it("mails the recipient in their own language, at an address it decrypts itself", async () => {
    const { service, mail, encryption } = build();

    await service.runMailing("news-1");

    expect(encryption.decrypt).toHaveBeenCalledWith("person.email", "cipher");
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "astrid@eksemplet.test",
        locale: "sv",
        props: expect.objectContaining({
          title: "Nya tider i tvättstugan",
          teaser: "Från måndag gäller nya tider.",
          articleUrl: "https://brf.example/nyheter/tvattstugan",
        }),
      }),
    );
  });

  it("sends nothing for a row another worker already claimed", async () => {
    const { service, mail, order } = build({ claims: 0 });

    const result = await service.runMailing("news-1");

    expect(order).toEqual(["claim"]);
    expect(mail.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it("asks only for this channel's rows, so the SMS worker keeps its own", async () => {
    const { service, newsDelivery } = build();

    await service.runMailing("news-1");

    expect(newsDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { newsId: "news-1", channel: "EMAIL", status: "PENDING" },
      }),
    );
  });

  it("records the failure on the row when the instance has no mail server", async () => {
    const { service, newsDelivery } = build({
      sendFails: new MailNotConfiguredError(),
    });

    const result = await service.runMailing("news-1");

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(newsDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: {
        status: "FAILED",
        failureReason: "mail-not-configured",
        sentAt: null,
      },
    });
  });

  it("records a mail server's refusal without repeating what it said", async () => {
    const { service, newsDelivery } = build({
      sendFails: new Error("550 5.1.1 <astrid@eksemplet.test> unknown"),
    });

    await service.runMailing("news-1");

    expect(newsDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "send-failed" }),
      }),
    );
  });

  it("carries on past one unreachable recipient", async () => {
    const { service, mail } = build({
      pending: [
        { id: "delivery-1", personId: "person-1" },
        { id: "delivery-2", personId: "person-2" },
      ],
    });
    mail.send
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(undefined);

    const result = await service.runMailing("news-1");

    expect(result).toEqual({ sent: 1, failed: 1 });
  });

  it("records a recipient who is no longer in the register", async () => {
    const { service, newsDelivery, mail } = build({ person: null });

    const result = await service.runMailing("news-1");

    expect(mail.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(newsDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "recipient-gone" }),
      }),
    );
  });

  it("does nothing for an item that was taken down before the worker ran", async () => {
    const { service, mail } = build({
      news: { ...NEWS, published: false },
    });

    expect(await service.runMailing("news-1")).toEqual({ sent: 0, failed: 0 });
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe("a mailing that was given up on", () => {
  it("marks this channel's remaining rows as interrupted and leaves the SMS alone", async () => {
    const { service, newsDelivery } = build();

    await service.recordAbandoned("news-1");

    expect(newsDelivery.updateMany).toHaveBeenCalledWith({
      where: { newsId: "news-1", channel: "EMAIL", status: "PENDING" },
      data: { status: "FAILED", failureReason: "mailing-interrupted" },
    });
  });
});
