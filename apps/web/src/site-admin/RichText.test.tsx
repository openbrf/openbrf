import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

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

/** An edit scrolls the caret into view, and jsdom measures no ranges. */
function measureRanges(): void {
  Object.assign(Range.prototype, {
    getClientRects: () => [],
    getBoundingClientRect: () => new DOMRect(),
  });
  onTestFinished(() => {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });
}

/**
 * Typing at the caret, which reaches the editor as a change to the text in the
 * page rather than as an event it handles.
 */
function typeAt(area: HTMLElement, offset: number, typed: string): void {
  measureRanges();
  placeCaret(area, offset);
  const text = area.querySelector("p")?.firstChild as Text;
  text.insertData(offset, typed);
}

/** A paste of plain text at the caret, as a clipboard event carries it. */
function pastePlain(area: HTMLElement, text: string): void {
  measureRanges();
  fireEvent.paste(area, {
    clipboardData: {
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

function textsOf(paragraphs: { text: string }[][]): string[] {
  return paragraphs.map((runs) => runs.map((run) => run.text).join(""));
}

describe("a paragraph at the length the server takes", () => {
  it("adds nothing typed past it, and says so", async () => {
    const onChange = vi.fn();
    const onLong = vi.fn();
    const full = "a".repeat(5000);
    render(
      <RichText
        runs={[{ text: full }]}
        onChange={onChange}
        label="Stycke"
        onLong={onLong}
      />,
    );
    const area = screen.getByLabelText("Stycke");

    typeAt(area, 5000, "b");

    await waitFor(() => {
      expect(onLong).toHaveBeenCalled();
    });
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(area.textContent).toBe(full);
    });
  });

  it("still takes a character typed below it", async () => {
    const onChange = vi.fn();
    const onLong = vi.fn();
    const almost = "a".repeat(4999);
    render(
      <RichText
        runs={[{ text: almost }]}
        onChange={onChange}
        label="Stycke"
        onLong={onLong}
      />,
    );
    const area = screen.getByLabelText("Stycke");

    typeAt(area, 4999, "b");

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const [paragraphs] = onChange.mock.lastCall as [{ text: string }[][]];
    expect(textsOf(paragraphs)).toEqual([`${almost}b`]);
    expect(onLong).not.toHaveBeenCalled();
  });

  it("cuts a paste to what fits and keeps the text after the caret", async () => {
    const onChange = vi.fn();
    const onLong = vi.fn();
    const after = "b".repeat(4980);
    render(
      <RichText
        runs={[{ text: `Hej.${after}` }]}
        onChange={onChange}
        label="Stycke"
        onLong={onLong}
      />,
    );
    const area = screen.getByLabelText("Stycke");

    placeCaret(area, 4);
    pastePlain(area, "x".repeat(100));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const [paragraphs] = onChange.mock.lastCall as [{ text: string }[][]];
    expect(textsOf(paragraphs)).toEqual([`Hej.${"x".repeat(16)}${after}`]);
    expect(onLong).toHaveBeenCalled();
    expect(area.textContent).toHaveLength(5000);
  });

  it("cuts a paste before a pair it would split, not through it", async () => {
    const onChange = vi.fn();
    const onLong = vi.fn();
    render(
      <RichText runs={[]} onChange={onChange} label="Stycke" onLong={onLong} />,
    );
    const area = screen.getByLabelText("Stycke");

    placeCaret(area, 0);
    pastePlain(area, `${"x".repeat(4999)}\u{1F600}`);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const [paragraphs] = onChange.mock.lastCall as [{ text: string }[][]];
    // The emoji is two units and only one fits, so it goes whole.
    expect(textsOf(paragraphs)).toEqual(["x".repeat(4999)]);
    expect(onLong).toHaveBeenCalled();
  });

  it("cuts each pasted paragraph that would become too long a block", async () => {
    const onChange = vi.fn();
    const onLong = vi.fn();
    render(
      <RichText
        runs={[{ text: "Hej." }]}
        onChange={onChange}
        label="Stycke"
        onLong={onLong}
      />,
    );
    const area = screen.getByLabelText("Stycke");

    placeCaret(area, 4);
    pastePlain(area, `${"x".repeat(6000)}\n\n${"y".repeat(5100)}\n\nTre.`);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const [paragraphs] = onChange.mock.lastCall as [{ text: string }[][]];
    expect(textsOf(paragraphs)).toEqual([
      `Hej.${"x".repeat(4996)}`,
      "y".repeat(5000),
      "Tre.",
    ]);
    expect(onLong).toHaveBeenCalledWith([0, 1]);
  });

  it("holds pasted paragraphs joined on a full page to the same length", async () => {
    const onChange = vi.fn();
    const onLong = vi.fn();
    render(
      <RichText
        runs={[{ text: "Hej." }]}
        onChange={onChange}
        label="Stycke"
        maxParagraphs={1}
        onLong={onLong}
      />,
    );
    const area = screen.getByLabelText("Stycke");

    placeCaret(area, 4);
    pastePlain(area, `${"x".repeat(3000)}\n\n${"y".repeat(3000)}`);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const [paragraphs] = onChange.mock.lastCall as [{ text: string }[][]];
    expect(textsOf(paragraphs)).toEqual([
      `Hej.${"x".repeat(3000)} ${"y".repeat(1995)}`,
    ]);
    expect(onLong).toHaveBeenCalled();
  });
});
