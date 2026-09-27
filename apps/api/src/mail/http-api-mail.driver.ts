import { randomUUID } from "node:crypto";

import type { MailDriver, OutgoingMail, SentMail } from "./mail-driver";

/**
 * Sending through an HTTP mail API set where the instance runs (ADR 0024).
 *
 * Written against a shape rather than a vendor. What a transactional mail
 * service takes in practice is a JSON document with a sender, recipients, a
 * subject and two bodies, posted with a bearer key, and what it answers is the
 * id it gave the message. That is what this speaks; a driver written directly
 * against one vendor's API is a sibling file and a branch in the selection, not
 * a change to this one.
 *
 *   POST <OPENBRF_MAIL_API_URL>/emails
 *   Authorization: Bearer <OPENBRF_MAIL_API_KEY>
 *   Content-Type: application/json
 *   Idempotency-Key: <the caller's message identifier, or a random UUID>
 *
 *   {"from": "\"<display name>\" <address>", "to": ["..."], "subject": "...",
 *    "html": "...", "text": "...", "reply_to": ["..."],
 *    "headers": {"In-Reply-To": "<...>", "References": "<...>"}}
 *
 *   2xx {"id": "<id>"}  ->  delivered as Message-ID <id@OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN>
 *
 * The display name is a quoted string with `"` and `\` escaped. A line break
 * reaches neither it nor the subject, because the configuration refuses one in
 * the configured name and the mail service replaces one in the association's
 * name and in every subject (header-text.ts): a service may write both into the
 * header as it is given. `reply_to` and each header are sent only when set.
 *
 * A Message-ID is never sent. A service of this shape owns that header, refuses
 * it from the caller and writes its own from the id it answers with, so the
 * driver reports the identifier the service wrote. That is the one a reply
 * names, and the board mailbox threads by it.
 *
 * The idempotency key is the caller's identifier where there is one, so a
 * retried board mailbox answer is sent once for as long as the service
 * remembers the key. Any 2xx means the service accepted the message; one with no
 * id reports no identifier. Every other answer is a failure carrying its status
 * and never its body, which quotes the recipient back - the SMS gateway's rule.
 */

/**
 * How long one request may take, answer included.
 *
 * The SMTP socket's bound, for the reason the SMTP driver states one: every
 * send is awaited by whatever triggered it, and a service that stops answering
 * must become a failure somebody can act on rather than a request held open.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The characters a Message-ID's left-hand side may hold (RFC 5322 dot-atom
 * text). An id outside it cannot be the identifier the service wrote, so it is
 * reported as none rather than stored as one.
 */
const MESSAGE_ID_LOCAL_PART =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

export interface MailApiConfig {
  /** The base address, validated at boot; the driver posts to `<this>/emails`. */
  url: string;
  /** The bearer key. */
  key: string;
  /** Where the service writes its own Message-ID, `<id>@<this>`. */
  messageIdDomain: string;
  requestTimeoutMs?: number;
}

/** The mail API refused the message, or never answered. */
export class MailApiError extends Error {
  /** A code a log line can carry, which names nothing but the status. */
  readonly code: string;

  constructor(
    message: string,
    /** The HTTP status, or null when there was no answer. */
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MailApiError";
    this.code = status === null ? "NO_ANSWER" : `HTTP_${String(status)}`;
  }
}

export class HttpApiMailDriver implements MailDriver {
  readonly kind = "http-api" as const;

  constructor(private readonly config: MailApiConfig) {}

  async send(mail: OutgoingMail): Promise<SentMail> {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.key}`,
          "content-type": "application/json",
          "idempotency-key": mail.messageId ?? randomUUID(),
        },
        body: JSON.stringify(payloadOf(mail)),
        // One address the operator configured. A redirect would carry the key
        // and the recipient to wherever the answer pointed.
        redirect: "manual",
        signal: controller.signal,
      });

      if (!response.ok) {
        // Discarded unread: a refusal quotes the recipient back.
        await response.body?.cancel();
        throw new MailApiError(
          `The mail API refused the message (HTTP ${String(response.status)}).`,
          response.status,
        );
      }

      /*
       * Accepted from here on, whatever the body does. A body that stalls or
       * breaks off reports no identifier rather than a failure: the service has
       * taken the message, and calling that a refusal would record an answer
       * as unsent that is on its way.
       */
      let body: string;
      try {
        body = await response.text();
      } catch {
        return { messageId: null };
      }
      return { messageId: this.deliveredId(body) };
    } catch (cause) {
      if (cause instanceof MailApiError) {
        throw cause;
      }
      throw new MailApiError(
        controller.signal.aborted
          ? "The mail API did not answer in time."
          : "The mail API could not be reached.",
        null,
        { cause },
      );
    } finally {
      clearTimeout(deadline);
    }
  }

  close(): void {
    // Nothing held open: every send is one request.
  }

  /** `<base>/emails`, with the base's own path kept. */
  private endpoint(): URL {
    const url = new URL(this.config.url);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/emails`;
    return url;
  }

  /** The identifier the service wrote, from the id it answered with. */
  private deliveredId(body: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const id =
      typeof parsed === "object" && parsed !== null && "id" in parsed
        ? parsed.id
        : undefined;
    if (typeof id !== "string" || !MESSAGE_ID_LOCAL_PART.test(id)) {
      return null;
    }
    return `${id}@${this.config.messageIdDomain}`;
  }
}

/** The JSON document the contract above describes. */
function payloadOf(mail: OutgoingMail): Record<string, unknown> {
  const headers: Record<string, string> = {};
  if (mail.inReplyTo !== null) {
    // Both, from the one value, as the SMTP driver writes them.
    headers["In-Reply-To"] = `<${mail.inReplyTo}>`;
    headers.References = `<${mail.inReplyTo}>`;
  }

  return {
    from: senderOf(mail.from),
    to: [mail.to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    ...(mail.replyTo === null ? {} : { reply_to: [mail.replyTo] }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

/**
 * The sender as a mailbox: a bare address, or a quoted display name before it.
 *
 * Quoted rather than written as it stands, because a name holding a comma, a
 * full stop or brackets is several tokens to a parser otherwise. Inside the
 * quotes only `"` and `\` need escaping (RFC 5322 3.2.4); a letter outside
 * ASCII is left for the service to encode.
 */
function senderOf(from: OutgoingMail["from"]): string {
  if (from.name === null) {
    return from.address;
  }
  const quoted = from.name.replace(/["\\]/g, (character) => `\\${character}`);
  return `"${quoted}" <${from.address}>`;
}
