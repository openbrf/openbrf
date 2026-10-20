import type { AuditChannelName } from "@openbrf/shared";

import type { TranslationKey } from "../i18n/translation-key";

/**
 * Which way each act reached the records, in the association's own words.
 *
 * The null case is its own sentence rather than a blank: an entry written
 * before the log recorded the channel is not an entry with nothing to say about
 * it, and a blank cell on a statutory document reads as though nothing
 * happened. NotRecorded says the narrow true thing instead.
 *
 * Read by the data subject access report and by the pending-change screen,
 * which says which way a change was proposed.
 */
export const AUDIT_CHANNEL_LABEL = {
  WEB: "register.person.report.channel.WEB",
  MCP: "register.person.report.channel.MCP",
  AI: "register.person.report.channel.AI",
  SYSTEM: "register.person.report.channel.SYSTEM",
  PLUGIN: "register.person.report.channel.PLUGIN",
  MANAGEMENT: "register.person.report.channel.MANAGEMENT",
} as const satisfies Record<AuditChannelName, TranslationKey>;
