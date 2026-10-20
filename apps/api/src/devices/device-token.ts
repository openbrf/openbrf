import { randomBytes } from "node:crypto";

import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";

import type { PluginDeviceToken } from "../generated/prisma/client";

/**
 * The device token itself, and the rules on what is issued (ADR 0031).
 */

/**
 * What every device token starts with.
 *
 * For secret scanners and for a person reading a log line; nothing parses it.
 */
export const DEVICE_TOKEN_PREFIX = "obrf_dt_";

/** A new token: the prefix and 32 random bytes, in base64url. */
export function mintDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The plugin's handle on a device: what `current(request)` tells it. */
export const DEVICE_SUBJECT_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** The longest name the board may give a device. */
export const DEVICE_LABEL_MAX_LENGTH = 80;

/** How many live tokens one plugin may hold. */
export const MAX_LIVE_DEVICE_TOKENS = 200;

/**
 * How often `lastUsedAt` is written for one token.
 *
 * A screen polling every thirty seconds would otherwise write a row on every
 * call, and what the board reads off the column is the day a device was last
 * heard from, not the second.
 */
export const LAST_USED_INTERVAL_MS = 60_000;

/** A row as the plugin and the board see it. Never the digest. */
export function deviceTokenSummary(
  row: Pick<
    PluginDeviceToken,
    | "id"
    | "routeId"
    | "subject"
    | "label"
    | "issuedAt"
    | "lastUsedAt"
    | "revokedAt"
  >,
): DeviceTokenSummary {
  return {
    id: row.id,
    route: row.routeId,
    subject: row.subject,
    label: row.label,
    issuedAt: row.issuedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
