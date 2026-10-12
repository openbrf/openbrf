import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../i18n";
import RichText from "./RichText";

/**
 * The editor itself, for the one thing the screen around it cannot see: what
 * the editor that was split goes on holding.
 */
describe("a return in the editor", () => {
  it("leaves the editor holding the first paragraph and reports the rest", async () => {
    const onChange = vi.fn();
    render(
      <RichText runs={[{ text: "Hej." }]} onChange={onChange} label="Stycke" />,
    );
    const area = screen.getByLabelText("Stycke");

    // The caret at the end of the text, then a return.
    const text = area.querySelector("p")?.firstChild as Text;
    area.focus();
    const range = document.createRange();
    range.setStart(text, 4);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(area, { key: "Enter", code: "Enter", keyCode: 13 });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([[{ text: "Hej." }], []], {
        paragraph: 1,
        offset: 0,
      });
    });
    expect(area.querySelectorAll("p")).toHaveLength(1);
    expect(area.textContent).toBe("Hej.");
  });
});
