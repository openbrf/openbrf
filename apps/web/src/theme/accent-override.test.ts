import { afterEach, describe, expect, it } from "vitest";

import { applyAccentOverride } from "./accent-override";

/**
 * The per-association accent, applied to a running page.
 *
 * It has to be a stylesheet rather than inline styles on the root element: the
 * theme engine decides light and dark with a media query and a data attribute,
 * and inline styles have neither, so they would pin one mode's accent to both.
 */

const override = () => document.getElementById("openbrf-accent-override");

afterEach(() => {
  override()?.remove();
});

describe("applying a colour", () => {
  it("injects one stylesheet carrying the accent tokens", () => {
    applyAccentOverride("#2F6DB5");

    const element = override();
    expect(element).toBeTruthy();
    expect(element?.tagName).toBe("STYLE");
    expect(element?.textContent).toContain("--obrf-accent-trust:");
    expect(element?.textContent).toContain("--obrf-accent-trust-register:");
  });

  it("keeps the three blocks the theme engine needs", () => {
    applyAccentOverride("#2F6DB5");

    const css = override()?.textContent ?? "";
    expect(css).toContain(":root {");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("overrides only the accent, leaving the rest to the theme", () => {
    applyAccentOverride("#2F6DB5");

    const css = override()?.textContent ?? "";
    expect(css).not.toContain("--obrf-surface-page:");
    expect(css).not.toContain("--obrf-text-register:");
  });

  it("replaces the previous colour rather than stacking a second sheet", () => {
    applyAccentOverride("#2F6DB5");
    applyAccentOverride("#A03329");

    expect(document.querySelectorAll("#openbrf-accent-override")).toHaveLength(
      1,
    );
    expect(override()?.textContent).toContain("#a03329");
  });
});

describe("removing the override", () => {
  it("takes the stylesheet away for null", () => {
    applyAccentOverride("#2F6DB5");
    applyAccentOverride(null);

    expect(override()).toBeNull();
  });

  it("takes it away for an empty value", () => {
    applyAccentOverride("#2F6DB5");
    applyAccentOverride("");

    expect(override()).toBeNull();
  });
});

describe("a colour that cannot be read", () => {
  it("leaves the theme's own legible accent in place", () => {
    // The API refuses to store one, so this is the second line rather than the
    // first - and keeping a legible accent is the right failure: an association
    // has to be able to read its own register.
    applyAccentOverride("#2F6DB5");
    applyAccentOverride("#FFFFFF");

    expect(override()).toBeNull();
  });

  it("ignores a value that is not a colour at all", () => {
    applyAccentOverride("mässing");

    expect(override()).toBeNull();
  });
});
