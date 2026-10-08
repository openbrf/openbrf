import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import type { SentMail } from "../mail/mail-driver";
import type { MailService } from "../mail/mail.service";
import { BoardMailboxMailerService } from "./board-mailbox-mailer.service";

/**
 * The identifier a board mailbox answer keeps.
 *
 * A mail service that owns the Message-ID refuses the one minted when the
 * answer was written and delivers the message under its own. That delivered
 * identifier is the one a copy of the answer comes back with and the one the
 * correspondent's reply names, so it is what the row has to hold once the
 * answer is marked sent (ADR 0024). The integration suite proves the reply then
 * joins its thread; this pins the write itself.
 */

const MINTED = "0f8e2c1a-minted@eksemplet.example";

const REPLY = {
  id: "reply-1",
  body: "Tack for ditt brev.",
  messageId: MINTED,
  inReplyTo: "fraga-1@utanfor.example",
  thread: {
    subject: "Fraga om balkongen",
    correspondentEmailCipher: "brf:email",
    correspondentNameCipher: null,
  },
};

function build(sent: SentMail) {
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    boardMailboxMessage: {
      findUnique: vi.fn().mockResolvedValue(REPLY),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update,
    },
    association: {
      findUnique: vi.fn().mockResolvedValue({
        boardMailboxAddress: "styrelsen@eksemplet.example",
        boardMailboxPop3Host: "pop.eksemplet.example",
        boardMailboxPop3Port: null,
        boardMailboxPop3Secure: true,
        boardMailboxPop3User: "styrelsen",
        boardMailboxPop3PasswordCipher: "brf:password",
      }),
    },
  };
  const encryption = {
    decrypt: vi.fn().mockResolvedValue("granne@utanfor.example"),
  };
  const mail = { send: vi.fn().mockResolvedValue(sent) };

  const mailer = new BoardMailboxMailerService(
    { NODE_ENV: "test" } as Env,
    prisma as unknown as PrismaService,
    encryption as unknown as FieldEncryptionService,
    mail as unknown as MailService,
    {} as JobQueueService,
  );
  return { mailer, update, mail, prisma };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("marking an answer sent", () => {
  it("replaces the minted identifier with the one it was delivered under", async () => {
    const { mailer, update, mail } = build({ messageId: "abc@getpost.se" });

    expect(await mailer.sendReply("reply-1")).toBe("sent");

    // The minted one is still what the answer was handed over with.
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: MINTED,
        inReplyTo: "fraga-1@utanfor.example",
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "reply-1" },
      data: { deliveryStatus: "SENT", messageId: "abc@getpost.se" },
    });
  });

  it("leaves the identifier alone when it was delivered under its own", async () => {
    const { mailer, update } = build({ messageId: MINTED });

    expect(await mailer.sendReply("reply-1")).toBe("sent");

    expect(update).toHaveBeenCalledWith({
      where: { id: "reply-1" },
      data: { deliveryStatus: "SENT" },
    });
  });

  it("leaves the minted identifier when the transport reported none, and says so", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {
      // Asserted on below rather than printed.
    });
    const { mailer, update } = build({ messageId: null });

    expect(await mailer.sendReply("reply-1")).toBe("sent");

    expect(update).toHaveBeenCalledWith({
      where: { id: "reply-1" },
      data: { deliveryStatus: "SENT" },
    });
    // Named by the reply, and never by an address.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reply-1"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("may not join its thread"),
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("@");
  });

  it("names the delivered identifier when the row cannot be updated", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {
      // Asserted on below rather than printed.
    });
    const { mailer, update } = build({ messageId: "abc@getpost.se" });
    update.mockRejectedValueOnce(new Error("connection lost"));

    /*
     * The job fails rather than completing. A completed job is never looked at
     * again, and the row would say "on its way" for good; a failed one is
     * retried and then dead-lettered, and the handler there settles the row.
     */
    await expect(mailer.sendReply("reply-1")).rejects.toThrow();

    // Nothing else holds the identifier the correspondent's reply will name,
    // so the log line is what the row is repaired from.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("delivered as <abc@getpost.se>"),
    );
  });
});

describe("a reply another attempt claimed", () => {
  it("fails the job while the claim is unresolved, so the queue can settle it", async () => {
    /*
     * An attempt claimed the row and stopped: the process was restarted during
     * the handover, or the job expired under it. Its retry finds the row
     * claimed. Answering "skipped" would complete the job, and the reply would
     * read as on its way for good; failing it leaves the queue's retries and its
     * dead letter to resolve the row.
     */
    const { mailer, mail, prisma } = build({ messageId: null });
    prisma.boardMailboxMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.boardMailboxMessage.findUnique
      .mockResolvedValueOnce(REPLY)
      .mockResolvedValueOnce({
        deliveryStatus: "PENDING",
        sentAt: new Date("2026-10-05T08:00:00.000Z"),
      });

    await expect(mailer.sendReply("reply-1")).rejects.toThrow();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("skips a reply whose delivery is already settled", async () => {
    const { mailer, mail, prisma } = build({ messageId: null });
    prisma.boardMailboxMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.boardMailboxMessage.findUnique
      .mockResolvedValueOnce(REPLY)
      .mockResolvedValueOnce({
        deliveryStatus: "SENT",
        sentAt: new Date("2026-10-05T08:00:00.000Z"),
      });

    expect(await mailer.sendReply("reply-1")).toBe("skipped");
    expect(mail.send).not.toHaveBeenCalled();
  });
});
