import { Injectable } from "@nestjs/common";

import type { Prisma } from "../generated/prisma/client";
import type { AuditAction, AuditChannel } from "../generated/prisma/enums";
import { PrismaService } from "../database/prisma.service";
import { actingSupportSession } from "./acting-support-session";

/**
 * Either the root client or a transaction client.
 *
 * Every audit write takes one of these so it can be enlisted in the caller's
 * transaction. That is a hard requirement rather than a convenience: an access
 * to protected personal data and the record of that access must commit or roll
 * back together, otherwise the log either misses accesses that happened or
 * claims accesses that did not.
 */
export type AuditDbClient = PrismaService | Prisma.TransactionClient;

export interface AuditEntryInput {
  action: AuditAction;
  /**
   * Which way the act reached the records.
   *
   * Required rather than defaulted, so that a new call site decides rather than
   * inherits. WEB is a person in the web interface, MCP a token presented by a
   * connected app, AI the AI package, SYSTEM a job whose clock struck or a
   * seed, PLUGIN a plugin's own write through the host, MANAGEMENT whoever
   * hosts the instance reading its summary (ADR 0021), SUPPORT a supporter
   * under support access (ADR 0028). An optional field
   * defaulting to WEB would be wrong in exactly the places that matter: the
   * nightly purges and the seeds have no person behind them, and they are the
   * writes SYSTEM exists to make explicit.
   *
   * Overridden by {@link AuditLogService.record} while a support session's
   * request is served: the entry is written on SUPPORT whatever was passed.
   */
  channel: AuditChannel;
  /**
   * The connected app that acted, when one did, and the host it published its
   * description at. Merged into `context` under a reserved `client` key by
   * {@link AuditLogService.record}, so that which app acted is a property of
   * the writer rather than of a call site's care - and so that it comes from
   * the token the request presented, never from anything the caller said about
   * itself on the wire.
   */
  clientId?: string | null;
  clientHost?: string | null;
  /**
   * The support session the act was made under (ADR 0028), for an entry
   * written outside the request the session made: its sign-in, which is the
   * request that establishes it. Inside such a request the session is read
   * from the request's own storage and need not be passed. Either way it is
   * merged into `context` under a reserved `support` key and puts the entry on
   * SUPPORT.
   */
  supportSessionId?: string | null;
  /** Omitted for actions taken by the system rather than a signed-in person. */
  actorPersonId?: string | null;
  targetPersonId?: string | null;
  /** Entity kind for non-person targets, e.g. "plugin" or "theme". */
  targetKind?: string | null;
  targetId?: string | null;
  /**
   * Facts about the act: field names, identifiers, enum values, counts,
   * booleans and dates. Never a value that was read or written, and never
   * free text copied from a record of its own - see the retention rule on
   * {@link AuditLogService}.
   */
  context?: Record<string, unknown>;
}

/**
 * Writes the audit log required for protected personal data
 * (skyddade personuppgifter) and for the statutory register extracts.
 *
 * It records changes as well as reads, so it is the audit log and never the
 * "access log": that name covers only reads, and calling this table by it
 * would understate what has to be kept and what the retention screen has to
 * say a retention policy cannot reach.
 *
 * The table is append-only at the database level: a BEFORE UPDATE OR DELETE
 * trigger rejects any attempt to rewrite history, and the runtime role holds
 * no UPDATE, DELETE or TRUNCATE on it. There is deliberately no method here to
 * amend or remove an entry.
 *
 * ## What `context` may carry
 *
 * An entry is append-only and outside every purge scope, so whatever goes into
 * `context` is kept for as long as the instance exists. The service tier around
 * it is not: a rejected sign-up request carries a purge date, a moved-out
 * person's contact details are erased on theirs, and neither takes the audit
 * entry that mentions them along. Three rules follow, and they are the rules
 * because a writer thinking about the act is not thinking about retention.
 *
 *  1. **Facts, not prose.** Identifiers, enum values, field names, counts,
 *     booleans and dates. That is what makes an entry answerable later: which
 *     fields were seen, how many rows an act touched, which apartment it was
 *     about.
 *
 *  2. **Never the value.** The field name says what was read or written; the
 *     value stays where it lives. An audit log that carried the phone numbers
 *     it recorded the reading of would be a second, permanent copy of the
 *     register - readable by everyone who may read the log, and beyond the
 *     reach of the erasure the first copy is promised.
 *
 *  3. **Never free text copied from a record of its own.** A sign-up
 *     request's rejection reason, a document's title, an issue's description:
 *     these belong to rows with a lifecycle, and a copy here would outlive the
 *     original by design rather than by accident - kept after the retention
 *     policy erased it, and stale after the record was corrected, because this
 *     table cannot be corrected. Name the record instead: `targetKind` and
 *     `targetId` are what the entry is for, and the text is read from the
 *     record while the record exists. Once it does not, the text is gone -
 *     which is the retention policy working, not a gap in the log.
 *
 * Two free texts are allowed, each with no other home. The first is an actor's
 * stated reason for an act, typed into a field whose only destination is this
 * table, as {@link recordProtectedDataReveal} takes one. It is the entry's own
 * content rather than a copy of anything, and it is what lets a supervisory
 * authority ask not only who saw a protected person's address but why. The
 * interface that collects such a reason has to say that it is kept for good,
 * and the endpoint that accepts one has to bound its length. The second is the
 * name of the connected app an MCP call went through, copied in by
 * `actingClientName` because the client row can be deleted later; it is
 * cleaned of control and formatting characters and bounded there.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one audited action.
   *
   * Pass the transaction client when the audited access happens inside a
   * transaction, so the two commit atomically.
   *
   * Every write to the log comes through here - `withAuditedRead` and
   * `recordProtectedDataReveal` included - and nothing writes the table any
   * other way. That is what lets this be the one place that puts an entry
   * written for a support session on SUPPORT.
   */
  async record(entry: AuditEntryInput, client?: AuditDbClient): Promise<void> {
    const db = client ?? this.prisma;
    const support = entry.supportSessionId ?? actingSupportSession();
    const context = withActingSupport(
      withActingClient(entry, await actingClientName(db, entry.clientId)),
      support,
    );
    await db.auditLogEntry.create({
      data: {
        action: entry.action,
        // Whatever the call site passed: a request a support session made is
        // the supporter's, and an entry claiming WEB would say the
        // administrator did it themselves (ADR 0028).
        channel: support === null ? entry.channel : "SUPPORT",
        actorPersonId: entry.actorPersonId ?? null,
        targetPersonId: entry.targetPersonId ?? null,
        targetKind: entry.targetKind ?? null,
        targetId: entry.targetId ?? null,
        // Cast at the persistence boundary: the context is free-form
        // key/value detail, and Prisma types JSON columns with its own
        // recursive InputJsonValue that a plain Record does not satisfy.
        context:
          context === undefined
            ? undefined
            : (context as Prisma.InputJsonValue),
      },
    });
  }

  /**
   * Records that masked fields on a person with protected personal data were
   * revealed, naming the fields so a later data subject access report can say
   * exactly what was seen.
   *
   * The fields, never their values: rule 2 above, and the reason this helper
   * takes a list of names rather than the object that was read.
   *
   * `reason` is the permitted free text - what the person who revealed the
   * data says they revealed it for. It has no record of its own to be read
   * back from, which is what distinguishes it from the text rule 3 forbids,
   * and it is kept for as long as the entry is.
   */
  async recordProtectedDataReveal(
    input: {
      actorPersonId: string;
      targetPersonId: string;
      channel: AuditChannel;
      clientId?: string | null;
      clientHost?: string | null;
      fields: readonly string[];
      reason?: string;
    },
    client?: AuditDbClient,
  ): Promise<void> {
    await this.record(
      {
        action: "PROTECTED_DATA_REVEALED",
        channel: input.channel,
        clientId: input.clientId,
        clientHost: input.clientHost,
        actorPersonId: input.actorPersonId,
        targetPersonId: input.targetPersonId,
        context: {
          fields: [...input.fields],
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      },
      client,
    );
  }

  /**
   * Runs an audited read inside a transaction, so the returned data and its
   * log entry share a fate. Use this rather than calling record() next to a
   * read and hoping both succeed.
   *
   * `timeout` is the transaction's budget in milliseconds, read and entry
   * together. Prisma's default of five seconds suits a lookup; a read whose
   * size grows with what is held - a whole report rather than one row - states
   * a budget of its own, because past it the transaction is aborted with
   * P2028 and the reader gets nothing.
   *
   * `entry` may be a function of what was read, for an entry that records a
   * fact about the answer - how many rows it held - rather than only the
   * question.
   */
  async withAuditedRead<T>(
    entry: AuditEntryInput | ((result: T) => AuditEntryInput),
    read: (client: Prisma.TransactionClient) => Promise<T>,
    options: { timeout?: number } = {},
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await read(tx);
      await this.record(
        typeof entry === "function" ? entry(result) : entry,
        tx,
      );
      return result;
    }, options);
  }
}

/** The longest app name an entry keeps; a name is a label, not a document. */
const CLIENT_NAME_LIMIT = 100;

/**
 * The name the acting connected app goes by, read when the entry is written.
 *
 * Read here from the client's own row, by the id the token presented, rather
 * than carried from the request: a call site cannot omit it, and it never comes
 * from anything the caller said. It is the one name an entry copies from a
 * record of its own (rule 3 on {@link AuditLogService}), because the host alone
 * does not say which app acted - an administrator-registered client with no
 * client URI has none - and the row can be deleted later, taking the only other
 * way to read the name with it. The name is the app's own label and not about a
 * person, but the client chose it, so it is stripped of control characters and
 * bounded; null when the client is gone or gave none.
 */
async function actingClientName(
  db: AuditDbClient,
  clientId: string | null | undefined,
): Promise<string | null> {
  if (clientId === null || clientId === undefined) {
    return null;
  }
  const client = await db.oauthClient.findUnique({
    where: { clientId },
    select: { name: true },
  });
  const cleaned = (client?.name ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .trim();
  // Cut by code point: a UTF-16 cut can leave half a surrogate pair, which
  // jsonb refuses, and the write would fail with the audited act.
  const name = Array.from(cleaned).slice(0, CLIENT_NAME_LIMIT).join("").trim();
  return name === "" ? null : name;
}

/**
 * The entry's context with the acting connected app merged in.
 *
 * `client` is a reserved key: an entry naming a client gets it from the token
 * the request presented, and a context that happened to carry a key of that
 * name is overwritten rather than trusted. Written here rather than at the call
 * sites so that a write through a connected app cannot record the act and lose
 * which app made it.
 */
function withActingClient(
  entry: AuditEntryInput,
  name: string | null,
): Record<string, unknown> | undefined {
  const clientId = entry.clientId ?? null;
  if (clientId === null) {
    return entry.context;
  }
  return {
    ...entry.context,
    client: { id: clientId, name, host: entry.clientHost ?? null },
  };
}

/**
 * The entry's context with the support session it was made under merged in.
 *
 * `support` is a reserved key, as `client` is: an entry made under a support
 * session names it from the request's own storage or from the sign-in that
 * established it, and a context that happened to carry a key of that name is
 * overwritten rather than trusted.
 */
function withActingSupport(
  context: Record<string, unknown> | undefined,
  supportSessionId: string | null,
): Record<string, unknown> | undefined {
  if (supportSessionId === null) {
    return context;
  }
  return { ...context, support: { session: supportSessionId } };
}
