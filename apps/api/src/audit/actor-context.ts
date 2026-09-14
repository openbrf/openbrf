import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { AuditChannel } from "../generated/prisma/enums";
import type { AuditEntryInput } from "./audit-log.service";

/**
 * Who acted, and which way they reached the records.
 *
 * What a write service is told about its caller, and deliberately nothing more.
 * It is not a {@link Principal}: a service holding capabilities is a second
 * place an authorization decision can be made, and a second place is a place
 * the two can disagree. Whether the act is permitted is settled before the
 * service is called - by the global guard for a request, and by the action
 * registry for a dispatched action - and what reaches the service is only what
 * its audit entry has to say.
 *
 * The channel is derived from how the caller arrived and is never passed in by
 * whoever is calling: a cookie request is WEB, a token presented by a connected
 * app is MCP, a job is SYSTEM. That is what makes the channel evidence rather
 * than a claim.
 */
export interface ActorContext {
  readonly personId: string;
  readonly channel: AuditChannel;
  /** The connected app that acted, when one did. */
  readonly clientId?: string | null;
  readonly clientHost?: string | null;
  /** Correlates the entry with the request's log lines. */
  readonly requestId?: string;
}

/**
 * The actor behind an ordinary request from the web interface.
 *
 * The global guard attaches a principal to every non-public route or rejects
 * it, so reaching the throw means the guard stopped doing that, and a 500
 * naming the guard is the honest answer.
 */
export function webActor(request: RequestWithPrincipal): ActorContext {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return {
    personId: principal.personId,
    channel: "WEB",
    requestId: request.id,
  };
}

/**
 * The fields every audit write takes from an actor, as one object.
 *
 * Call sites spread this rather than naming the fields, so that a site cannot
 * carry the channel and drop the client: an entry recording that a connected
 * app published a news item, without recording which app, answers half the
 * question the channel was added to answer.
 */
export function auditActor(
  actor: ActorContext,
): Pick<
  AuditEntryInput,
  "channel" | "actorPersonId" | "clientId" | "clientHost"
> {
  return {
    channel: actor.channel,
    actorPersonId: actor.personId,
    clientId: actor.clientId ?? null,
    clientHost: actor.clientHost ?? null,
  };
}
