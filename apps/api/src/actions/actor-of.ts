import type { ActionChannel, ActionContext } from "@openbrf/plugin-sdk";

import type { ActorContext } from "../audit/actor-context";
import type { AuditChannel } from "../generated/prisma/enums";

/**
 * The one conversion between the two channel vocabularies.
 *
 * They are deliberately different words for the same five things. The SDK's is
 * lowercase and is part of a contract published to plugin authors, so it cannot
 * be the database's enum - that would make every plugin's build depend on a
 * generated file inside the host. The Prisma enum is what the append-only log
 * stores and is uppercase like every other enum in the schema. The log has two
 * channels more, which no action arrives through: MANAGEMENT, because the
 * management API is not an action (ADR 0021), and SUPPORT, because a support
 * session changes nothing (ADR 0028).
 *
 * Keeping them apart costs this function; letting them be the same type would
 * cost the SDK a dependency it must not have. The spec beside this file asserts
 * the mapping is total over all five, so a value added to one and not the other
 * fails the build here rather than reaching a column that cannot be corrected.
 */
const CHANNELS: Record<ActionChannel, AuditChannel> = {
  web: "WEB",
  mcp: "MCP",
  ai: "AI",
  system: "SYSTEM",
  plugin: "PLUGIN",
};

/**
 * The action channel a stored channel was, read back from a row.
 *
 * The inverse of the mapping above, for the one row that keeps a channel to
 * act on it later: a pending change, whose confirmation is held to the arming
 * the channel it was proposed on needed (ADR 0039). Null for MANAGEMENT,
 * which no action arrives through.
 */
export function actionChannelOf(channel: AuditChannel): ActionChannel | null {
  const found = (Object.keys(CHANNELS) as ActionChannel[]).find(
    (key) => CHANNELS[key] === channel,
  );
  return found ?? null;
}

/**
 * What a write service is told about the caller of an action.
 *
 * Everything here comes from the caller handle the registry resolved, never
 * from an argument: the person, the way they reached the records, the
 * connected app that acted if one did, the plugin whose route dispatched if
 * one did, and the pending change the call confirms if it confirms one.
 */
export function actorOf(context: ActionContext): ActorContext {
  return {
    personId: context.principal.personId,
    channel: CHANNELS[context.channel],
    ...(context.client === undefined
      ? {}
      : {
          clientId: context.client.clientId,
          clientHost: context.client.clientHost,
        }),
    ...(context.pluginId === undefined ? {} : { pluginId: context.pluginId }),
    ...(context.pendingChangeId === undefined
      ? {}
      : { pendingChangeId: context.pendingChangeId }),
    requestId: context.requestId,
  };
}
