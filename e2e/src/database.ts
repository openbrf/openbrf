import pg from "pg";

import { stack } from "./stack";

/**
 * Direct reads of the append-only audit log.
 *
 * The audit log has no read endpoint, by design: it is evidence, not a feature.
 * A reveal of protected personal data has to land in it, and the only way to
 * prove that against a deployed instance is to look at the table the instance
 * wrote to. The connection is the owner's, and every query here is a SELECT.
 */

export type AuditEntry = {
  readonly action: string;
  readonly actorPersonId: string | null;
  readonly targetPersonId: string | null;
  readonly context: Record<string, unknown> | null;
  readonly createdAt: Date;
};

async function withClient<T>(
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: stack.databaseUrl });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** Every audit entry recorded against one person, newest last. */
export async function auditEntriesFor(
  targetPersonId: string,
): Promise<readonly AuditEntry[]> {
  return withClient(async (client) => {
    // Prisma maps the model to audit_log_entry but leaves the column names in
    // camel case, so every one of them has to be quoted.
    const result = await client.query<AuditEntry>(
      `SELECT action, "actorPersonId", "targetPersonId", context, "createdAt"
         FROM public.audit_log_entry
        WHERE "targetPersonId" = $1
        ORDER BY "createdAt" ASC, id ASC`,
      [targetPersonId],
    );
    return result.rows;
  });
}
