import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssuePlaceCount } from "../api/issues";
import { IssuePlaceCountsPanel } from "./IssuePlaceCountsPanel";

const PLACES: readonly IssuePlaceCount[] = [
  { id: "p-lift", name: "Hiss", active: true, issues: 3, open: 2 },
  { id: "p-yard", name: "Gård", active: true, issues: 0, open: 0 },
];

describe("the issues per common area", () => {
  it("counts each place, closed issues included", () => {
    render(
      <IssuePlaceCountsPanel places={PLACES} selected="" onSelect={vi.fn()} />,
    );

    expect(screen.getByText("Hiss")).toBeTruthy();
    expect(screen.getByText("3 ärenden, 2 öppna")).toBeTruthy();
    expect(screen.getByText("0 ärenden, 0 öppna")).toBeTruthy();
  });

  it("narrows the queue to a place, and back", async () => {
    const session = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(
      <IssuePlaceCountsPanel places={PLACES} selected="" onSelect={onSelect} />,
    );

    await session.click(screen.getByRole("button", { name: "Visa bara Hiss" }));
    expect(onSelect).toHaveBeenCalledWith("p-lift");

    rerender(
      <IssuePlaceCountsPanel
        places={PLACES}
        selected="p-lift"
        onSelect={onSelect}
      />,
    );
    await session.click(screen.getByRole("button", { name: "Visa alla" }));
    expect(onSelect).toHaveBeenLastCalledWith("");
  });

  it("offers no way to narrow to a place nothing names", () => {
    render(
      <IssuePlaceCountsPanel places={PLACES} selected="" onSelect={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: "Visa bara Gård" })).toBeNull();
  });

  it("is not drawn while the association keeps no places", () => {
    const { container } = render(
      <IssuePlaceCountsPanel places={[]} selected="" onSelect={vi.fn()} />,
    );

    expect(container.textContent).toBe("");
  });
});
