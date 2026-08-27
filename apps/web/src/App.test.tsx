import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import "./i18n";

describe("App", () => {
  it("renders the welcome heading through i18next", () => {
    render(<App />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Open BRF");
    expect(screen.getByText("Föreningen äger sin data")).toBeTruthy();
  });
});
