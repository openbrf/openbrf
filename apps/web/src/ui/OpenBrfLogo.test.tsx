import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "../i18n";
import { OpenBrfLogo } from "./OpenBrfLogo";

/**
 * The logo's two files and the classes that choose between them.
 *
 * index.css shows the element carrying `openbrf-logo-on-dark` on a dark page
 * and the one carrying `openbrf-logo-on-light` everywhere else. The stylesheet
 * does not know which file sits behind which class, so a swap here would put
 * dark ink on a dark page and pass every screen test that only asks whether a
 * logo is present.
 */
describe("the Open BRF logo", () => {
  it("pairs each file with the ground it was drawn for", () => {
    render(<OpenBrfLogo />);

    const [onLight, onDark] = screen.getAllByRole("img");

    expect(onLight?.getAttribute("src")).toMatch(
      /\/brand\/openbrf-lockup\.svg$/,
    );
    expect(onLight?.className).toContain("openbrf-logo-on-light");
    expect(onDark?.getAttribute("src")).toMatch(
      /\/brand\/openbrf-lockup-on-dark\.svg$/,
    );
    expect(onDark?.className).toContain("openbrf-logo-on-dark");
  });

  it("names the project on both, since either may be the one shown", () => {
    render(<OpenBrfLogo />);

    expect(screen.getAllByRole("img", { name: "Open BRF" })).toHaveLength(2);
  });
});
