import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../i18n";
import { HONEYPOT_FIELD, HoneypotField } from "./HoneypotField";

/**
 * The decoy field, whose correctness is entirely a question of who can reach
 * it.
 *
 * A script has to find it, or it catches nothing. A person must not, by eye or
 * by keyboard or through a screen reader - because a resident who fills it in
 * has their request to the board dropped, and neither they nor the board is
 * ever told. That failure is invisible in any test that only looks at rendered
 * text, which is why it is pinned here.
 */
describe("the decoy field", () => {
  it("is in the page, where a script reading it will find it", () => {
    const { container } = render(<HoneypotField value="" onChange={vi.fn()} />);

    const decoy = container.querySelector(`input[name="${HONEYPOT_FIELD}"]`);

    expect(decoy).not.toBeNull();
  });

  it("is absent from the accessibility tree", () => {
    render(<HoneypotField value="" onChange={vi.fn()} />);

    // The role query is the accessibility tree's own view: an aria-hidden
    // subtree is not in it, so a screen reader has nothing here to announce.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("is hidden from the eye and from the keyboard", () => {
    const { container } = render(<HoneypotField value="" onChange={vi.fn()} />);

    const decoy = container.querySelector(`input[name="${HONEYPOT_FIELD}"]`);
    const wrapper = decoy?.parentElement;

    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
    // Visually hidden rather than display:none, so a script that reads the page
    // still finds a field to fill in.
    expect(wrapper?.className).toContain("sr-only");
    // Out of the tab order: nobody arrives here by pressing Tab through a form.
    expect(decoy?.getAttribute("tabindex")).toBe("-1");
    // Nothing a browser is willing to fill in on a resident's behalf.
    expect(decoy?.getAttribute("autocomplete")).toBe("off");
  });

  it("reports what filled it in", () => {
    const onChange = vi.fn();
    const { container } = render(
      <HoneypotField value="" onChange={onChange} />,
    );

    const decoy = container.querySelector(`input[name="${HONEYPOT_FIELD}"]`);
    if (decoy === null) {
      throw new Error("The decoy field was expected to be rendered.");
    }
    // Set the way a script sets it: straight onto the element, without a
    // pointer or a keyboard, neither of which reaches it.
    fireEvent.change(decoy, { target: { value: "https://example.invalid" } });

    expect(onChange).toHaveBeenCalledWith("https://example.invalid");
  });
});
