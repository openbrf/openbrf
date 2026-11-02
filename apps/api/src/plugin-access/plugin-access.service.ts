import { Inject, Injectable, Logger } from "@nestjs/common";

import {
  AuditLogService,
  type AuditDbClient,
} from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { lockResidencyTransitions } from "../registers/residency-lock";
import {
  hasAnyResidency,
  PluginAccessError,
  pluginAccessViews,
  pluginNames,
  type GrantablePluginView,
  type PluginAccessesView,
  type PluginAccessView,
} from "./plugin-access";
import {
  PLUGIN_ACCESS_CLASS,
  type PluginAccessClass,
} from "./plugin-access-class";

export interface ChangePluginAccessInput {
  personId: string;
  pluginId: string;
  actorPersonId: string;
}

/**
 * The board's grant and withdrawal of a plugin access on a person's page
 * (ADR 0053).
 *
 * Shaped as the system roles are: an access is held or not held, a
 * withdrawal deletes the row, and the audit log is where the history is. A
 * change that changes nothing writes nothing, so granting an access that is
 * held, or withdrawing one that is not, answers with the state as it is.
 *
 * Reached from the web interface only. Its routes require
 * `addressBook:write`, which stays in DENIED_ACTION_CAPABILITIES, so neither a
 * connected app's token nor the AI package can grant one: a grant widens whom
 * a plugin serves.
 */
@Injectable()
export class PluginAccessService {
  private readonly logger = new Logger(PluginAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(PLUGIN_ACCESS_CLASS)
    private readonly classes: PluginAccessClass,
  ) {}

  /** The accesses one person holds, oldest first. */
  async forPerson(
    personId: string,
    db: AuditDbClient = this.prisma,
  ): Promise<PluginAccessView[]> {
    const rows = await db.pluginAccess.findMany({
      where: { personId },
      orderBy: [{ grantedAt: "asc" }, { pluginId: "asc" }],
      select: { pluginId: true, grantedAt: true },
    });
    return pluginAccessViews(db, rows);
  }

  /** The installed plugins the board can grant an access to today. */
  async grantable(): Promise<GrantablePluginView[]> {
    const serving = await this.classes.pluginsServingAccess();
    if (serving.size === 0) {
      return [];
    }
    const installed = await this.prisma.installedPlugin.findMany({
      where: { id: { in: [...serving] } },
      orderBy: [{ id: "asc" }],
      select: { id: true },
    });
    const names = await pluginNames(
      this.prisma,
      installed.map((plugin) => plugin.id),
    );
    return installed
      .map((plugin) => ({
        pluginId: plugin.id,
        pluginName: names.get(plugin.id) ?? plugin.id,
      }))
      .sort((a, b) => a.pluginName.localeCompare(b.pluginName, "sv"));
  }

  /**
   * Grants one person access to one plugin.
   *
   * Refused for a person with any residency on record, current, ended or yet
   * to begin. The check is made under the person's residency transition lock,
   * which every path that records a residency takes before it writes one, and
   * which ends the person's accesses in the same transaction. So a move-in
   * running beside this either commits first, and this finds its residency,
   * or waits for this to commit and then ends what this granted.
   */
  async grant(input: ChangePluginAccessInput): Promise<PluginAccessesView> {
    const serving = await this.classes.pluginsServingAccess();

    return this.prisma.$transaction(async (tx) => {
      await lockResidencyTransitions(tx, input.personId);

      const person = await tx.person.findUnique({
        where: { id: input.personId },
        select: { id: true },
      });
      if (person === null) {
        throw new PluginAccessError("No such person.", "person-not-found");
      }

      const plugin = await tx.installedPlugin.findUnique({
        where: { id: input.pluginId },
        select: { id: true },
      });
      if (plugin === null) {
        throw new PluginAccessError(
          "No such plugin is installed.",
          "plugin-not-found",
        );
      }
      if (!serving.has(plugin.id)) {
        throw new PluginAccessError(
          "This plugin does not serve people the board gives access to, or " +
            "its install has not consented to that.",
          "plugin-access-not-served",
        );
      }

      if (await hasAnyResidency(tx, input.personId)) {
        throw new PluginAccessError(
          "A plugin access is for a person who has never lived here, and " +
            "this person has a residency on record.",
          "person-has-residency",
        );
      }

      const held = await tx.pluginAccess.findUnique({
        where: {
          personId_pluginId: {
            personId: input.personId,
            pluginId: input.pluginId,
          },
        },
        select: { id: true },
      });
      if (held !== null) {
        return this.accessesOf(tx, input.personId);
      }

      await tx.pluginAccess.create({
        data: { personId: input.personId, pluginId: input.pluginId },
      });
      await this.audit.record(
        {
          action: "PLUGIN_ACCESS_GRANTED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          context: { plugin: input.pluginId },
        },
        tx,
      );

      this.logger.log(
        `Granted access to plugin ${input.pluginId} to person ${input.personId} by ${input.actorPersonId}`,
      );
      return this.accessesOf(tx, input.personId);
    });
  }

  /**
   * Withdraws one person's access to one plugin.
   *
   * Takes effect on the person's next request, which the resident route's
   * guard decides from this table. Allowed whatever the install serves today:
   * an access to a plugin whose class was since withdrawn serves nobody, and
   * the board still has to be able to take it away.
   */
  async withdraw(input: ChangePluginAccessInput): Promise<PluginAccessesView> {
    return this.prisma.$transaction(async (tx) => {
      const person = await tx.person.findUnique({
        where: { id: input.personId },
        select: { id: true },
      });
      if (person === null) {
        throw new PluginAccessError("No such person.", "person-not-found");
      }

      const removed = await tx.pluginAccess.deleteMany({
        where: { personId: input.personId, pluginId: input.pluginId },
      });
      if (removed.count === 0) {
        // Not held, or another withdrawal committed first and recorded it.
        return this.accessesOf(tx, input.personId);
      }

      await this.audit.record(
        {
          action: "PLUGIN_ACCESS_WITHDRAWN",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          context: { plugin: input.pluginId },
        },
        tx,
      );

      this.logger.log(
        `Withdrew access to plugin ${input.pluginId} from person ${input.personId} by ${input.actorPersonId}`,
      );
      return this.accessesOf(tx, input.personId);
    });
  }

  /** Read inside the transaction, so the answer is the state it just wrote. */
  private async accessesOf(
    tx: AuditDbClient,
    personId: string,
  ): Promise<PluginAccessesView> {
    return { personId, accesses: await this.forPerson(personId, tx) };
  }
}
