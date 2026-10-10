import { describe, expect, it } from "vitest";

import {
  type BoardMailboxColumns,
  boardMailboxConfigured,
  mailboxFingerprint,
} from "./board-mailbox-settings";

const CONFIGURED: BoardMailboxColumns = {
  boardMailboxAddress: "styrelsen@granngarden.test",
  boardMailboxPop3Host: "pop.example.test",
  boardMailboxPop3User: "styrelsen",
  boardMailboxPop3PasswordCipher: "cipher",
};

describe("boardMailboxConfigured", () => {
  it("calls a mailbox configured once the address, the host, the user and the password are all present", () => {
    expect(boardMailboxConfigured(CONFIGURED)).toBe(true);
  });

  it.each(Object.keys(CONFIGURED) as (keyof BoardMailboxColumns)[])(
    "calls it not configured without %s",
    (column) => {
      /*
       * Half a configuration is none at all. The collector would answer it with
       * a protocol error the board cannot read, the settings screen would call
       * it set up, and the record of processing activities would name a mailbox
       * nothing collects from - three readers, which is why they share one test.
       */
      expect(boardMailboxConfigured({ ...CONFIGURED, [column]: null })).toBe(
        false,
      );
    },
  );
});

describe("mailboxFingerprint", () => {
  const MAILBOX = {
    host: "pop.example.test",
    port: 995,
    secure: true,
    user: "styrelsen",
    password: "secret",
  };

  it("is the same mailbox however its host and user are capitalised or spaced", () => {
    // A mail server reads them that way. A fingerprint that changed with a
    // corrected capital would make every letter in the mailbox look new.
    expect(
      mailboxFingerprint({
        ...MAILBOX,
        host: " Pop.Example.TEST ",
        user: "Styrelsen ",
      }),
    ).toBe(mailboxFingerprint(MAILBOX));
  });

  it("tells two mailboxes apart", () => {
    expect(mailboxFingerprint({ ...MAILBOX, user: "kassor" })).not.toBe(
      mailboxFingerprint(MAILBOX),
    );
    // Nor does the password, the port or TLS decide which mailbox it is.
    expect(
      mailboxFingerprint({ ...MAILBOX, password: "other", port: 110 }),
    ).toBe(mailboxFingerprint(MAILBOX));
  });
});
