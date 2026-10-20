import type { BlockIcon } from "@openbrf/shared";
import type { ReactElement } from "react";

/**
 * The pictures the page editor draws: one for each kind of block, and one for
 * each thing the editor does to a block.
 *
 * A block's definition names its picture rather than carrying one, so the
 * definition holds no markup; this is where the names become drawings, in
 * the current text colour so a theme colours them with everything else.
 * Lines on a 24-unit grid, and never the only thing that says what a control
 * does: every control that shows one also has words, visible or read out.
 */

/** What the editor does to a block. */
export type EditorAction =
  "add" | "drag" | "moveUp" | "moveDown" | "duplicate" | "remove" | "undo";

const PATHS: Readonly<Record<BlockIcon | EditorAction, readonly string[]>> = {
  paragraph: ["M4 6h16", "M4 10h16", "M4 14h16", "M4 18h10"],
  heading: ["M6 4v16", "M18 4v16", "M6 12h12"],
  image: [
    "M4 5h16v14H4z",
    "M4 16l5-5 4 4 2-2 5 5",
    "M15.5 9.5a1.5 1.5 0 1 0 0-.01",
  ],
  form: ["M4 5h16v4H4z", "M4 12h16v4H4z", "M4 19h7"],
  news: ["M4 5h13v14H4z", "M17 9h3v8a2 2 0 0 1-2 2", "M7 9h7", "M7 13h7"],
  calendar: ["M4 6h16v14H4z", "M4 10h16", "M8 3v5", "M16 3v5"],
  documents: ["M6 3h9l4 4v14H6z", "M15 3v4h4", "M9 12h7", "M9 16h7"],
  people: [
    "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M3 20a6 6 0 0 1 12 0",
    "M16 5a3 3 0 0 1 0 6",
    "M17 14a6 6 0 0 1 4 6",
  ],
  facts: ["M4 5h16v14H4z", "M9 5v14", "M4 10h16", "M4 15h16"],
  contact: ["M4 6h16v12H4z", "M4 6l8 7 8-7"],
  questions: [
    "M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .8-1 1.5V14",
    "M12 18h.01",
    "M4 4h16v16H4z",
  ],
  banner: ["M3 4h18v9H3z", "M6 16h12", "M8 20h8"],
  columns: ["M4 5h7v14H4z", "M13 5h7v14h-7z"],
  button: ["M4 8h16v8H4z", "M9 12h6"],
  imageText: ["M3 6h8v12H3z", "M14 7h7", "M14 11h7", "M14 15h7", "M14 19h4"],
  plugin: ["M9 3v4", "M15 3v4", "M6 7h12v5a6 6 0 0 1-12 0z", "M12 18v3"],
  add: ["M12 5v14", "M5 12h14"],
  drag: [
    "M9 6h.01",
    "M15 6h.01",
    "M9 12h.01",
    "M15 12h.01",
    "M9 18h.01",
    "M15 18h.01",
  ],
  moveUp: ["M12 19V5", "M6 11l6-6 6 6"],
  moveDown: ["M12 5v14", "M6 13l6 6 6-6"],
  duplicate: ["M8 8h12v12H8z", "M4 16V4h12"],
  remove: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  undo: ["M9 14L4 9l5-5", "M4 9h11a5 5 0 0 1 0 10h-3"],
};

/** One of the editor's pictures, hidden from a screen reader. */
export function EditorIcon({
  name,
}: {
  name: BlockIcon | EditorAction;
}): ReactElement {
  const strong = name === "drag";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={strong ? 3 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
