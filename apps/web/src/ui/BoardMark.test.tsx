import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import "../i18n";
import { BoardControls, BoardMark } from "./BoardMark";

/**
 * The one mark a board member learns for "only we see this".
 *
 * What is asserted is what a reader depends on: a group of controls is
 * announced by whose they are, the property manager's shared queue is not
 * signed as the board's alone, and brass stays on the board's sign only - the
 * one position of trust among the three.
 */

const EDIT = "Redigera";

describe("the sign", () => {
  it("wears the brass for the board, and only for the board", () => {
    const { container, unmount } = render(<BoardMark />);
    expect(container.firstElementChild?.className).toContain("border-trust");
    unmount();

    for (const audience of ["issueHandling", "administrator"] as const) {
      const { container: other, unmount: done } = render(
        <BoardMark audience={audience} />,
      );
      expect(other.firstElementChild?.className).not.toContain("trust");
      done();
    }
  });

  it("names a group of controls inside content everybody reads", () => {
    render(
      <BoardControls>
        <button type="button">{EDIT}</button>
      </BoardControls>,
    );

    const group = screen.getByRole("group", { name: "Styrelsen" });
    expect(within(group).getByRole("button", { name: EDIT })).toBeTruthy();
  });

  it("signs the issue queue for the board and the property manager both", () => {
    render(
      <BoardControls audience="issueHandling">
        <button type="button">{EDIT}</button>
      </BoardControls>,
    );

    expect(
      screen.getByRole("group", { name: "Styrelse och förvaltare" }),
    ).toBeTruthy();
  });
});
