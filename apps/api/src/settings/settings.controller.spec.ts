import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { DomainExceptionFilter } from "../http/domain-exception.filter";
import { SettingsWriteController } from "./settings.controller";
import type { SettingsService } from "./settings.service";

/**
 * A mail server's host on the way into the settings.
 *
 * Both services write the host they are given into the log, so a host with a
 * line break in it would let whoever saves the settings write a log line of
 * their own. The schema refuses it before the service sees it.
 */

function build() {
  const updateSmtp = vi.fn(async () => ({}));
  const updateBoardMailbox = vi.fn(async () => ({}));
  const controller = new SettingsWriteController({
    updateSmtp,
    updateBoardMailbox,
  } as unknown as SettingsService);
  return { controller, updateSmtp, updateBoardMailbox };
}

/** The status the API answers a failed call with. */
async function statusOf(call: Promise<unknown>): Promise<number> {
  const error: unknown = await call.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  let status = 0;
  const reply = {
    status: (value: number) => {
      status = value;
      return reply;
    },
    send: () => reply,
  };
  new DomainExceptionFilter().catch(
    error as Parameters<DomainExceptionFilter["catch"]>[0],
    {
      switchToHttp: () => ({ getResponse: () => reply }),
    } as unknown as ArgumentsHost,
  );
  return status;
}

const SMTP = {
  host: "smtp.example.se",
  port: 587,
  secure: false,
  user: "styrelsen",
  fromAddress: "styrelsen@exempel.se",
};

const BOARD_MAILBOX = {
  address: "styrelsen@exempel.se",
  host: "pop.example.se",
  port: 995,
  secure: true,
  user: "styrelsen",
};

const FORGED = [
  ["a line feed", "smtp.example.se\nUpdated SMTP settings: host=evil"],
  ["a carriage return", "smtp.example.se\rUpdated SMTP settings: host=evil"],
  ["a NUL", "smtp.example.se\u0000"],
  ["a tab", "smtp.example.se\t"],
  ["a DEL", "smtp.example.se\u007f"],
  ["a next line (C1)", "smtp.example.se\u0085Updated SMTP settings"],
  ["a C1 control", "smtp.example.se\u009b"],
  ["a line separator", "smtp.example.se\u2028Updated SMTP settings"],
  ["a paragraph separator", "smtp.example.se\u2029Updated SMTP settings"],
];

describe("the SMTP host", () => {
  it.each(FORGED)("is refused with 400 when it holds %s", async (_, host) => {
    const { controller, updateSmtp } = build();

    expect(await statusOf(controller.updateSmtp({ ...SMTP, host }))).toBe(400);
    expect(updateSmtp).not.toHaveBeenCalled();
  });

  it.each([
    "smtp.example.se",
    "192.0.2.10",
    "::1",
    "[::1]",
    "smtp.exempel.se.",
    "smtp.exämpel.se",
    "smtp.xn--exmpel-cua.se",
  ])("is accepted as a host name or address (%s)", async (host) => {
    const { controller, updateSmtp } = build();

    await controller.updateSmtp({ ...SMTP, host });

    expect(updateSmtp).toHaveBeenCalledWith(expect.objectContaining({ host }));
  });
});

describe("the board mailbox host", () => {
  it.each(FORGED)("is refused with 400 when it holds %s", async (_, host) => {
    const { controller, updateBoardMailbox } = build();

    expect(
      await statusOf(controller.updateBoardMailbox({ ...BOARD_MAILBOX, host })),
    ).toBe(400);
    expect(updateBoardMailbox).not.toHaveBeenCalled();
  });
});
