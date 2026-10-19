import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { FilterDialog } from "./FilterDialog";

/**
 * "Filtrera inlägg": the board's posts, the neighbours', or the important ones,
 * applied together once the reader has chosen.
 */
describe("the filter", () => {
  it("applies what was chosen, together", async () => {
    const onApply = vi.fn();
    render(
      <FilterDialog
        value={{ from: null, important: false }}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Filtrera inlägg" });

    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Styrelsen" }),
    );
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Bara viktiga inlägg" }),
    );
    expect(onApply).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Visa inläggen" }),
    );

    expect(onApply).toHaveBeenCalledWith({ from: "board", important: true });
  });

  it("starts from the filter in force, and clears it", async () => {
    const onApply = vi.fn();
    render(
      <FilterDialog
        value={{ from: "neighbours", important: true }}
        onApply={onApply}
        onClose={() => {}}
      />,
    );

    expect(
      (screen.getByRole("radio", { name: "Grannar" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Rensa filtret" }),
    );

    expect(onApply).toHaveBeenCalledWith({ from: null, important: false });
  });
});
