import { randomUUID } from "node:crypto";

import pg from "pg";

import { stack } from "./stack";

/**
 * A pending change, held straight in the database.
 *
 * Written here rather than proposed through the application, because nothing
 * the instance serves to a browser proposes one: a plugin does, through
 * `host.actions.propose`, and the AI package does, and neither is part of the
 * stack the screenshots are taken from. What the screen is for is reading and
 * answering a change, so the walk needs one as a precondition. The row is what
 * `PendingChangeService.propose` writes, for the channel the AI package
 * proposes on.
 *
 * The connection is the owner's, like `board.ts`. A pending change is service
 * tier: it is deleted when it is answered, and what stays is the audit entry,
 * which this does not write. A change already held with the same input is not
 * held twice, so a capture against a stack that is already up leaves one.
 */
export async function holdPendingChange(change: {
  readonly actionName: string;
  readonly input: unknown;
  readonly proposedByPersonId: string;
}): Promise<void> {
  const client = new pg.Client({ connectionString: stack.databaseUrl });
  await client.connect();
  try {
    // Prisma maps the model to pending_change but leaves the column names in
    // camel case, so every one of them has to be quoted.
    await client.query(
      `INSERT INTO public.pending_change
         (id, "actionName", input, "proposedByPersonId", channel, "proposedAt",
          "expiresAt")
       SELECT $1, $2, $3::jsonb, $4, 'AI'::"AuditChannel", now(),
              now() + interval '7 days'
        WHERE NOT EXISTS (
          SELECT 1 FROM public.pending_change
           WHERE "actionName" = $2 AND input = $3::jsonb
             AND "proposedByPersonId" = $4
        )`,
      [
        randomUUID(),
        change.actionName,
        JSON.stringify(change.input),
        change.proposedByPersonId,
      ],
    );
  } finally {
    await client.end();
  }
}
