import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  type PluginDisclosure,
  type PluginRecipient,
  PluginRecipientError,
  type PluginRecipientErrorCode,
  type PluginRecipientRequest,
  type PluginRecipientResponse,
} from "@openbrf/plugin-sdk";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import {
  type ResolveAddresses,
  type ResolvedAddress,
  resolveAddresses,
  resolvePublicAddresses,
} from "../network/outbound-address";
import {
  type PinnedRequester,
  type PinnedResponse,
  pinnedRequester,
  ResponseTooLargeError,
} from "../network/pinned-request";
import { untilAborted } from "../network/until-aborted";

/**
 * A plugin's way out to the recipients its manifest declares (ADR 0037).
 *
 * `host.recipients.fetch` ends here. It reaches the declared origin of the
 * recipient named and nothing else: the path is resolved against that origin
 * and refused if it leaves it, the host is judged by the instance's outbound
 * address rules and the connection pinned to the addresses judged, and a
 * redirect is followed only while it stays on the origin.
 *
 * A request whose body carries personal data says so, and is the broker
 * package's disclosure (its G6): the categories are checked against the
 * recipient's declaration and the persons against what the host would hand
 * the plugin, both before anything is written or sent. Then one audit entry
 * per person, with the recipient, the categories and the body's digest, is
 * committed before the request leaves, and one with the outcome after it
 * settles. The log is append-only, so the outcome is a second entry rather
 * than a change to the first, and both reach the person's access report.
 *
 * Not a fence. A plugin runs at full process privilege (ADR 0003) and can
 * open a socket of its own; what this gives is a path that is checked and
 * recorded, and the catalog's reading of a listed plugin's bundle is what
 * holds the plugin to it.
 */

/** What the service reaches the network through, replaced in a suite. */
export interface RecipientNetwork {
  resolve: ResolveAddresses;
  send: PinnedRequester;
}

export const RECIPIENT_NETWORK = Symbol("OPENBRF_RECIPIENT_NETWORK");

export const recipientNetwork: RecipientNetwork = {
  resolve: resolveAddresses,
  send: pinnedRequester(),
};

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Long enough for a language model answering without streaming. */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_SUBJECTS = 100;
const MAX_REDIRECTS = 5;
const MAX_PATH_LENGTH = 2048;
const MAX_HEADERS = 50;

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Headers the host writes or that describe the connection rather than the
 * request. A plugin setting `host` would name another site to a shared front
 * end, and one setting the length or the framing could make the body it
 * declared differ from the body that was digested.
 */
const REFUSED_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "proxy-authorization",
  "proxy-connection",
]);

/** An RFC 9110 field name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A field value: no line break and no NUL, which would split the request. */
const HEADER_VALUE = /^[^\r\n\0]*$/;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** A request read and checked, ready to be recorded and sent. */
interface CheckedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  timeoutMs: number;
}

interface CheckedDisclosure {
  personalData: string[];
  /** Empty for a disclosure that names nobody. */
  subjects: string[];
  digest: string;
  disclosureId: string;
}

/** How a recorded disclosure settled, for its second entry. */
type Outcome =
  | { outcome: "answered"; status: number }
  | { outcome: "failed"; code: PluginRecipientErrorCode };

@Injectable()
export class PluginRecipientsService {
  private readonly logger = new Logger(PluginRecipientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(ENV) private readonly env: Env,
    @Inject(RECIPIENT_NETWORK) private readonly network: RecipientNetwork,
  ) {}

  async fetch(
    pluginId: string,
    declared: readonly PluginRecipient[],
    id: string,
    path: string,
    init: PluginRecipientRequest | undefined,
  ): Promise<PluginRecipientResponse> {
    const refuse = (code: PluginRecipientErrorCode): PluginRecipientError =>
      new PluginRecipientError(pluginId, String(id), code);

    const recipient = declared.find((candidate) => candidate.id === id);
    if (recipient === undefined) {
      throw refuse("recipient-not-declared");
    }

    const request = checkedRequest(recipient.origin, path, init ?? {}, refuse);
    const disclosure =
      init?.disclosure === undefined
        ? null
        : await this.checkedDisclosure(
            recipient,
            init.disclosure,
            request.body,
            refuse,
          );

    // One deadline for the whole exchange, started before the name is
    // resolved: a lookup that never answers holds the plugin as surely as a
    // recipient that never does.
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);

    try {
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await untilAborted(
          resolvePublicAddresses(request.url.hostname, {
            allowPrivate: this.env.OPENBRF_ALLOW_PRIVATE_HOSTS,
            resolve: this.network.resolve,
          }),
          controller.signal,
        );
      } catch {
        // Which of the two the address check found stays in this process:
        // told apart, they would map the network behind the instance.
        throw refuse(
          controller.signal.aborted ? "unreachable" : "address-refused",
        );
      }

      if (disclosure !== null) {
        await this.recordStarted(pluginId, recipient, disclosure);
      }

      let response: PinnedResponse;
      try {
        response = await this.exchange(
          recipient.origin,
          request,
          addresses,
          controller.signal,
          refuse,
        );
      } catch (cause) {
        const failure =
          cause instanceof PluginRecipientError ? cause : refuse("unreachable");
        if (disclosure !== null) {
          await this.recordFinished(pluginId, recipient, disclosure, {
            outcome: "failed",
            code: failure.code,
          });
        }
        throw failure;
      }

      if (disclosure !== null) {
        await this.recordFinished(pluginId, recipient, disclosure, {
          outcome: "answered",
          status: response.status,
        });
      }
      return recipientResponse(response);
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * Sends the request, and follows a redirect while it stays on the origin.
   *
   * A redirect to anywhere else is refused rather than handed back: the
   * recipient is the party the board consented to, and one that points
   * somewhere else is asking the host to deliver there. Followed as a
   * browser follows it - a 303, or a 301 or 302 answering a POST, becomes a
   * GET without the body - so a recipient written for browsers behaves here
   * as it does there.
   */
  private async exchange(
    origin: string,
    request: CheckedRequest,
    addresses: readonly ResolvedAddress[],
    signal: AbortSignal,
    refuse: (code: PluginRecipientErrorCode) => PluginRecipientError,
  ): Promise<PinnedResponse> {
    let { url, method, headers, body } = request;

    for (let hop = 0; ; hop += 1) {
      let response: PinnedResponse;
      try {
        response = await this.network.send({
          url,
          method,
          headers,
          body,
          addresses,
          signal,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        });
      } catch (cause) {
        throw refuse(
          cause instanceof ResponseTooLargeError
            ? "response-too-large"
            : "unreachable",
        );
      }

      const location = response.headers.location;
      if (!REDIRECT_STATUSES.has(response.status) || location === undefined) {
        return response;
      }
      if (hop === MAX_REDIRECTS) {
        throw refuse("redirect-refused");
      }

      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw refuse("redirect-refused");
      }
      if (
        next.origin !== origin ||
        next.username !== "" ||
        next.password !== ""
      ) {
        throw refuse("redirect-refused");
      }

      if (
        (response.status === 303 && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        method = "GET";
        body = null;
        headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([name]) => !name.toLowerCase().startsWith("content-"),
          ),
        );
      }
      url = next;
    }
  }

  private async checkedDisclosure(
    recipient: PluginRecipient,
    given: PluginDisclosure,
    body: Buffer | null,
    refuse: (code: PluginRecipientErrorCode) => PluginRecipientError,
  ): Promise<CheckedDisclosure> {
    const read: unknown = given;
    if (typeof read !== "object" || read === null) {
      throw refuse("request-refused");
    }
    const categories: unknown = (read as { personalData?: unknown })
      .personalData;
    const subjects: unknown = (read as { subjects?: unknown }).subjects;

    if (
      !Array.isArray(categories) ||
      categories.length === 0 ||
      !Array.isArray(subjects)
    ) {
      throw refuse("request-refused");
    }

    /*
     * The recipient's declaration and nothing wider. A recipient declared as
     * receiving no personal data receives none through here, which is what
     * the board was shown.
     */
    const receives = new Set<string>(recipient.personalData);
    if (
      !categories.every(
        (category): category is string =>
          typeof category === "string" && receives.has(category),
      )
    ) {
      throw refuse("personal-data-not-declared");
    }

    if (
      subjects.length > MAX_SUBJECTS ||
      !subjects.every(
        (subject): subject is string =>
          typeof subject === "string" &&
          subject.length > 0 &&
          subject.length <= 64,
      )
    ) {
      throw refuse("subject-refused");
    }
    const unique = [...new Set(subjects)];

    /*
     * A person the host would not hand the plugin is not one it may send data
     * about either: protected personal data, and a restriction of processing
     * (art. 18), which leaves storage and nothing else. One answer for those
     * and for an id the register does not hold, so a plugin cannot learn
     * which of its ids belongs to a protected person by sending a request.
     */
    if (unique.length > 0) {
      const found = await this.prisma.person.count({
        where: {
          id: { in: unique },
          protectedPersonalData: false,
          processingRestrictedAt: null,
        },
      });
      if (found !== unique.length) {
        throw refuse("subject-refused");
      }
    }

    return {
      personalData: [...new Set(categories)].sort(),
      subjects: unique,
      digest: `sha256:${createHash("sha256")
        .update(body ?? Buffer.alloc(0))
        .digest("hex")}`,
      disclosureId: randomUUID(),
    };
  }

  /**
   * One entry per person, committed before the request leaves.
   *
   * Together or not at all, and if it cannot be written nothing is sent: a
   * disclosure the log does not hold is the one thing this must not allow.
   * The entry names the recipient by its id and origin, which are facts
   * about the plugin, and the body by its digest, which lets a copy the
   * recipient holds be matched without the log holding the copy.
   */
  private async recordStarted(
    pluginId: string,
    recipient: PluginRecipient,
    disclosure: CheckedDisclosure,
  ): Promise<void> {
    await this.writeEntries("PLUGIN_DISCLOSURE_STARTED", pluginId, disclosure, {
      disclosureId: disclosure.disclosureId,
      recipient: recipient.id,
      origin: recipient.origin,
      personalData: disclosure.personalData,
      digest: disclosure.digest,
    });
  }

  /**
   * One entry per person, with how the request settled.
   *
   * "answered" with the status whatever it was, because a 4xx is still the
   * recipient having received the body; "failed" with the code when no
   * answer came. A failure to write this one is logged and does not change
   * what the plugin is told: the request has gone, the entry before it says
   * so, and an error here would invite a retry that sends it twice.
   */
  private async recordFinished(
    pluginId: string,
    recipient: PluginRecipient,
    disclosure: CheckedDisclosure,
    outcome: Outcome,
  ): Promise<void> {
    try {
      await this.writeEntries(
        "PLUGIN_DISCLOSURE_FINISHED",
        pluginId,
        disclosure,
        {
          disclosureId: disclosure.disclosureId,
          recipient: recipient.id,
          ...outcome,
        },
      );
    } catch (cause) {
      this.logger.error(
        `The outcome of disclosure ${disclosure.disclosureId} by plugin "${pluginId}" could not be recorded.`,
        cause instanceof Error ? cause.stack : undefined,
      );
    }
  }

  private async writeEntries(
    action: "PLUGIN_DISCLOSURE_STARTED" | "PLUGIN_DISCLOSURE_FINISHED",
    pluginId: string,
    disclosure: CheckedDisclosure,
    context: Record<string, unknown>,
  ): Promise<void> {
    const targets =
      disclosure.subjects.length === 0 ? [null] : disclosure.subjects;
    await this.prisma.$transaction(async (tx) => {
      for (const targetPersonId of targets) {
        await this.audit.record(
          {
            action,
            channel: "PLUGIN",
            actorPersonId: null,
            targetPersonId,
            targetKind: "plugin",
            targetId: pluginId,
            context,
          },
          tx,
        );
      }
    });
  }
}

/**
 * The plugin's request, read as untrusted input and checked whole before
 * anything is recorded or sent.
 *
 * Read with `typeof` rather than trusted to the types: the plugin is
 * JavaScript, and a value of the wrong kind here would otherwise surface as
 * a failure inside the connection, after the disclosure was recorded.
 */
function checkedRequest(
  origin: string,
  path: unknown,
  init: PluginRecipientRequest,
  refuse: (code: PluginRecipientErrorCode) => PluginRecipientError,
): CheckedRequest {
  /*
   * A path on the origin, resolved and compared rather than concatenated. A
   * second leading slash makes the rest a host, and a backslash is a slash
   * to the URL parser, so `//elsewhere.example` and `/\elsewhere.example`
   * would both leave the origin; comparing the resolved origin catches every
   * spelling of that at once.
   */
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.length > MAX_PATH_LENGTH
  ) {
    throw refuse("path-refused");
  }
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    throw refuse("path-refused");
  }
  if (url.origin !== origin || url.username !== "" || url.password !== "") {
    throw refuse("path-refused");
  }

  const method: unknown = init.method ?? "GET";
  if (typeof method !== "string" || !METHODS.has(method)) {
    throw refuse("request-refused");
  }

  const headers: Record<string, string> = {};
  const given: unknown = init.headers ?? {};
  if (typeof given !== "object" || given === null) {
    throw refuse("request-refused");
  }
  const entries = Object.entries(given);
  if (entries.length > MAX_HEADERS) {
    throw refuse("request-refused");
  }
  for (const [name, value] of entries) {
    if (
      !HEADER_NAME.test(name) ||
      REFUSED_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase().startsWith("proxy-") ||
      typeof value !== "string" ||
      !HEADER_VALUE.test(value)
    ) {
      throw refuse("request-refused");
    }
    headers[name] = value;
  }

  const rawBody: unknown = init.body;
  let body: Buffer | null;
  if (rawBody === undefined) {
    body = null;
  } else if (typeof rawBody === "string") {
    body = Buffer.from(rawBody, "utf8");
  } else if (rawBody instanceof Uint8Array) {
    // A copy, so a plugin changing its array after the call cannot make the
    // bytes sent differ from the bytes digested.
    body = Buffer.from(rawBody);
  } else {
    throw refuse("request-refused");
  }
  if (
    body !== null &&
    (body.byteLength > MAX_BODY_BYTES || method === "GET" || method === "HEAD")
  ) {
    throw refuse("request-refused");
  }

  const timeoutMs: unknown = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw refuse("request-refused");
  }

  return { url, method, headers, body, timeoutMs };
}

function recipientResponse(response: PinnedResponse): PluginRecipientResponse {
  const body = new Uint8Array(response.body);
  return {
    status: response.status,
    headers: response.headers,
    body,
    text: () => response.body.toString("utf8"),
    json: (): unknown => JSON.parse(response.body.toString("utf8")),
  };
}
