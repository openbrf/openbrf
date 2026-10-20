import { validateHeaderName, validateHeaderValue } from "node:http";

import { HttpStatus } from "@nestjs/common";
import {
  ACTION_ERROR_MCP,
  type ActionErrorSpec,
  type ActionRefusal,
  type ActionRefusalKind,
  type ActionRefusalTransport,
  type ActionRetry,
} from "@openbrf/plugin-sdk";
import { ZodError } from "zod";

import { DomainError } from "../http/domain-error";
import { ActionError } from "./action.error";

/**
 * A refused call, in the one shape the plugin contract publishes.
 *
 * The registry refuses in three forms: its own ActionError, the validator's
 * ZodError for a body the input schema refuses, and the service's own domain
 * error passed through from the handler. A plugin can import none of them, so
 * what reaches it through `host.actions.invoke` is this instead, carrying the
 * fields a connector renders from.
 *
 * A DomainError, so that a plugin route rethrowing one passes the plugin error
 * interceptor and is answered by the domain filter with the status, the
 * particulars and the bearer challenge the registry's own refusal would have
 * carried, rather than as the plugin's failure.
 */
export class PluginActionRefusal extends DomainError implements ActionRefusal {
  override readonly name = "ActionRefusal";
  readonly transport: ActionRefusalTransport;
  readonly retry: ActionRetry;
  readonly challenge?: string;

  constructor(
    readonly kind: ActionRefusalKind,
    readonly reason: string,
    readonly status: number,
    rendering: (typeof ACTION_ERROR_MCP)[keyof typeof ACTION_ERROR_MCP],
    message: string,
    private readonly particulars: Record<string, readonly unknown[]>,
    private readonly answer: Record<string, string>,
    cause: unknown,
  ) {
    super(message, { cause });
    this.transport = rendering.transport;
    this.retry = rendering.retry;
    // A header name is case-insensitive, and a plugin's handler may write it
    // as `WWW-Authenticate`.
    const challenge = Object.entries(answer).find(
      ([name]) => name.toLowerCase() === "www-authenticate",
    );
    if (challenge !== undefined) {
      this.challenge = challenge[1];
    }
  }

  override details(): Record<string, readonly unknown[]> {
    return this.particulars;
  }

  override headers(): Record<string, string> {
    return this.answer;
  }
}

/**
 * The refusal a failed invoke amounts to, or null when it was not refused.
 *
 * `declared` is the action's own `errors`, which is where a domain refusal's
 * retry verdict comes from: the service knows a taken address is worth another
 * try with a different one, and the table's one row for every domain refusal
 * cannot. A reason the action did not declare falls back to that row.
 *
 * Null for anything else - the host unreachable, a database fault - which is a
 * failure rather than an answer and travels as it was thrown.
 */
export function actionRefusal(
  cause: unknown,
  declared: readonly ActionErrorSpec[],
): PluginActionRefusal | null {
  // One action invoking another and rethrowing what it got: already the
  // published shape, and it would otherwise pass for a domain error below and
  // lose its kind, transport and retry verdict.
  if (cause instanceof PluginActionRefusal) {
    return cause;
  }
  if (cause instanceof ActionError) {
    return new PluginActionRefusal(
      "registry",
      cause.reason,
      cause.status,
      ACTION_ERROR_MCP[cause.reason],
      cause.message,
      cause.details(),
      cause.headers(),
      cause,
    );
  }
  if (cause instanceof ZodError) {
    return new PluginActionRefusal(
      "invalid-body",
      "invalid-body",
      HttpStatus.BAD_REQUEST,
      ACTION_ERROR_MCP["invalid-body"],
      "The input does not match the action's schema.",
      {
        // What the domain filter answers a malformed body with: the failing
        // paths and the validator's messages, never the submitted values.
        issues: cause.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
      {},
      cause,
    );
  }
  if (isDomainRefusal(cause)) {
    return new PluginActionRefusal(
      "domain",
      cause.reason,
      domainStatus(cause.status),
      {
        ...ACTION_ERROR_MCP.domain,
        retry:
          declared.find((spec) => spec.reason === cause.reason)?.retry ??
          ACTION_ERROR_MCP.domain.retry,
      },
      cause.message,
      domainDetails(cause),
      domainHeaders(cause),
      cause,
    );
  }
  return null;
}

/**
 * The particulars of a foreign refusal, when it offers them as a method.
 *
 * A plugin's own error class may hold `details` as a data field, which must not
 * be called, and which a connector gets no particulars from.
 */
function domainDetails(cause: object): Record<string, readonly unknown[]> {
  const details = (cause as { details?: unknown }).details;
  return typeof details === "function"
    ? (details.call(cause) as Record<string, readonly unknown[]>)
    : {};
}

/**
 * The status a foreign refusal is answered with. The domain filter hands it to
 * Fastify, which refuses one outside 100-599 before it sends anything, and
 * sends no body with a 1xx, 204, 205 or 304, which would drop the reason and
 * the particulars the refusal exists to carry. A handler's stray number would
 * turn the refusal into a failure or an empty answer, so it is a 500 instead.
 */
function domainStatus(status: number): number {
  return Number.isInteger(status) &&
    status >= 200 &&
    status <= 599 &&
    status !== HttpStatus.NO_CONTENT &&
    status !== HttpStatus.RESET_CONTENT &&
    status !== HttpStatus.NOT_MODIFIED
    ? status
    : HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * The response headers of a foreign refusal that the response can carry: string
 * values under a valid name. The challenge is read from them, and the domain
 * filter writes them to the response, where Node refuses an invalid name or
 * value and the refusal would become a failure.
 */
function domainHeaders(cause: object): Record<string, string> {
  const headers = (cause as { headers?: unknown }).headers;
  const offered: unknown =
    typeof headers === "function" ? headers.call(cause) : undefined;
  if (typeof offered !== "object" || offered === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(offered).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && isWritableHeader(entry[0], entry[1]),
    ),
  );
}

function isWritableHeader(name: string, value: string): boolean {
  try {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A refusal raised by the service behind an action.
 *
 * Structural, as the registry's own test for passing one through is: a core
 * service raises a DomainError, but a plugin's handler raises a class of its
 * own, which cannot extend the host's.
 */
function isDomainRefusal(
  cause: unknown,
): cause is Error & Pick<DomainError, "reason" | "status"> {
  return (
    cause instanceof Error &&
    typeof (cause as Partial<DomainError>).reason === "string" &&
    typeof (cause as Partial<DomainError>).status === "number"
  );
}
