import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import "./i18n";
import { ThemeModeProvider } from "./theme/theme-mode-context";

/** Rows in the sample register; the header row is counted separately. */
const SAMPLE_ROW_COUNT = 2;

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

    // The accessible name comes from the wrapping label, since the input itself
    // is visually hidden and the styled span carries the text.
    const options = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(options.map((option) => option.labels?.[0]?.textContent)).toEqual([
      "System",
      "Ljust",
      "Mörkt",
    ]);
  });

  it("marks exactly one appearance choice as selected", () => {
    renderApp();

    const checked = screen
      .getAllByRole("radio")
      .filter((option) => (option as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
  });

  it("uses one named native radio group, so the browser drives the keyboard", () => {
    renderApp();

    const options = screen.getAllByRole("radio") as HTMLInputElement[];

    // Arrow keys, Home, End and a single tab stop come from the platform for
    // named radio inputs. Styled buttons with role="radio" would look the same
    // and oblige us to reimplement all of it, so this asserts the shape that
    // gives us the behaviour rather than the behaviour itself, which jsdom does
    // not implement.
    expect(options.every((option) => option.tagName === "INPUT")).toBe(true);
    expect(new Set(options.map((option) => option.name))).toEqual(
      new Set(["theme-mode"]),
    );
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

    // The fixed columns exceed a 375px phone's width, so the table scrolls on
    // its own axis. Clipping them instead would silently hide part of a
    // statutory register from the board member reviewing it.
    const table = screen.getByRole("table");
    expect(table.className).toContain("min-w-");
    expect(table.parentElement?.className).toContain("overflow-x-auto");
  });

  it("gives the register real table semantics", () => {
    renderApp();

    // A div grid looks identical and tells a screen reader nothing: without
    // column headers a reader cannot tie a contact or a date to its column.
    // The register is the one view where that is not acceptable.
    expect(screen.getByRole("table")).toBeTruthy();
    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual(["Lgh", "Namn", "Kontakt", "Inflytt"]);
    expect(screen.getAllByRole("row")).toHaveLength(SAMPLE_ROW_COUNT + 1);

    // Every column header is scoped, which is what associates it with its
    // column rather than leaving the reader to guess.
    for (const header of screen.getAllByRole("columnheader")) {
      expect(header.getAttribute("scope")).toBe("col");
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
