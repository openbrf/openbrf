import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import "../i18n";
import { BoardPage, BoardPageNote, BoardPageTitle } from "./BoardPage";

/**
 * The frame of one of the board's pages (ADR 0049).
 *
 * What is asserted is what a reader depends on: the page says whose it is in
 * its own heading, because the band's signs are not shown on a phone; it says
 * who sees it; and a page this account is not offered says so in one sentence
 * and shows no sign over an empty room.
 */

const CONTENT = "innehåll";
const REGISTER = "Medlemsförteckning";
const ISSUES = "Hantera ärenden";
const PAGE = "Sidan";
const INTRODUCTION = "Medlemmarna i föreningen.";
const BOARD_NOTE = "Det här ser bara styrelsen och administratören.";
const NOT_OFFERED =
  "Den här sidan är styrelsens. Ditt konto har inget att göra här.";

describe("the heading", () => {
  it("carries the sign in its accessible name", () => {
    render(
      <BoardPage title="Hantera bokningar" offered>
        <p>{CONTENT}</p>
      </BoardPage>,
    );

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Styrelsen Hantera bokningar",
      }),
    ).toBeTruthy();
    expect(screen.getByText(CONTENT)).toBeTruthy();
  });

  it("is the same heading for a screen that keeps its own header", () => {
    render(<BoardPageTitle>{REGISTER}</BoardPageTitle>);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Styrelsen Medlemsförteckning",
      }),
    ).toBeTruthy();
  });

  it("signs the issue queue for the board and the property manager both", () => {
    render(<BoardPageTitle audience="issueHandling">{ISSUES}</BoardPageTitle>);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Styrelse och förvaltare Hantera ärenden",
      }),
    ).toBeTruthy();
  });
});

describe("who sees it", () => {
  it.each([
    ["board", BOARD_NOTE],
    [
      "issueHandling",
      "Det här ser bara styrelsen, föreningens förvaltare och administratören.",
    ],
    ["administrator", "Det här ser bara administratören."],
  ] as const)("says it for the %s audience", (audience, note) => {
    render(
      <BoardPage title="Sidan" audience={audience} offered>
        <p>{CONTENT}</p>
      </BoardPage>,
    );

    expect(screen.getByText(note)).toBeTruthy();
  });

  it("says it under a screen's own heading as well, beside its introduction", () => {
    // A register or a settings-like screen keeps its own header and its own
    // sentence about what the page is for; who it is for is another sentence.
    render(
      <header>
        <BoardPageTitle>{REGISTER}</BoardPageTitle>
        <BoardPageNote />
        <p>{INTRODUCTION}</p>
      </header>,
    );

    expect(screen.getByText(BOARD_NOTE)).toBeTruthy();
    expect(screen.getByText(INTRODUCTION)).toBeTruthy();
  });

  it("gives way to the page's own sentence where it has a more exact one", () => {
    render(
      <BoardPage title="Sidan" description="Bara ordföranden." offered>
        <p>{CONTENT}</p>
      </BoardPage>,
    );

    expect(screen.getByText("Bara ordföranden.")).toBeTruthy();
    expect(screen.queryByText(BOARD_NOTE)).toBeNull();
  });
});

describe("a page this account is not offered", () => {
  it("says so in one sentence, with no sign, no heading and nothing of the page", () => {
    render(
      <BoardPage title="Hantera bokningar" offered={false}>
        <p>{CONTENT}</p>
      </BoardPage>,
    );

    expect(screen.getByText(NOT_OFFERED)).toBeTruthy();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText(BOARD_NOTE)).toBeNull();
    expect(screen.queryByText(CONTENT)).toBeNull();
  });
});

describe("the sign", () => {
  it("wears the brass for the board, and only for the board", () => {
    const { container, unmount } = render(
      <BoardPageTitle>{PAGE}</BoardPageTitle>,
    );
    expect(container.querySelector("h1 span")?.className).toContain(
      "border-trust",
    );
    unmount();

    for (const audience of ["issueHandling", "administrator"] as const) {
      const { container: other, unmount: done } = render(
        <BoardPageTitle audience={audience}>{PAGE}</BoardPageTitle>,
      );
      expect(other.querySelector("h1 span")?.className).not.toContain("trust");
      done();
    }
  });
});
