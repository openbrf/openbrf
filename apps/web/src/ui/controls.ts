/**
 * The control classes, in one place.
 *
 * These are the shapes DESIGN.md fixes: a 4px radius, a 40px control that grows
 * to the 44px minimum touch target, one shadow level, the trust accent reserved
 * for trust. Written once so a form on one screen cannot drift a pixel away
 * from the same form on another, and so a hardcoded colour has nowhere to hide.
 *
 * Every value resolves through a --obrf-* token via the Tailwind mapping in
 * index.css. The measurements are arithmetic for these controls, not tokens: a
 * theme changes colour, typeface, shape, motion, the logo and the view
 * variants, and nothing here widens that.
 */

/** Text input, select and textarea. min-h-11 is the 44px touch target. */
export const FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-raised px-3 text-body text-ink";

/** The data face, for anything that belongs on the mono grid. */
export const FIELD_DATA = `${FIELD} font-data`;

/** A field label: uppercase, letterspaced, the board's own lettering. */
export const LABEL =
  "flex flex-col gap-1.5 text-label uppercase text-ink-muted";

/** Help text under a field. Never the only carrier of a requirement. */
export const HINT = "text-small text-ink-muted";

/** The dark sign. The primary action on a screen, and only one per screen. */
export const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-control bg-ink px-4 text-small font-semibold text-page transition-colors duration-150 ease-out disabled:opacity-60";

/** Secondary action: the surface with a strong border. */
export const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-raised px-4 text-small font-semibold text-ink transition-colors duration-150 ease-out disabled:opacity-60";

/**
 * The trust action. Brass, and only for a position of trust or an act of
 * governance - never as decoration and never as "the important button".
 */
export const TRUST_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-control bg-trust px-4 text-small font-semibold text-on-trust transition-colors duration-150 ease-out hover:bg-trust-hover disabled:opacity-60";

/** Destructive action. */
export const DANGER_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-control bg-danger px-4 text-small font-semibold text-on-danger transition-colors duration-150 ease-out disabled:opacity-60";

/**
 * A quiet button that still meets the touch target: used for row actions like
 * removing a generated apartment row.
 */
export const QUIET_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-control border border-line px-3 text-small text-ink-muted transition-colors duration-150 ease-out hover:text-ink disabled:opacity-60";

/** A card in the room: one radius step up, one shadow level, no gradient. */
export const PANEL =
  "rounded-panel border border-line bg-raised p-5 shadow-raised";

/** The register surface, for anything that reads as register data. */
export const BOARD_PANEL =
  "rounded-panel border border-register-line bg-register p-4 text-register-ink";
