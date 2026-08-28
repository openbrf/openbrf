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
  /** Which fields were revealed, request context, and similar detail. */
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
