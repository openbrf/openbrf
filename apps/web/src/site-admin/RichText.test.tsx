import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

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

/** Puts the caret this many characters into the editor's one paragraph. */
function placeCaret(area: HTMLElement, offset: number): void {
  const text = area.querySelector("p")?.firstChild as Text;
  area.focus();
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

describe("a page with no room for another block", () => {
  it("starts no paragraph on a return, and says so", () => {
    const onChange = vi.fn();
    const onFull = vi.fn();
    render(
      <RichText
        runs={[{ text: "Hej." }]}
        onChange={onChange}
        label="Stycke"
        maxParagraphs={1}
        onFull={onFull}
      />,
    );
    const area = screen.getByLabelText("Stycke");

    placeCaret(area, 2);
    fireEvent.keyDown(area, { key: "Enter", code: "Enter", keyCode: 13 });

    expect(onFull).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(area.querySelectorAll("p")).toHaveLength(1);
    expect(area.textContent).toBe("Hej.");
  });

  it("joins pasted paragraphs it has no block for to the last that fits", async () => {
    // A paste scrolls the caret into view, and jsdom measures no ranges.
    Object.assign(Range.prototype, {
      getClientRects: () => [],
      getBoundingClientRect: () => new DOMRect(),
    });
    onTestFinished(() => {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    });
    const onChange = vi.fn();
    const onFull = vi.fn();
    render(
      <RichText
        runs={[{ text: "Hej." }]}
        onChange={onChange}
        label="Stycke"
        maxParagraphs={2}
        onFull={onFull}
      />,
    );
    const area = screen.getByLabelText("Stycke");

    placeCaret(area, 4);
    fireEvent.paste(area, {
      clipboardData: {
        types: ["text/plain"],
        getData: (type: string) =>
          type === "text/plain" ? "\n\nEtt.\n\nTvå.\n\nTre." : "",
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const [paragraphs] = onChange.mock.lastCall as [{ text: string }[][]];
    expect(
      paragraphs.map((runs) => runs.map((run) => run.text).join("")),
    ).toEqual(["Hej.", "Ett. Två. Tre."]);
    expect(onFull).toHaveBeenCalled();
    // What the editor goes on holding is the first paragraph, as after a return.
    expect(area.textContent).toBe("Hej.");
  });
});
