/**
 * How long an administrator may open support access (supportåtkomst) for, in
 * hours, and how long the reason they give may be (ADR 0028).
 *
 * Here rather than beside the schema that enforces them, because the settings
 * form offers the same choices: one hour, eight hours, one day, three days or
 * seven days, and seven days is the most.
 */
export const SUPPORT_ACCESS_HOURS = [1, 8, 24, 72, 168] as const;

export type SupportAccessHours = (typeof SUPPORT_ACCESS_HOURS)[number];

/** The longest reason an administrator may give, in characters. */
export const SUPPORT_REASON_MAX_LENGTH = 500;
