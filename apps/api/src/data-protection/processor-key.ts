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
 * Five of them are fixed, because an instance has at most one of each: the mail
 * server it sends through, the SMS gateway, its file storage, whoever runs it,
 * and the mailbox the board mailbox collects from. The other three are open: one
 * key per installed plugin, one per connected app, and one per recipient the
 * board recorded itself.
 */

/** The recipients every instance has exactly one of. */
export const PROCESSOR_KEYS = [
  "smtp",
  "sms",
  "storage",
  "hosting",
  "mailbox",
] as const;

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

/**
 * The key for one client a member has connected.
 *
 * Built from the client row's own id rather than from the client id, which is
 * where this differs from the plugin key beside it. A client registering
 * through the metadata document flow presents a URL as its client id, and a URL
 * is not a path segment: a key built from one could not be addressed on the
 * route that records a classification, which is the only thing a key is for.
 */
export function connectedAppProcessorKey(clientRowId: string): string {
  return `connectedApp:${clientRowId}`;
}

/**
 * The id a client row carries, which its key is built from.
 *
 * Wider than the plugin id pattern above it and than the board-recorded key
 * below, on purpose: a plugin id is a name the contract fixes and a
 * board-recorded row carries an id this application generated, while a client
 * row is written by the provider and its id is whatever that generated. Every
 * character this admits is safe in a path segment, and it admits no dot and no
 * slash, so no key can name anything but a row.
 */
const CLIENT_ROW_ID = "[A-Za-z0-9_-]+";

export const processorKeySchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:smtp|sms|storage|hosting|mailbox|plugin:${PLUGIN_ID}|connectedApp:${CLIENT_ROW_ID}|external:[a-z0-9]+)$`,
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
  mailbox: "MAILBOX",
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

  /*
   * A connected app reads back as EXTERNAL, because that is what it is: a
   * recipient outside the instance that the association never engaged. The kind
   * is what an agreement row stores, and there is no narrower one - the enum
   * has a value for a plugin because a plugin runs inside this process, and an
   * app a member connected does not.
   */
  if (key.startsWith("connectedApp:")) {
    return { kind: "EXTERNAL", id: key.slice("connectedApp:".length) };
  }

  return { kind: "EXTERNAL", id: key.slice("external:".length) };
}
