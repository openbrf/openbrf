import { z } from "zod";

import type { ProcessorKind } from "../generated/prisma/enums";

/**
 * The stable identity of one recipient of personal data.
 *
 * A classification and the agreement covering it are facts about a recipient
 * over time, not about a row: the SMTP server keeps being the SMTP server when
 * its host name changes, and a plugin keeps being the same plugin across a
 * reinstall that rewrites its installed_plugin row. So a recipient is addressed
 * by a key built from what it *is* rather than by a database id, and the key is
 * what a dated agreement row points at.
 *
 * Four of them are fixed, because an instance has exactly one of each: the mail
 * server it sends through, the SMS gateway, its file storage, and whoever runs
 * it. The other two are open: one key per installed plugin, and one per
 * recipient the board recorded itself.
 */

/** The recipients every instance has exactly one of. */
export const PROCESSOR_KEYS = ["smtp", "sms", "storage", "hosting"] as const;

export type FixedProcessorKey = (typeof PROCESSOR_KEYS)[number];

/**
 * The plugin id pattern the plugin contract defines. Repeated here rather than
 * imported, because this file may not depend on the plugin SDK and a key is
 * validated at the controller before anything is looked up.
 */
const PLUGIN_ID = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";

export function pluginProcessorKey(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export function externalProcessorKey(rowId: string): string {
  return `external:${rowId}`;
}

export const processorKeySchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:smtp|sms|storage|hosting|plugin:${PLUGIN_ID}|external:[a-z0-9]+)$`,
    ),
  );

export type ParsedProcessorKey =
  | { kind: Exclude<ProcessorKind, "PLUGIN" | "EXTERNAL"> }
  | { kind: "PLUGIN"; pluginId: string }
  | { kind: "EXTERNAL"; id: string };

const FIXED_KINDS: Record<FixedProcessorKey, ProcessorKind> = {
  smtp: "SMTP",
  sms: "SMS",
  storage: "STORAGE",
  hosting: "HOSTING",
};

/**
 * Reads a key back into what it names, or null when it names nothing.
 *
 * Null rather than a throw: a key arrives from a URL, and a request for a
 * recipient that cannot exist is a 404 the controller answers rather than an
 * error the server logs.
 */
export function parseProcessorKey(key: string): ParsedProcessorKey | null {
  if (!processorKeySchema.safeParse(key).success) {
    return null;
  }

  const fixed = FIXED_KINDS[key as FixedProcessorKey];
  if (fixed !== undefined) {
    return { kind: fixed as Exclude<ProcessorKind, "PLUGIN" | "EXTERNAL"> };
  }

  const pluginId = key.startsWith("plugin:")
    ? key.slice("plugin:".length)
    : null;
  if (pluginId !== null) {
    return { kind: "PLUGIN", pluginId };
  }

  return { kind: "EXTERNAL", id: key.slice("external:".length) };
}
