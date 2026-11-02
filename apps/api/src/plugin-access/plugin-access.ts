import { HttpStatus } from "@nestjs/common";
import type { PluginAccessReason } from "@openbrf/shared";

import type {
  AuditDbClient,
  AuditLogService,
} from "../audit/audit-log.service";
import type { Prisma } from "../generated/prisma/client";
import type { AuditChannel } from "../generated/prisma/enums";
import { pluginProcessorKey } from "../data-protection/processor-key";
import { DomainError } from "../http/domain-error";

/**
 * A plugin access (tilläggsåtkomst, ADR 0053): the board's grant to one person
 * who has never lived here to be served by one plugin's resident routes.
 *
 * The rules every path shares are here, so the grant on the person's page, a
 * move-in, a sign-up approval and an import cannot come to disagree about them:
 * the grant is refused for a person with any residency on record, and
 * recording a residency ends every access the person holds, in the
 * transaction that records it.
 */

const PLUGIN_ACCESS_STATUS: Record<PluginAccessReason, number> = {
  "person-not-found": HttpStatus.NOT_FOUND,
  "plugin-not-found": HttpStatus.NOT_FOUND,
  // Conflicts: each is a well-formed request that the state of the register
  // or of the install cannot take, and the same request is refused whoever
  // makes it.
  "plugin-access-not-served": HttpStatus.CONFLICT,
  "person-has-residency": HttpStatus.CONFLICT,
};

export class PluginAccessError extends DomainError {
  override readonly status: number;
  override readonly reason: PluginAccessReason;

  constructor(message: string, reason: PluginAccessReason) {
    super(message);
    this.reason = reason;
    this.status = PLUGIN_ACCESS_STATUS[reason];
  }
}

/** One access, as the person's page and the grant's answer show it. */
export interface PluginAccessView {
  pluginId: string;
  /**
   * The plugin's name from its row in the record of processing activities,
   * or its id where no row names it, as the access report names a plugin.
   */
  pluginName: string;
  /** ISO instant the board granted it. */
  grantedAt: string;
}

/** Every access one person holds, after a grant or a withdrawal. */
export interface PluginAccessesView {
  personId: string;
  accesses: PluginAccessView[];
}

/** A plugin the board can grant access to, for the grant's picker. */
export interface GrantablePluginView {
  pluginId: string;
  pluginName: string;
}

/**
 * The residencies that refuse a grant: every one on record, whatever its
 * dates. One held today makes the person a resident, one recorded to begin
 * later will, and one that has ended makes them a former resident, whom no
 * class serves (ADR 0053, "The order of the refusals").
 */
export async function hasAnyResidency(
  db: AuditDbClient,
  personId: string,
): Promise<boolean> {
  return (await db.residency.count({ where: { personId } })) > 0;
}

/**
 * Ends every plugin access the person holds, with an entry for each, because a
 * residency has just been recorded for them.
 *
 * Called inside the transaction that records the residency, after the insert
 * and under the person's residency transition lock, which the grant takes as
 * well: a grant either commits first and is ended here, or waits and then
 * finds the residency and is refused. So no access outlives a person's first
 * residency, whether that residency begins today, later or has already ended.
 *
 * Returns how many it ended.
 */
export async function endPluginAccesses(
  tx: Prisma.TransactionClient,
  audit: AuditLogService,
  input: {
    personId: string;
    /** Whoever recorded the residency; null for a write no person made. */
    actorPersonId: string | null;
    channel: AuditChannel;
  },
): Promise<number> {
  const held = await tx.pluginAccess.findMany({
    where: { personId: input.personId },
    orderBy: [{ pluginId: "asc" }],
    select: { id: true, pluginId: true },
  });
  if (held.length === 0) {
    return 0;
  }

  // One delete per access, so each entry stands for a row this write took. A
  // withdrawal takes no transition lock, and one that committed between the
  // read and here wrote its own entry for the row it took.
  let ended = 0;
  for (const access of held) {
    const removed = await tx.pluginAccess.deleteMany({
      where: { id: access.id },
    });
    if (removed.count === 0) {
      continue;
    }
    await audit.record(
      {
        action: "PLUGIN_ACCESS_ENDED",
        channel: input.channel,
        actorPersonId: input.actorPersonId,
        targetPersonId: input.personId,
        context: { plugin: access.pluginId },
      },
      tx,
    );
    ended++;
  }
  return ended;
}

/** The accesses as a screen shows them, each with its plugin's name. */
export async function pluginAccessViews(
  db: AuditDbClient,
  rows: readonly { pluginId: string; grantedAt: Date }[],
): Promise<PluginAccessView[]> {
  const names = await pluginNames(
    db,
    rows.map((row) => row.pluginId),
  );
  return rows.map((row) => ({
    pluginId: row.pluginId,
    pluginName: names.get(row.pluginId) ?? row.pluginId,
    grantedAt: row.grantedAt.toISOString(),
  }));
}

/**
 * Each plugin's name from its row in the record of processing activities,
 * ended or not, as the access report names a plugin. A plugin with no row is
 * left out, and the caller shows its id.
 */
export async function pluginNames(
  db: AuditDbClient,
  pluginIds: readonly string[],
): Promise<Map<string, string>> {
  if (pluginIds.length === 0) {
    return new Map();
  }
  const keys = new Map(pluginIds.map((id) => [pluginProcessorKey(id), id]));
  const rows = await db.processingActivity.findMany({
    where: { sourceKey: { in: [...keys.keys()] } },
    select: { sourceKey: true, name: true },
  });
  const names = new Map<string, string>();
  for (const row of rows) {
    const pluginId =
      row.sourceKey === null ? undefined : keys.get(row.sourceKey);
    if (pluginId !== undefined) {
      names.set(pluginId, row.name);
    }
  }
  return names;
}
