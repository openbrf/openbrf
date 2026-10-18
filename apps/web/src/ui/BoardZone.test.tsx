import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import "../i18n";
import { BoardControls, BoardMark, BoardZone } from "./BoardZone";

/**
 * The one mark a board member learns for "only we see this".
 *
 * What is asserted is what a reader depends on: the zone is announced by whose
 * work it is and what it is for, the property manager's shared queue is not
 * signed as the board's alone, and brass stays on the board's sign only - the
 * one position of trust among the three.
 */

const CONTENT = "innehåll";
const EDIT = "Redigera";

describe("the zone", () => {
  it("is a landmark named by its sign and its title", () => {
    render(
      <BoardZone title="Hantera bokningar">
        <p>{CONTENT}</p>
      </BoardZone>,
    );

    const zone = screen.getByRole("region", {
      name: "Styrelsen Hantera bokningar",
    });
    expect(within(zone).getByText(CONTENT)).toBeTruthy();
    expect(
      within(zone).getByRole("heading", {
        level: 2,
        name: "Hantera bokningar",
      }),
    ).toBeTruthy();
  });

  it("says who sees it, unless the screen says it more exactly", () => {
    const { unmount } = render(
      <BoardZone title="Hantera bokningar">
        <p>{CONTENT}</p>
      </BoardZone>,
    );
    expect(
      screen.getByText("Det här ser bara styrelsen och administratören."),
    ).toBeTruthy();
    unmount();

    render(
      <BoardZone title="Hantera bokningar" description="Bara ordföranden.">
        <p>{CONTENT}</p>
      </BoardZone>,
    );
    expect(
      screen.queryByText("Det här ser bara styrelsen och administratören."),
    ).toBeNull();
    expect(screen.getByText("Bara ordföranden.")).toBeTruthy();
  });

  it("signs the issue queue for the board and the property manager both", () => {
    render(
      <BoardZone title="Hantera ärenden" audience="issueHandling">
        <p>{CONTENT}</p>
      </BoardZone>,
    );

    expect(
      screen.getByRole("region", {
        name: "Styrelse och förvaltare Hantera ärenden",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Det här ser bara styrelsen, föreningens förvaltare och administratören.",
      ),
    ).toBeTruthy();
  });
});

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
});
