import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import "../i18n";
import type { AdminPage } from "../api/site";
import { PageEditor } from "./PageEditor";

/**
 * The page editor with the real text editor in it, for what only the two
 * together can show: which paragraph a notice about held text is given at,
 * and what it advises the board to do about it.
 */

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

/** The text editor is loaded on demand, which a busy machine can make slow. */
const LOADED = { timeout: 5000 };

function pageOf(paragraphs: string[]): AdminPage {
  return {
    id: "page-1",
    slug: "hem",
    title: "Valkommen",
    content: {
      version: 1,
      blocks: paragraphs.map((text) => ({
        type: "paragraph" as const,
        runs: [{ text }],
      })),
    },
    visibility: "PUBLIC",
    published: true,
    publishedAt: "2026-08-29T09:00:00.000Z",
    sortOrder: 0,
    revision: 1,
    updatedAt: "2026-08-29T09:00:00.000Z",
  };
}

/** A paste scrolls the caret into view, and jsdom measures no ranges. */
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

function pasteAtEnd(area: HTMLElement, text: string): void {
  measureRanges();
  const node = area.querySelector("p")?.firstChild as Text;
  area.focus();
  const range = document.createRange();
  range.setStart(node, node.data.length);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  fireEvent.paste(area, {
    clipboardData: {
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

function renderEditor(page: AdminPage) {
  return render(
    <PageEditor page={page} onChanged={vi.fn()} onRemoved={vi.fn()} />,
  );
}

describe("a paste cut in the page editor", () => {
  it("says so at the new paragraph it cut, though the one pasted into is short", async () => {
    renderEditor(pageOf(["Kort"]));
    const area = await screen.findByLabelText("Stycke 1", {}, LOADED);

    pasteAtEnd(area, `\n\n${"x".repeat(6000)}`);

    const second = await screen.findByLabelText("Stycke 2", {}, LOADED);
    expect(second.textContent).toHaveLength(5000);
    const notices = await screen.findAllByText(
      /Ett stycke rymmer högst 5000 tecken/,
    );
    expect(notices).toHaveLength(1);
    // The notice follows the paragraph that was cut, not the short one.
    const after = second.closest("li");
    expect(after?.textContent).toMatch(/Ett stycke rymmer högst 5000 tecken/);
    expect(
      screen.getByLabelText("Stycke 1").closest("li")?.textContent,
    ).not.toMatch(/Ett stycke rymmer/);
  });

  it("still says so when a pair cut whole leaves the paragraph a unit short, until the next change that is kept", async () => {
    renderEditor(pageOf(["x".repeat(4999)]));
    const area = await screen.findByLabelText("Stycke 1", {}, LOADED);

    pasteAtEnd(area, "\u{1F600}");

    await screen.findByText(/Ett stycke rymmer högst 5000 tecken/, {}, LOADED);
    expect(screen.getByLabelText("Stycke 1").textContent).toHaveLength(4999);

    pasteAtEnd(screen.getByLabelText("Stycke 1"), "y");

    await waitFor(() => {
      expect(
        screen.queryByText(/Ett stycke rymmer högst 5000 tecken/),
      ).toBeNull();
    });
    expect(screen.getByLabelText("Stycke 1").textContent).toHaveLength(5000);
  });

  it("advises a new paragraph where the page has room for one", async () => {
    renderEditor(pageOf(["Kort"]));
    const area = await screen.findByLabelText("Stycke 1", {}, LOADED);

    pasteAtEnd(area, "x".repeat(6000));

    await waitFor(() => {
      expect(screen.getByText(/Börja ett nytt stycke/)).toBeDefined();
    });
  });

  it("advises removing a block where a full page has no room for another paragraph", async () => {
    const full = pageOf(Array.from({ length: 200 }, () => "Text."));
    renderEditor(full);
    const area = await screen.findByLabelText("Stycke 1", {}, LOADED);

    pasteAtEnd(area, "x".repeat(6000));

    const notice = await screen.findByText(
      /Ett stycke rymmer högst 5000/,
      {},
      LOADED,
    );
    expect(notice.textContent).toMatch(/ta bort ett block/);
    expect(notice.textContent).not.toMatch(/Börja ett nytt stycke/);
    // Two hundred text editors are slow to render on a busy machine.
  }, 15_000);
});
