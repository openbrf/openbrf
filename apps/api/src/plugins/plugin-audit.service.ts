import { Injectable, Logger } from "@nestjs/common";
import {
  PLUGIN_AUDIT_LIMITS,
  type PluginAuditEntry,
  PluginAuditRateError,
  PluginHostUnavailableError,
} from "@openbrf/plugin-sdk";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";
import { z } from "zod";

import { AuditLogService } from "../audit/audit-log.service";
import { TokenBuckets } from "../http/public-rate-limit.guard";
import { PluginLoaderService } from "./plugin-loader.service";

/**
 * What a plugin writes to the audit log through `host.audit` (ADR 0035).
 *
 * `AuditLogService` stays out of a plugin's reach (ADR 0008): the plugin hands
 * this an entry, and this writes one value of the core's own, PLUGIN_RECORDED,
 * on the plugin channel, with the plugin as its target. Which plugin wrote it,
 * and who the actor was, are the host's to say and never the entry's.
 *
 * The entry is about what the plugin did - which screen the residents were
 * switched on for, and by whom - and never a copy of what it read. The log is
 * append-only and exempt from every purge, so the bounds below are what keeps
 * it from becoming the one copy of a person's data an erasure cannot reach: a
 * person is named as the actor and never in the detail, a value is short, and
 * one holding a personal identity number is refused.
 *
 * The one other place an entry names a person is its target person, when the
 * plugin gives a `subject` (ADR 0047): the person the act was about, held to
 * the rule a record about a person is, so the entry reaches their access
 * report through the log as every core entry about them does.
 *
 * How many entries there are is bounded too. An entry needs no permission
 * and no purge removes it, so a plugin writing in a loop, or to bury the
 * entries that matter in a person's access report, could grow the log for good.
 * Who spends a budget decides what happens past it:
 *
 * - Entries written on a person's requests are spent by that person, through
 *   whatever the plugin audits for them. Each person has a budget of
 *   `PLUGIN_AUDIT_LIMITS.perPersonPerMinute` with each plugin, and the entry
 *   past it is refused. Stopping the plugin instead would let any member stop
 *   it, for everyone, by making it audit them fast enough.
 * - Entries written on a device's requests, on the plugin's own device routes,
 *   are spent by that device, which names nobody and so is no actor. Each
 *   device has a budget of `PLUGIN_AUDIT_LIMITS.perDevicePerMinute` with the
 *   plugin, and the entry past it is refused, for the reason a person's is:
 *   anyone holding a device's token could otherwise stop the plugin. Kept per
 *   device rather than per plugin, so that one device going on cannot turn
 *   away every other device's entries.
 * - Entries written with no request are spent by the plugin alone, from its own
 *   jobs. Each plugin has a budget of `PLUGIN_AUDIT_LIMITS.perMinute` of them,
 *   and a plugin that writes past it is stopped with the finding
 *   `audit-rate-exceeded`: refusing only the entries past the budget would
 *   still let a job writing in a loop add that many rows every minute, for as
 *   long as the plugin runs.
 */

/** An event, a target kind: what is also part of a plugin's text key. */
const PLUGIN_AUDIT_WORD = /^[a-z][a-z0-9.-]*$/;

/**
 * A key of `detail`: a name such as `enabled` or `screenCount`, so a key
 * cannot carry a person's name and address the way free text could.
 */
const PLUGIN_AUDIT_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

const detailValueSchema = z.union([
  z.string().max(PLUGIN_AUDIT_LIMITS.detailValue),
  z.number().finite(),
  z.boolean(),
]);

const pluginAuditEntrySchema = z.strictObject({
  event: z.string().max(PLUGIN_AUDIT_LIMITS.event).regex(PLUGIN_AUDIT_WORD),
  targetKind: z
    .string()
    .max(PLUGIN_AUDIT_LIMITS.targetKind)
    .regex(PLUGIN_AUDIT_WORD)
    .optional(),
  targetId: z.string().min(1).max(PLUGIN_AUDIT_LIMITS.targetId).optional(),
  detail: z
    .record(
      z.string().max(PLUGIN_AUDIT_LIMITS.detailKey).regex(PLUGIN_AUDIT_KEY),
      detailValueSchema,
    )
    .refine(
      (detail) =>
        Object.keys(detail).length <= PLUGIN_AUDIT_LIMITS.detailValues,
      `holds at most ${String(PLUGIN_AUDIT_LIMITS.detailValues)} values`,
    )
    .optional(),
  /*
   * Checked against the subject rule by the host before the entry reaches
   * here (ADR 0047): a person the plugin may name in a record about a person.
   * Only its shape is held here.
   */
  subject: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
});

/** Who the host marked on the request the plugin acted on. */
export interface PluginAuditActor {
  personId: string;
  clientId: string | null;
  clientHost: string | null;
}

/**
 * The device whose request, on one of the plugin's device routes, the plugin
 * acted on. It names nobody, so the entry has no actor; the device's token
 * only says whose budget the entry is spent from.
 */
export interface PluginAuditDevice {
  deviceTokenId: string;
}

/** The keys of the entry's `detail`, in the order the plugin gave them. */
function detailKeysOf(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const detail = (input as Record<string, unknown>)["detail"];
  return typeof detail === "object" && detail !== null
    ? Object.keys(detail)
    : [];
}

/**
 * The field a refusal names. A key of `detail` is the plugin's own text and may
 * hold anything, a personal identity number included, so it is named by its
 * place among the keys and never by itself.
 */
function fieldLabel(
  path: readonly PropertyKey[],
  detailKeys: string[],
): string {
  const [field, key] = path;
  if (field === undefined) return "(entry)";
  if (field !== "detail" || key === undefined) return String(field);
  const position = detailKeys.indexOf(String(key));
  return `detail[${position === -1 ? "?" : String(position)}]`;
}

/**
 * The entry, checked, or the RangeError that refuses it.
 *
 * The message names the field and never its value: a plugin may pass
 * anything, a resident's name included, and the error ends up in the log.
 */
export function checkedPluginAuditEntry(
  pluginId: string,
  input: unknown,
  now: Date = new Date(),
): PluginAuditEntry {
  const detailKeys = detailKeysOf(input);
  const parsed = pluginAuditEntrySchema.safeParse(input);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => fieldLabel(issue.path, detailKeys)),
      ),
    ];
    throw new RangeError(
      `Plugin "${pluginId}" wrote an audit entry the host refuses at ` +
        `${fields.join(", ")}; see PLUGIN_AUDIT_LIMITS.`,
    );
  }

  // Each field is scanned on its own: a number split across two of them gets
  // through, which the plugin contract says.
  const entry = parsed.data;
  const scanned: [string, string][] = [
    ["event", entry.event],
    ...(entry.targetKind === undefined
      ? []
      : [["targetKind", entry.targetKind] as [string, string]]),
    ...(entry.targetId === undefined
      ? []
      : [["targetId", entry.targetId] as [string, string]]),
    ...Object.entries(entry.detail ?? {}).flatMap(
      ([key, value], position): [string, string][] => [
        [`detail[${String(position)}]`, key],
        [`detail[${String(position)}]`, String(value)],
      ],
    ),
  ];
  const holding = [
    ...new Set(
      scanned
        .filter(
          ([, text]) => scanForPersonalIdentityNumbers(text, now).length > 0,
        )
        .map(([field]) => field),
    ),
  ];
  if (holding.length > 0) {
    throw new RangeError(
      `Plugin "${pluginId}" wrote an audit entry with a personal identity ` +
        `number at ${holding.join(", ")}; the audit log never holds one.`,
    );
  }

  return entry;
}

@Injectable()
export class PluginAuditService {
  private readonly logger = new Logger(PluginAuditService.name);
  /**
   * In this process, as the public budgets are. Per plugin id, for entries
   * written with no request.
   */
  private readonly budgets = new TokenBuckets();
  /**
   * Per plugin id and person, for entries written on a request. Apart from
   * `budgets`, so that the sweep of a full map of people cannot refill a
   * plugin's own budget.
   */
  private readonly personBudgets = new TokenBuckets();
  /** Per plugin id and device token, for entries written on a device route. */
  private readonly deviceBudgets = new TokenBuckets();
  /** Plugins this stopped, so a plugin is reported once however it retries. */
  private readonly stopped = new Set<string>();

  constructor(
    private readonly audit: AuditLogService,
    private readonly loader: PluginLoaderService,
  ) {}

  /**
   * Writes the entry, spending from the budget of whoever's request it was
   * written on: the person's, the device's, or with `null` the plugin's own.
   */
  async record(
    pluginId: string,
    on: PluginAuditActor | PluginAuditDevice | null,
    input: unknown,
  ): Promise<void> {
    // Checked before the budget is spent: a refused entry writes nothing, so it
    // grows nothing either. Every budget is spent synchronously, before the
    // write is awaited, so entries written together cannot all read a budget
    // that has room for only some of them.
    const entry = checkedPluginAuditEntry(pluginId, input);
    let actor: PluginAuditActor | null = null;
    if (on === null) {
      this.spendOwn(pluginId);
    } else if ("personId" in on) {
      this.spendFor(pluginId, on.personId);
      actor = on;
    } else {
      this.spendForDevice(pluginId, on.deviceTokenId);
    }

    await this.audit.record({
      action: "PLUGIN_RECORDED",
      channel: "PLUGIN",
      actorPersonId: actor?.personId ?? null,
      clientId: actor?.clientId ?? null,
      clientHost: actor?.clientHost ?? null,
      targetPersonId: entry.subject ?? null,
      // The plugin is the target, as on every other entry about a plugin. What
      // the plugin acted on is its own vocabulary and goes in the context, so
      // no plugin can write an entry that reads as the core's about a person.
      targetKind: "plugin",
      targetId: pluginId,
      context: {
        event: entry.event,
        ...(entry.targetKind === undefined
          ? {}
          : { targetKind: entry.targetKind }),
        ...(entry.targetId === undefined ? {} : { targetId: entry.targetId }),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      },
    });
  }

  /**
   * Spends one entry of the person's budget with the plugin, or refuses it.
   *
   * Keyed on the person and not on the client, so that a person signed in
   * through several apps has one budget, not one for each. A plugin id holds
   * no space, so the key names one plugin and person only.
   */
  private spendFor(pluginId: string, personId: string): void {
    const perMinute = PLUGIN_AUDIT_LIMITS.perPersonPerMinute;
    if (
      !this.personBudgets.take(`${pluginId} ${personId}`, perMinute).allowed
    ) {
      throw new PluginAuditRateError(pluginId);
    }
  }

  /**
   * Spends one entry of the device's budget with the plugin, or refuses it.
   *
   * Keyed on the token's row, never its value, as the guard's budget for the
   * device's requests is.
   */
  private spendForDevice(pluginId: string, deviceTokenId: string): void {
    const perMinute = PLUGIN_AUDIT_LIMITS.perDevicePerMinute;
    if (
      !this.deviceBudgets.take(`${pluginId} ${deviceTokenId}`, perMinute)
        .allowed
    ) {
      throw new PluginAuditRateError(pluginId, "device");
    }
  }

  /**
   * Spends one entry of the plugin's own budget, or stops the plugin.
   */
  private spendOwn(pluginId: string): void {
    const perMinute = PLUGIN_AUDIT_LIMITS.perMinute;
    if (!this.stopped.has(pluginId)) {
      if (this.budgets.take(pluginId, perMinute).allowed) {
        return;
      }
      this.stopped.add(pluginId);
      this.logger.warn(
        `Plugin "${pluginId}" wrote more than ${String(perMinute)} audit ` +
          "entries with no request in a minute and was stopped.",
      );
      this.loader.refuse(pluginId, "audit-rate-exceeded", { perMinute });
    }
    throw new PluginHostUnavailableError(
      pluginId,
      `after writing more than ${String(perMinute)} audit entries with no ` +
        "request in a minute. The host stopped it until the next restart, " +
        "so that it cannot grow the append-only audit log without bound.",
    );
  }
}
