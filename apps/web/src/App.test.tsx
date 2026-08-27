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
