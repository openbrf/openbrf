/**
 * Where a message goes once it is rendered.
 *
 * One interface, so nothing above it learns which transport an instance uses:
 * an SMTP server, which is what a board enters in the settings and what a
 * self-hoster usually runs, or an HTTP mail API that takes the message as JSON
 * with a key, which is what a host may offer before it offers SMTP (ADR 0024).
 *
 * What crosses it is named field by field - a sender, one recipient, the two
 * bodies, a Reply-To and the two threading identifiers - and never an arbitrary
 * header bag, for the reason `SendMailInput` gives: the one caller that threads
 * composes its identifiers from a message somebody outside the association
 * wrote.
 */

import type { Env } from "../config/env";

/**
 * Which transport a driver speaks. Named in logs, never in a response.
 *
 * The drivers the environment can name, so a new one is added in one place.
 */
export type MailDriverKind = Exclude<Env["OPENBRF_MAIL_DRIVER"], "settings">;

/** One rendered message, ready to hand over. */
export interface OutgoingMail {
  /**
   * The sender. The name is the display name, or null for a bare address; the
   * driver encodes it, so it is passed as text and never as a header.
   */
  from: { name: string | null; address: string };
  to: string;
  subject: string;
  html: string;
  /** The plain-text alternative every message carries. */
  text: string;
  replyTo: string | null;
  /**
   * The identifier the caller gave this message, without angle brackets, or
   * null to leave it to the transport. A transport that writes its own
   * disregards it and reports the one it wrote.
   */
  messageId: string | null;
  /** The identifier of the message this one answers, without angle brackets. */
  inReplyTo: string | null;
}

/** What a transport reports once it has accepted a message. */
export interface SentMail {
  /**
   * The identifier the message was delivered with, without angle brackets: the
   * one it was given, or the one the transport wrote instead. A reply to the
   * message names this one, so a caller that threads replies records it.
   *
   * Null when the transport reported none, or when nothing was handed over.
   */
  messageId: string | null;
}

/**
 * How far a send that failed had got.
 *
 * `not-handed-over`: the transport cannot have taken the message. The failure
 * came before the message was sent to it (no mail configured, a server that
 * could not be reached, a sign-in or an envelope it refused), or the transport
 * answered the message itself with a refusal. Nobody received it.
 *
 * `may-have-been-handed-over`: the transport may hold the message all the same.
 * The connection broke or went quiet while the message was on its way or its
 * answer was, and a mail server that took the message before then delivers it.
 * Sending it again may send it twice.
 *
 * Only the driver knows which, from what its transport reports as a code or a
 * status and never from the wording of an error, so it is stated on the error
 * the driver throws (`MailHandoverFailure`). A driver that cannot tell says the
 * second.
 */
export type MailHandover = "not-handed-over" | "may-have-been-handed-over";

/** A failed send that says how far it had got. */
export interface MailHandoverFailure {
  readonly handover: MailHandover;
}

/**
 * Whether a failed send may have handed its message to the transport.
 *
 * False only for a failure that says it did not. Anything else counts as may
 * have: a driver that could not tell, and a failure that is not the transport's
 * at all, because a sender that records a message as not sent when it went out
 * leads somebody to send it twice.
 */
export function mayHaveBeenHandedOver(error: unknown): boolean {
  return !(
    typeof error === "object" &&
    error !== null &&
    "handover" in error &&
    error.handover === "not-handed-over"
  );
}

export interface MailDriver {
  readonly kind: MailDriverKind;

  /**
   * Hands one message to the transport.
   *
   * Resolves when the transport has accepted it, which is not a claim that it
   * was delivered. Throws for everything else, and never with the far end's own
   * words: a refusal quotes the envelope back, and the envelope is an address.
   * What it throws says how far the send had got (`MailHandover`).
   */
  send(mail: OutgoingMail): Promise<SentMail>;

  /** Releases whatever the driver holds open. */
  close(): void;
}
