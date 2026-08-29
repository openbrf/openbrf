import pg from "pg";

import { stack } from "./stack";

/**
 * The external property manager, granted straight in the database.
 *
 * There is no endpoint that grants a system role. The first administrator is
 * made by the setup wizard and every other account arrives by invitation, so
 * the one seat this suite cannot produce over HTTP is exactly the one decision
 * 11 is about - and the promise it makes (issue handling, and never the address
 * book) is worth proving against a real deployed instance rather than only in a
 * unit test.
 *
 * The connection is the owner's, like the audit-log reads and the page fixture.
 * A system role is service tier: no append-only trigger, nothing statutory.
 */

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

/**
 * Makes this person an external property manager, if they are not one already.
 *
 * Idempotent against the database rather than against process state: the suite
 * may run spec files in different worker processes, so "have I already done
 * this" has to be a question about the instance.
 */
export async function grantPropertyManager(personId: string): Promise<void> {
  await withClient(async (client) => {
    // Prisma maps the model to system_role but leaves the column names in camel
    // case, so every one of them has to be quoted.
    await client.query(
      `INSERT INTO public.system_role (id, "personId", role, "grantedAt")
       VALUES ($1, $2, 'PROPERTY_MANAGER'::"SystemRoleType", now())
       ON CONFLICT ("personId", role) DO NOTHING`,
      [`e2e-role-${personId}`, personId],
    );
  });
}
