import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { Dialog } from "./Dialog";

const CONTENT = "Innehåll";
const ACTION = "Skapa";

/**
 * The modal dialog: the browser's own element, named by its heading, and
 * closed through its parent so the two cannot disagree about whether it is
 * open.
 */
describe("a dialog", () => {
  it("is named by its title and shows its content and actions", () => {
    render(
      <Dialog
        title="Skriv ett inlägg"
        onClose={() => {}}
        actions={<button type="button">{ACTION}</button>}
      >
        <p>{CONTENT}</p>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Skriv ett inlägg" });
    expect(dialog.textContent).toContain("Innehåll");
    expect(screen.getByRole("button", { name: "Skapa" })).toBeTruthy();
  });

  it("asks its parent to close it on Escape, rather than closing itself", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Filtrera inlägg" onClose={onClose}>
        <p>{CONTENT}</p>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancel);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.hasAttribute("open")).toBe(true);
  });
});
