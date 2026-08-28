import { describe, expect, it } from "vitest";

import {
  resolveViewVariant,
  VIEW_VARIANT_SLOTS,
  viewVariantProblems,
} from "./view-variants.ts";

/**
 * View variants are the one layout decision a theme may take. The mechanism is
 * what phase 1 proves: a registry of slots the core maintains, a refusal for
 * anything outside it, and a resolution that always returns something a view
 * can actually draw.
 */

describe("VIEW_VARIANT_SLOTS", () => {
  it("registers the member register with its table variant", () => {
    const slot = VIEW_VARIANT_SLOTS.find(
      (entry) => entry.slot === "memberRegister",
    );
    expect(slot?.variants).toContain("table");
    expect(slot?.defaultVariant).toBe("table");
  });
});

describe("viewVariantProblems", () => {
  it("finds nothing wrong with a registered variant", () => {
    expect(viewVariantProblems({ memberRegister: "table" })).toEqual([]);
  });

  it("names a slot the core does not have", () => {
    expect(viewVariantProblems({ dashboard: "grid" })).toEqual([
      { slot: "dashboard", variant: "grid", reason: "unknown-slot" },
    ]);
  });

  it("names a variant the core does not maintain", () => {
    // `cards` is designed and not built. A theme asking for it is built against
    // a core that is not this one, and installing it would render nothing.
    expect(viewVariantProblems({ memberRegister: "cards" })).toEqual([
      { slot: "memberRegister", variant: "cards", reason: "unknown-variant" },
    ]);
  });
});

describe("resolveViewVariant", () => {
  it("returns what the theme chose", () => {
    expect(
      resolveViewVariant("memberRegister", { memberRegister: "table" }),
    ).toBe("table");
  });

  it("falls back to the core default when the theme says nothing", () => {
    expect(resolveViewVariant("memberRegister", {})).toBe("table");
    expect(resolveViewVariant("memberRegister", undefined)).toBe("table");
  });

  /*
   * The install lint refuses an unknown variant, so this should never reach a
   * running instance. A view asking which layout to draw must still get an
   * answer it can draw.
   */
  it("falls back rather than returning a variant that cannot render", () => {
    expect(
      resolveViewVariant("memberRegister", { memberRegister: "cards" }),
    ).toBe("table");
  });

  it("returns undefined for a slot the core does not have", () => {
    expect(
      resolveViewVariant("dashboard", { dashboard: "grid" }),
    ).toBeUndefined();
  });
});
