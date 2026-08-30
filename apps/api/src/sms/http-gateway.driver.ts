import { SmsError, type SmsDriver, type SmsMessage } from "./sms.driver";

/**
 * Sending through an HTTP gateway the association points at.
 *
 * The concrete driver, and deliberately not a named vendor's. Choosing one
 * would mean choosing an account, a price per message and a country's operator
 * rules on behalf of every cooperative that runs this, and it would put a
 * provider's SDK in the dependency tree of an application that holds a
 * statutory register. What every SMS route in practice has in common is an
 * HTTP endpoint that takes a number and a body, so that is what this speaks.
 *
 * The wire contract below is this project's own, published so anything can
 * implement it: a self-hosted gateway, a modem daemon on the association's own
 * hardware, or a few lines in front of whichever commercial provider a board
 * signs up with. A driver written directly against a vendor's API is a sibling
 * file and a branch in the selection, not a change to this one.
 *
 *   POST <endpoint>
 *   Content-Type: application/json
 *   Authorization: Bearer <token>        (only when a token is configured)
 *
 *   {"to": "+46701234567", "message": "...", "from": "BRF Ekhagen"}
 *
 * Any 2xx means the gateway has taken responsibility for the message. Every
 * other answer is a failure recorded against that one recipient.
 *
 * What the gateway says when it refuses is never repeated. A rejection quotes
 * the envelope back, and the envelope is a member's phone number - the same
 * reason a mail server's refusal is logged by its class and not its words.
 */

/** Long enough for a gateway that queues, short enough not to stall a mailing. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** What an association may point this at. Nothing else is dialled. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:"]);

export interface HttpGatewayConfig {
  /** Where to POST. Configured by an administrator, never by a member. */
  endpoint: string;
  /** Bearer credential, decrypted by the caller. Omitted when the gateway needs none. */
  token?: string;
  requestTimeoutMs?: number;
}

export class HttpGatewaySmsDriver implements SmsDriver {
  readonly kind = "http-gateway" as const;

  constructor(private readonly config: HttpGatewayConfig) {}

  async send(message: SmsMessage): Promise<void> {
    const response = await this.post(message);

    /*
     * The body is drained whatever the answer was.
     *
     * A gateway replies with an accepted-message document this driver has no
     * use for, and an undrained body holds its socket open. On the failure path
     * it is discarded unread on purpose: it is the one part of the exchange
     * that quotes the number back.
     */
    await response.body?.cancel();

    if (!response.ok) {
      throw new SmsError(
        `The SMS gateway refused the message (HTTP ${String(response.status)}).`,
        this.kind,
      );
    }
  }

  private async post(message: SmsMessage): Promise<Response> {
    const endpoint = this.endpointUrl();
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    try {
      return await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.token === undefined
            ? {}
            : { authorization: `Bearer ${this.config.token}` }),
        },
        body: JSON.stringify({
          to: message.to,
          message: message.body,
          // Left out entirely rather than sent as null: a gateway that reads an
          // absent sender as "use the account default" would otherwise be told
          // to use no sender at all.
          ...(message.sender === undefined ? {} : { from: message.sender }),
        }),
        // The gateway is one endpoint an administrator typed. A redirect would
        // carry the bearer credential to wherever the answer pointed.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (cause) {
      throw new SmsError(
        controller.signal.aborted
          ? "The SMS gateway did not answer in time."
          : "The SMS gateway could not be reached.",
        this.kind,
        { cause },
      );
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * The configured endpoint, or a refusal.
   *
   * Checked at the send rather than trusted from the settings row, because the
   * row outlives the validation that wrote it: a restore from backup, or a
   * value written before this check existed, would otherwise let the process
   * holding the member register dial a scheme nobody meant it to.
   */
  private endpointUrl(): URL {
    let url: URL;
    try {
      url = new URL(this.config.endpoint);
    } catch (cause) {
      throw new SmsError("The SMS gateway address is not a URL.", this.kind, {
        cause,
      });
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw new SmsError(
        "The SMS gateway address must be an http or https URL.",
        this.kind,
      );
    }
    return url;
  }
}
