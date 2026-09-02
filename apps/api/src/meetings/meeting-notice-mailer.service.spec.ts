import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { MailNotConfiguredError, type MailService } from "../mail/mail.service";
import { MeetingNoticeMailerService } from "./meeting-notice-mailer.service";

/**
 * How a notice reaches each member once and never twice, and what it records
 * when it reaches one of them not at all.
 *
 * The claim is the whole of the first half: a conditional update from PENDING,
 * taken before the message is handed to a mail server. The second half is the
 * ledger, and every case below asserts what is written on the row rather than
 * what the mail server said - a rejection quotes the envelope back, and the
 * envelope is a member's address.
 */

const NOTICE = {
  startsAt: new Date("2027-05-18T17:00:00.000Z"),
  place: "Foreningslokalen, Storgatan 1",
  digitalParticipation: null as string | null,
  meeting: {
    kind: "ORDINARY" as const,
    agendaItems: [
      { title: "Stammans oppnande" },
      { title: "Val av ordforande" },
    ],
  },
};

const PERSON = {
  firstName: "Astrid",
  lastName: "Lindqvist",
  emailCipher: "cipher" as string | null,
  preferredLocale: "sv",
};

function build(
  options: {
    notice?: typeof NOTICE | null;
    pending?: { id: string; personId: string }[];
    person?: typeof PERSON | null;
    claims?: number;
    sendFails?: Error;
  } = {},
) {
  const order: string[] = [];

  const meetingNoticeDelivery = {
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
    meetingNotice: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.notice === undefined ? NOTICE : options.notice,
        ),
    },
    meetingNoticeDelivery,
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
    service: new MeetingNoticeMailerService(
      { NODE_ENV: "test", APP_URL: "https://brf.example" } as unknown as Env,
      prisma as unknown as PrismaService,
      encryption as unknown as FieldEncryptionService,
      mail as unknown as MailService,
      jobs as unknown as JobQueueService,
    ),
    meetingNoticeDelivery,
    encryption,
    mail,
    jobs,
    order,
  };
}

describe("sending one notice", () => {
  it("claims each row before it hands the message to a mail server", async () => {
    const { service, meetingNoticeDelivery, order } = build();

    await service.runSending("notice-1");

    expect(order).toEqual(["claim", "send"]);
    expect(meetingNoticeDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "delivery-1", channel: "EMAIL", status: "PENDING" },
      data: { status: "SENT", sentAt: expect.any(Date) },
    });
  });

  /**
   * The notice itself and not a link to it.
   *
   * EFL 6 kap. 22 § makes the content the requirement - the time, the place and
   * the matters to be dealt with, clearly stated - so a message carrying a
   * heading and a link to a page behind a sign-in would not be a notice that had
   * been given. This is the assertion that keeps the mail a document.
   */
  it("carries the time, the place and every matter, in the member's own language", async () => {
    const { service, mail, encryption } = build();

    await service.runSending("notice-1");

    expect(encryption.decrypt).toHaveBeenCalledWith("person.email", "cipher");
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "astrid@eksemplet.test",
        locale: "sv",
        props: expect.objectContaining({
          kind: "ORDINARY",
          startsAt: NOTICE.startsAt,
          place: "Foreningslokalen, Storgatan 1",
          digitalParticipation: null,
          agenda: ["Stammans oppnande", "Val av ordforande"],
        }),
      }),
    );
  });

  it("carries the participation instruction for a meeting held digitally", async () => {
    const { service, mail } = build({
      notice: { ...NOTICE, digitalParticipation: "Lank skickas dagen fore." },
    });

    await service.runSending("notice-1");

    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({
          digitalParticipation: "Lank skickas dagen fore.",
        }),
      }),
    );
  });

  it("sends nothing for a row another worker already claimed", async () => {
    const { service, mail, order } = build({ claims: 0 });

    const result = await service.runSending("notice-1");

    expect(order).toEqual(["claim"]);
    expect(mail.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it("records the failure on the row when the instance has no mail server", async () => {
    const { service, meetingNoticeDelivery } = build({
      sendFails: new MailNotConfiguredError(),
    });

    const result = await service.runSending("notice-1");

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(meetingNoticeDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: {
        status: "FAILED",
        failureReason: "mail-not-configured",
        sentAt: null,
      },
    });
  });

  /**
   * The refusal is recorded as a code.
   *
   * The message a mail server sends back quotes the address it refused, so
   * storing it would put a member's email in the ledger the board's screen
   * reads. This case asserts the code and asserts that the server's own sentence
   * is nowhere in what was written.
   */
  it("records a mail server's refusal as a code and never in its own words", async () => {
    const refusal = "550 5.1.1 <astrid@eksemplet.test> unknown";
    const { service, meetingNoticeDelivery } = build({
      sendFails: new Error(refusal),
    });

    await service.runSending("notice-1");

    expect(meetingNoticeDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: { status: "FAILED", failureReason: "send-failed", sentAt: null },
    });
    expect(
      JSON.stringify(meetingNoticeDelivery.update.mock.calls),
    ).not.toContain("astrid@eksemplet.test");
  });

  it("carries on past one unreachable member, so the rest are still called", async () => {
    const { service, mail } = build({
      pending: [
        { id: "delivery-1", personId: "person-1" },
        { id: "delivery-2", personId: "person-2" },
      ],
    });
    mail.send
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(undefined);

    const result = await service.runSending("notice-1");

    expect(result).toEqual({ sent: 1, failed: 1 });
  });

  it("records a member who is no longer on this instance", async () => {
    const { service, meetingNoticeDelivery, mail } = build({ person: null });

    const result = await service.runSending("notice-1");

    expect(mail.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(meetingNoticeDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "recipient-gone" }),
      }),
    );
  });

  /**
   * A member with no address is failed under a code of their own.
   *
   * The board has to be able to tell them apart from a member who left, because
   * the two need different things done about them: one is nobody's business any
   * more, and the other is somebody the board still has to call (EFL 6 kap.
   * 21 §).
   */
  it("distinguishes a member the association holds no address for", async () => {
    const { service, meetingNoticeDelivery, mail } = build({
      person: { ...PERSON, emailCipher: null },
    });

    const result = await service.runSending("notice-1");

    expect(mail.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(meetingNoticeDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "no-email-address" }),
      }),
    );
  });

  it("does nothing for a notice that is gone by the time the worker runs", async () => {
    const { service, mail } = build({ notice: null });

    expect(await service.runSending("notice-1")).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe("a sending that was given up on", () => {
  it("marks the rows nobody reached as interrupted", async () => {
    const { service, meetingNoticeDelivery } = build();

    await service.recordAbandoned("notice-1");

    expect(meetingNoticeDelivery.updateMany).toHaveBeenCalledWith({
      where: { noticeId: "notice-1", channel: "EMAIL", status: "PENDING" },
      data: {
        status: "FAILED",
        failureReason: "notice-sending-interrupted",
      },
    });
  });
});
