import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../i18n";
import { AddPersonPanel } from "./AddPersonPanel";

/**
 * The add-person form's faces.
 *
 * A class-string assertion is normally the wrong thing to test, and this file
 * deliberately asserts two tokens rather than a whole className: that the phone
 * field carries the register face, and that it still carries its ink colour.
 *
 * Both are DESIGN.md contracts rather than styling preferences - phone numbers
 * are register data and register data is "always mono" (the mono-grid rule), and
 * a field with no ink colour is unreadable - and neither is reachable from any
 * other kind of assertion. The class list is built by a template literal, so the
 * whole category of failure here is a concatenation mistake, which produces a
 * token that is not a utility at all. Nothing else in the toolchain notices one:
 * an unknown class is not an error to Tailwind, to oxlint or to prettier, so a
 * broken face ships with a green `pnpm verify`.
 *
 * The word boundaries carry the test. `text-inkfont-data` - one token, from a
 * missing space before the interpolation - matches neither `\bfont-data\b` nor
 * `\btext-ink\b`, which is exactly the failure this pins.
 */

vi.mock("./register-api", () => ({
  createPerson: vi.fn(),
}));

const noop = (): void => {
  /* intentionally empty */
};

function renderPanel() {
  return render(<AddPersonPanel onClose={noop} onAdded={noop} />);
}

describe("the add-person form", () => {
  it("enters a phone number in the register face, without losing its colour", () => {
    renderPanel();
    const phone = screen.getByLabelText("Telefonnummer");

    // Two tokens, word-bounded: a concatenation mistake fuses them into one
    // token that satisfies neither.
    expect(phone.className).toMatch(/\bfont-data\b/);
    expect(phone.className).toMatch(/\btext-ink\b/);
  });

  it("leaves a prose field in the UI face", () => {
    // The face is conditional, so the negative is what proves the condition is
    // doing something: a name is prose and belongs in the interface typeface.
    renderPanel();

    expect(screen.getByLabelText("Förnamn").className).not.toMatch(
      /\bfont-data\b/,
    );
  });
});
