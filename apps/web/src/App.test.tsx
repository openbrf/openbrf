import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import "./i18n";
import { ThemeModeProvider } from "./theme/theme-mode-context";

function renderApp(): void {
  render(
    <ThemeModeProvider>
      <App />
    </ThemeModeProvider>,
  );
}

describe("App", () => {
  it("renders the welcome heading through i18next", () => {
    renderApp();

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Open BRF");
    expect(screen.getByText("Föreningen äger sin data")).toBeTruthy();
  });

  it("offers all three appearance choices", () => {
    renderApp();

    const options = screen.getAllByRole("radio");
    expect(options.map((option) => option.textContent)).toEqual([
      "System",
      "Ljust",
      "Mörkt",
    ]);
  });

  it("marks exactly one appearance choice as selected", () => {
    renderApp();

    const checked = screen
      .getAllByRole("radio")
      .filter((option) => option.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
  });

  it("names the protected state precisely on the row, not just as caution", () => {
    renderApp();

    // The legend entry describes what the colour means, which covers protected
    // data AND caution. A row must say which one it is.
    expect(screen.getByText("Skyddade personuppgifter")).toBeTruthy();
  });

  it("masks a protected resident's contact detail, in words", () => {
    renderApp();

    // Dots alone would leave a reader guessing whether the value is absent or
    // withheld. Name and apartment stay visible: identifying members against
    // apartments is what the statutory register is for.
    expect(screen.getByText(/maskerad/)).toBeTruthy();
    expect(screen.getByText("Sara Berg")).toBeTruthy();
    expect(screen.queryByText("070-555 12 34")).toBeNull();
  });

  it("keeps every register column reachable on a narrow screen", () => {
    renderApp();

    // The fixed columns exceed a 375px phone's width, so the board scrolls on
    // its own axis. Clipping them instead would silently hide part of a
    // statutory register from the board member reviewing it.
    const header = screen.getByText("Lgh").closest("div");
    const scroller = header?.parentElement;
    expect(scroller?.className).toContain("overflow-x-auto");
    expect(header?.className).toContain("min-w-");

    // And all four columns are actually rendered.
    for (const column of ["Lgh", "Namn", "Kontakt", "Inflytt"]) {
      expect(screen.getByText(column)).toBeTruthy();
    }
  });

  it("labels every legend entry, so colour is never the only signal", () => {
    renderApp();

    // Each semantic colour encodes one rule, and a reader who cannot
    // distinguish the hues still has to be able to read it.
    for (const label of [
      "Förtroendeuppdrag",
      "Bekräftat",
      "Skyddad / varsamhet",
      "Fara",
      "Information",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });
});
