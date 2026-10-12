import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  pinnedLookup,
  type ResolveAddresses,
  type ResolvedAddress,
  resolvePublicAddresses,
} from "../network/outbound-address";
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
  /**
   * Whether the gateway may be on a private network. Off, a gateway whose host
   * is or resolves to a loopback, private or link-local address is refused
   * before anything is sent (OPENBRF_ALLOW_PRIVATE_HOSTS).
   */
  allowPrivateHosts: boolean;
  /** The resolver, for a suite that cannot depend on somebody's DNS zone. */
  resolve?: ResolveAddresses;
}

export class HttpGatewaySmsDriver implements SmsDriver {
  readonly kind = "http-gateway" as const;

  constructor(private readonly config: HttpGatewayConfig) {}

  async send(message: SmsMessage): Promise<void> {
    const status = await this.post(message);

    if (status < 200 || status > 299) {
      throw new SmsError(
        `The SMS gateway refused the message (HTTP ${String(status)}).`,
        this.kind,
      );
    }
  }

  /**
   * Posts the message and answers with the status the gateway gave.
   *
   * `node:http` rather than the global fetch, and the difference is the address
   * check. The host is resolved and judged here, and the connection is opened
   * to the address that was judged: the global fetch resolves again inside
   * itself, and a name whose records changed in between would take the message
   * - and the bearer credential - to an address nothing here ever saw.
   *
   * Its own connection, never one from the shared pool. A pooled socket was
   * opened by whoever asked for it first, to wherever their lookup said.
   */
  private async post(message: SmsMessage): Promise<number> {
    const endpoint = this.endpointUrl();
    const addresses = await this.checkedAddresses(endpoint);
    const body = JSON.stringify({
      to: message.to,
      message: message.body,
      // Left out entirely rather than sent as null: a gateway that reads an
      // absent sender as "use the account default" would otherwise be told to
      // use no sender at all.
      ...(message.sender === undefined ? {} : { from: message.sender }),
    });

    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    try {
      return await new Promise<number>((resolve, reject) => {
        const request = (
          endpoint.protocol === "https:" ? httpsRequest : httpRequest
        )(
          endpoint,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              ...(this.config.token === undefined
                ? {}
                : { authorization: `Bearer ${this.config.token}` }),
            },
            agent: false,
            lookup: pinnedLookup(addresses),
            signal: controller.signal,
          },
          (response) => {
            /*
             * The body is never read, whatever the answer was.
             *
             * A gateway replies with an accepted-message document this driver
             * has no use for, and on the failure path the body is the one part
             * of the exchange that quotes the number back. The status is all
             * that is kept, and the connection, which is this request's own,
             * goes with the rest. Redirects are not followed either: the
             * gateway is one endpoint an administrator typed, and a redirect
             * would carry the bearer credential to wherever it pointed.
             */
            response.destroy();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end(body);
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
   * The gateway's addresses, or a refusal when the host is not one this
   * instance may connect to.
   *
   * Checked at the send as well as when the settings were saved, because the
   * row outlives the check that wrote it, and a name does not keep resolving
   * where it did on the day it was saved.
   */
  private async checkedAddresses(
    endpoint: URL,
  ): Promise<readonly ResolvedAddress[]> {
    try {
      return await resolvePublicAddresses(endpoint.hostname, {
        allowPrivate: this.config.allowPrivateHosts,
        ...(this.config.resolve === undefined
          ? {}
          : { resolve: this.config.resolve }),
      });
    } catch (cause) {
      // What an unreachable gateway says: which of the two the address check
      // found is a fact about the network behind this instance.
      throw new SmsError("The SMS gateway could not be reached.", this.kind, {
        cause,
      });
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

    // A credential in the address would be sent as basic authentication to
    // whatever answers, beside the bearer one this driver means to send.
    if (url.username !== "" || url.password !== "") {
      throw new SmsError(
        "The SMS gateway address must not carry a user name or password.",
        this.kind,
      );
    }
    return url;
  }
}
