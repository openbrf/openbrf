/**
 * View variants: the one thing a theme may change about layout.
 *
 * A theme cannot ship components - that is what makes it data rather than code.
 * What it can do is pick among layouts the core maintains, so a cooperative
 * that wants its member register as cards on a phone gets that without anyone
 * loading third-party JavaScript into a statutory register.
 *
 * The registry below is the whole set. A theme naming a slot or a variant that
 * is not here is refused at install time rather than rendering nothing: an
 * unrecognised variant is a theme built against a core that is not this one.
 *
 * Phase 1 registers the member register with its `table` variant. The `cards`
 * variant is designed and not built; it is added here in the release that
 * builds it, which is a minor contract change and needs no theme to be rewritten
 * because the default stays where it is.
 */

export interface ViewVariantSlot {
  /** The view this slot selects a layout for. */
  slot: string;
  /** Every layout the core maintains for it, the default included. */
  variants: readonly string[];
  /** What renders when a theme says nothing. */
  defaultVariant: string;
}

export const VIEW_VARIANT_SLOTS = [
  {
    slot: "memberRegister",
    variants: ["table"],
    defaultVariant: "table",
  },
] as const satisfies readonly ViewVariantSlot[];

export type ViewVariantSlotName = (typeof VIEW_VARIANT_SLOTS)[number]["slot"];

export function viewVariantSlot(slot: string): ViewVariantSlot | undefined {
  return VIEW_VARIANT_SLOTS.find((entry) => entry.slot === slot);
}

export type ViewVariantSelection = Readonly<Record<string, string>>;

export interface ViewVariantProblem {
  slot: string;
  variant: string;
  reason: "unknown-slot" | "unknown-variant";
}

/** Every slot or variant in a theme's selection that the core does not have. */
export function viewVariantProblems(
  selection: ViewVariantSelection,
): ViewVariantProblem[] {
  const problems: ViewVariantProblem[] = [];

  for (const [slot, variant] of Object.entries(selection)) {
    const known = viewVariantSlot(slot);
    if (known === undefined) {
      problems.push({ slot, variant, reason: "unknown-slot" });
      continue;
    }
    if (!known.variants.includes(variant)) {
      problems.push({ slot, variant, reason: "unknown-variant" });
    }
  }

  return problems;
}

/**
 * The variant that renders for a slot.
 *
 * Falls back to the core default for a slot the active theme says nothing
 * about, and for a variant the core does not have. The second case should never
 * reach a running instance - the install lint refuses it - but a view asking
 * which layout to draw must always get an answer it can draw.
 */
export function resolveViewVariant(
  slot: string,
  selection: ViewVariantSelection | undefined,
): string | undefined {
  const known = viewVariantSlot(slot);
  if (known === undefined) {
    return undefined;
  }

  const chosen = selection?.[slot];
  return chosen !== undefined && known.variants.includes(chosen)
    ? chosen
    : known.defaultVariant;
}
