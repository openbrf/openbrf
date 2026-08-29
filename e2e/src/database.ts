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

/**
 * An audit entry read by what was done rather than by who it was done to.
 *
 * Two of the recorded acts name no person at all. Producing an extract of the
 * member register is one act over the whole register, and the full apartment
 * register extract discloses whatever the copy happened to hold, so both leave
 * `targetPersonId` null and say what they were about in `targetKind` and in the
 * context. `auditEntriesFor` cannot see either of them.
 *
 * Its own row type rather than a widened {@link AuditEntry}: the entries that
 * name a person are read by the specs that are about that person, and a
 * `targetKind` on those would be a column that is always null.
 */
export type AuditActionEntry = {
  readonly action: string;
  readonly actorPersonId: string | null;
  readonly targetKind: string | null;
  readonly context: Record<string, unknown> | null;
  readonly createdAt: Date;
};

/** Every audit entry recording one action, newest last. */
export async function auditEntriesByAction(
  action: string,
): Promise<readonly AuditActionEntry[]> {
  return withClient(async (client) => {
    const result = await client.query<AuditActionEntry>(
      `SELECT action, "actorPersonId", "targetKind", context, "createdAt"
         FROM public.audit_log_entry
        WHERE action = $1
        ORDER BY "createdAt" ASC, id ASC`,
      [action],
    );
    return result.rows;
  });
}

/**
 * Rows in the statutory member register, by the surname the register recorded.
 *
 * The archive keeps the name as it stood at the time of the event rather than
 * following the person record, so this is the only name a register entry can be
 * found by. Every spec that writes one uses a surname unique to the run, which
 * is what makes the answer this run's.
 *
 * Read directly for the same reason the audit log is: the member register has
 * no read endpoint that answers "what was written", only the extract a board
 * member is shown, and a spec proving that a move-in or an import wrote the
 * statutory row has to look at the row.
 */
export type MemberRegisterEntryRow = {
  readonly eventType: string;
  readonly eventOn: Date;
  readonly recordedFirstName: string;
  readonly recordedLastName: string;
  readonly createdAt: Date;
};

export async function memberRegisterEntriesByRecordedName(
  recordedLastName: string,
): Promise<readonly MemberRegisterEntryRow[]> {
  return withClient(async (client) => {
    const result = await client.query<MemberRegisterEntryRow>(
      `SELECT "eventType", "eventOn", "recordedFirstName", "recordedLastName",
              "createdAt"
         FROM public.member_register_entry
        WHERE "recordedLastName" = $1
        ORDER BY "eventOn" ASC, "createdAt" ASC, id ASC`,
      [recordedLastName],
    );
    return result.rows;
  });
}
