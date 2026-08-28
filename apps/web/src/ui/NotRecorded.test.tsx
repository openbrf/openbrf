import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NotRecorded } from "./NotRecorded";

/**
 * The empty-cell marker, which has to say the same thing two ways.
 *
 * Both halves are pinned here rather than in each screen that uses it: a
 * register cell that says nothing to assistive technology reads as a value that
 * failed to load, and a dash announced once per row is noise. Getting either
 * half wrong is silent in every screen test that only looks at rendered text.
 */
describe("the empty-cell marker", () => {
  it("shows a dash that is not announced", () => {
    render(<NotRecorded meaning="Still held" />);

    const dash = screen.getByText("-");

    expect(dash.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces what the empty cell means", () => {
    render(<NotRecorded meaning="Still held" />);

    const announced = screen.getByText("Still held");

    // Present for a screen reader and absent for the eye: it carries the
    // visually-hidden class and is not marked aria-hidden.
    expect(announced.className).toContain("sr-only");
    expect(announced.getAttribute("aria-hidden")).toBeNull();
  });

  it("keeps the two halves apart", () => {
    // The dash and the sentence are separate elements. One element carrying
    // both would either announce the hyphen or hide the sentence.
    const { container } = render(<NotRecorded meaning="Still held" />);

    expect(container.textContent).toBe("-Still held");
    expect(container.querySelectorAll("span")).toHaveLength(2);
  });
});
