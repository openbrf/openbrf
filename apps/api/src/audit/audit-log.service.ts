import { Injectable } from "@nestjs/common";

import type { Prisma } from "../generated/prisma/client";
import type { AuditAction } from "../generated/prisma/enums";
import { PrismaService } from "../database/prisma.service";

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
 * The one free text an entry may carry is text with no other home: an actor's
 * stated reason for an act, typed into a field whose only destination is this
 * table, as {@link recordProtectedDataReveal} takes one. It is the entry's own
 * content rather than a copy of anything, and it is what lets a supervisory
 * authority ask not only who saw a protected person's address but why. The
 * interface that collects such a reason has to say that it is kept for good,
 * and the endpoint that accepts one has to bound its length.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one audited action.
   *
   * Pass the transaction client when the audited access happens inside a
   * transaction, so the two commit atomically.
   */
  async record(entry: AuditEntryInput, client?: AuditDbClient): Promise<void> {
    const db = client ?? this.prisma;
    await db.auditLogEntry.create({
      data: {
        action: entry.action,
        actorPersonId: entry.actorPersonId ?? null,
        targetPersonId: entry.targetPersonId ?? null,
        targetKind: entry.targetKind ?? null,
        targetId: entry.targetId ?? null,
        // Cast at the persistence boundary: the context is free-form
        // key/value detail, and Prisma types JSON columns with its own
        // recursive InputJsonValue that a plain Record does not satisfy.
        context:
          entry.context === undefined
            ? undefined
            : (entry.context as Prisma.InputJsonValue),
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
      fields: readonly string[];
      reason?: string;
    },
    client?: AuditDbClient,
  ): Promise<void> {
    await this.record(
      {
        action: "PROTECTED_DATA_REVEALED",
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
   */
  async withAuditedRead<T>(
    entry: AuditEntryInput,
    read: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await read(tx);
      await this.record(entry, tx);
      return result;
    });
  }
}
