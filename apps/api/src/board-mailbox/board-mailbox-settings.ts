import { createHash } from "node:crypto";

import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { defaultPop3Port, type Pop3Credentials } from "./pop3";

/**
 * Reading the mailbox the board has configured.
 *
 * Its own file rather than a method on either service, because both halves of
 * the module need it and neither owns it: the collector needs the credentials to
 * open a session, and the reply path needs the address to put in Reply-To so
 * that an answer to the board's answer comes back to the board rather than to
 * the mail server this instance happens to relay through.
 */

/** What the board configured, with the password already decrypted. */
export interface BoardMailboxSettings {
  /** The address the board publishes as its own. */
  address: string;
  credentials: Pop3Credentials;
}

/**
 * The configured mailbox, or null when it is not configured.
 *
 * Configured means every part is present, which is deliberately stricter than
 * the SMTP settings' own test: a mail server with no user name is a real
 * configuration for an outbound relay on a private network, while a mailbox
 * nobody signs in to is not a mailbox. Half a configuration is answered as none
 * at all rather than as a connection that will fail with a protocol error the
 * board cannot read.
 */
export async function loadBoardMailboxSettings(
  prisma: PrismaService,
  encryption: FieldEncryptionService,
): Promise<BoardMailboxSettings | null> {
  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: {
      boardMailboxAddress: true,
      boardMailboxPop3Host: true,
      boardMailboxPop3Port: true,
      boardMailboxPop3Secure: true,
      boardMailboxPop3User: true,
      boardMailboxPop3PasswordCipher: true,
    },
  });

  if (
    association === null ||
    association.boardMailboxAddress === null ||
    association.boardMailboxPop3Host === null ||
    association.boardMailboxPop3User === null ||
    association.boardMailboxPop3PasswordCipher === null
  ) {
    return null;
  }

  return {
    address: association.boardMailboxAddress,
    credentials: {
      host: association.boardMailboxPop3Host,
      port:
        association.boardMailboxPop3Port ??
        defaultPop3Port(association.boardMailboxPop3Secure),
      secure: association.boardMailboxPop3Secure,
      user: association.boardMailboxPop3User,
      password: await encryption.decrypt(
        "association.boardMailboxPop3Password",
        association.boardMailboxPop3PasswordCipher,
      ),
    },
  };
}

/**
 * A short, stable fingerprint of which mailbox a message was collected from.
 *
 * Prefixed to every stored POP3 identifier, because a unique identifier is
 * unique within one mailbox and says nothing between two. Without it, an
 * association that moved its board address to a new provider could have a real
 * letter silently discarded as already held, because the new mailbox happened to
 * number it the way the old one numbered something else - a failure with no
 * symptom at all, which is the kind worth a few bytes to prevent.
 *
 * A hash rather than the host and user themselves, and truncated: the value
 * lands in a column the board never reads, and there is no reason for the
 * mailbox's own address to be one more place a credential's user name is
 * written down. Sixteen hex characters is far more than enough to tell two
 * mailboxes apart, which is the only question this is ever asked.
 */
export function mailboxFingerprint(credentials: Pop3Credentials): string {
  return (
    createHash("sha256")
      // Concatenated with an escaped separator rather than interpolated. The
      // separator is a character that occurs in no host name and no mailbox
      // user name, so two different mailboxes cannot produce one input by
      // splitting it differently - and writing it as an escape rather than as
      // itself keeps a control character out of the source, where it is
      // invisible to a reader and unreadable to some parsers.
      .update(credentials.host + "\u0000" + credentials.user)
      .digest("hex")
      .slice(0, 16)
  );
}
