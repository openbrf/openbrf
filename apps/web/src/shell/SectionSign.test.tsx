import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { NavItem, OfferedSection } from "./nav-items";
import { SectionSign } from "./SectionSign";

/** The page this stand-in router is on. */
const PATHNAME = "/meetings";

/**
 * The router's Link needs a router this test has no use for, so it becomes an
 * anchor. It keeps what the real one contributes here: the press, and
 * aria-current="page" on the link to the page itself.
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
    onClick,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    onClick?: () => void;
  }): ReactElement => (
    <a
      href={to}
      className={className}
      aria-current={to === PATHNAME ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
  useLocation: ({
    select,
  }: {
    select: (value: { pathname: string }) => string;
  }): string => select({ pathname: PATHNAME }),
}));

const MEETINGS: NavItem = {
  to: "/meetings",
  labelKey: "meetings.navLabel",
  section: "board",
};
const FEES: NavItem = {
  to: "/fees",
  labelKey: "fees.navLabel",
  section: "board",
};
const ISSUES: NavItem = {
  to: "/issues",
  labelKey: "issues.navLabel",
  section: "building",
};

const MOTIONS: NavItem = {
  to: "/motions",
  labelKey: "motions.navLabel",
  section: "board",
  parent: "/meetings",
};

/** The board's section as the band offers it: the front page, then groups. */
const FRONT: NavItem = {
  to: "/board",
  labelKey: "board.front.title",
  section: "board",
};
const ISSUE_QUEUE: NavItem = {
  to: "/board/issues",
  labelKey: "issues.boardTitle",
  section: "board",
  group: "queues",
};
const MAILBOX: NavItem = {
  to: "/board-mailbox",
  labelKey: "boardMailbox.navLabel",
  section: "board",
  group: "queues",
};
const BOARD_FEES: NavItem = {
  to: "/fees",
  labelKey: "fees.navLabel",
  section: "board",
  group: "money",
};
const GROUPED: OfferedSection = {
  id: "board",
  labelKey: "nav.sections.board",
  items: [FRONT, ISSUE_QUEUE, MAILBOX, BOARD_FEES],
};

const BOARD: OfferedSection = {
  id: "board",
  labelKey: "nav.sections.board",
  items: [MEETINGS, FEES],
};
const BUILDING_OF_ONE: OfferedSection = {
  id: "building",
  labelKey: "nav.sections.building",
  items: [ISSUES],
};

function renderSign(section: OfferedSection, current?: NavItem, atEnd = false) {
  return render(
    <ul>
      <SectionSign section={section} current={current} atEnd={atEnd} />
    </ul>,
  );
}

const sign = () => screen.getByRole("button", { name: /Styrelsen/ });
const open = () => {
  fireEvent.click(sign());
};

describe("SectionSign", () => {
  it("is the destination's own link when the section holds one", () => {
    const { container } = renderSign(BUILDING_OF_ONE);

    const link = screen.getByRole("link", { name: "Ärenden" });
    expect(link.getAttribute("href")).toBe("/issues");
    expect(link.hasAttribute("aria-expanded")).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
    // No chevron: the sign goes somewhere rather than opening something.
    expect(container.querySelector("svg")).toBeNull();
  });

  it("opens its destinations under it, and names the panel only while it exists", () => {
    renderSign(BOARD);

    expect(sign().getAttribute("aria-expanded")).toBe("false");
    expect(sign().hasAttribute("aria-controls")).toBe(false);
    expect(screen.queryByRole("link")).toBeNull();

    open();

    expect(sign().getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(
      sign().getAttribute("aria-controls") ?? "",
    );
    expect(panel?.tagName).toBe("UL");
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      ["Stämmor", "Avgifter"],
    );
    for (const link of screen.getAllByRole("link")) {
      expect(panel?.contains(link)).toBe(true);
    }
  });

  it("closes when one of its destinations is pressed", () => {
    renderSign(BOARD);
    open();

    fireEvent.click(screen.getByRole("link", { name: "Avgifter" }));

    expect(screen.queryByRole("link")).toBeNull();
    expect(sign().getAttribute("aria-expanded")).toBe("false");
  });

  it("marks the section that holds the current page with more than colour", () => {
    renderSign(BOARD, MEETINGS);

    // The band's marker: full ink and a 3px brass underline, and the state
    // said as well as shown.
    expect(sign().getAttribute("aria-current")).toBe("true");
    expect(sign().className).toContain("border-trust-register");
    expect(sign().className).toContain("border-b-[3px]");
  });

  it("marks no section that does not hold it", () => {
    renderSign(BOARD, ISSUES);

    expect(sign().hasAttribute("aria-current")).toBe(false);
    expect(sign().className).not.toContain("border-trust-register");
  });

  it("marks a one-destination sign as current on its page", () => {
    renderSign(BUILDING_OF_ONE, ISSUES);

    const link = screen.getByRole("link", { name: "Ärenden" });
    expect(link.className).toContain("border-trust-register");
  });

  it("gives the current row a brass edge on its leading side", () => {
    renderSign(BOARD, MEETINGS);
    open();

    const current = screen.getByRole("link", { name: "Stämmor" });
    const other = screen.getByRole("link", { name: "Avgifter" });
    expect(current.className).toContain("border-s-[3px]");
    expect(current.className).toContain("border-trust-register");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(other.className).not.toContain("border-trust-register");
  });

  it("insets a child row with its brass edge, the member's fallback at the section's level", () => {
    renderSign({ ...BOARD, items: [MEETINGS, MOTIONS] }, MOTIONS);
    open();

    // The marker and the inset are on one element, so the edge moves with the row.
    const classes = screen
      .getByRole("link", { name: "Motioner" })
      .className.split(" ");
    expect(classes).toContain("border-s-[3px]");
    expect(classes).toContain("border-trust-register");
    expect(classes).toContain("ms-4");
    expect(classes).toContain("ps-3.25");
    expect(
      screen.getByRole("link", { name: "Stämmor" }).className,
    ).not.toContain("ms-4");
  });

  it("carries the sum of its destinations' counts on its sign", () => {
    renderSign({
      ...BOARD,
      items: [
        { ...MEETINGS, count: 3 },
        { ...FEES, count: 2 },
      ],
    });
    expect(sign().textContent).toContain("5");
  });

  it("carries no plate when there is nothing to count", () => {
    renderSign({ ...BOARD, items: [{ ...MEETINGS, count: 0 }, FEES] });
    expect(sign().textContent).toBe("Styrelsen");
  });

  it("gives every control the on-board focus ring", () => {
    // The room's brass measures under 3:1 on the board in the light theme, so
    // everything on the board rings in the on-board variant.
    const ring = "focus-visible:outline-trust-register";

    const first = renderSign(BOARD);
    expect(sign().className).toContain(ring);
    open();
    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain(ring);
    }
    first.unmount();

    renderSign(BUILDING_OF_ONE);
    expect(screen.getByRole("link").className).toContain(ring);
  });

  it("keeps the chevron from assistive technology", () => {
    const { container } = renderSign(BOARD);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("opens the end sign's panel towards the band, not off the window", () => {
    const { container } = renderSign(BOARD, undefined, true);
    open();

    expect(container.querySelector("li")?.className).toContain("ml-auto");
    expect(
      document.getElementById(sign().getAttribute("aria-controls") ?? "")
        ?.className,
    ).toContain("right-0");
  });

  describe("with groups", () => {
    it("heads a group of two or more and names its list by the heading", () => {
      renderSign(GROUPED);
      open();

      const panel = document.getElementById(
        sign().getAttribute("aria-controls") ?? "",
      );
      expect(panel?.tagName).toBe("DIV");
      // The queues are headed; the front page and the fees stand alone.
      const queues = screen.getByRole("list", { name: "Köer" });
      expect(
        within(queues)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(["Hantera ärenden", "Styrelsens post"]);
      expect(panel?.contains(queues)).toBe(true);
      expect(screen.queryByText("Ekonomi")).toBeNull();
      expect(screen.getAllByRole("list", { name: "Köer" })).toHaveLength(1);
    });

    it("keeps every row, in order, the front page first", () => {
      renderSign(GROUPED);
      open();

      expect(
        screen.getAllByRole("link").map((link) => link.textContent),
      ).toEqual([
        "Att hantera",
        "Hantera ärenden",
        "Styrelsens post",
        "Avgifter",
      ]);
    });

    it("leaves a row alone in its group under no heading", () => {
      renderSign(GROUPED);
      open();

      const fees = screen.getByRole("link", { name: "Avgifter" });
      const list = fees.closest("ul");
      expect(list?.hasAttribute("aria-labelledby")).toBe(false);
    });

    it("is the plain panel when no group has two rows to head", () => {
      renderSign({ ...GROUPED, items: [FRONT, ISSUE_QUEUE, BOARD_FEES] });
      open();

      expect(
        document.getElementById(sign().getAttribute("aria-controls") ?? "")
          ?.tagName,
      ).toBe("UL");
    });

    it("closes when one of its rows is pressed", () => {
      renderSign(GROUPED);
      open();

      fireEvent.click(screen.getByRole("link", { name: "Styrelsens post" }));

      expect(screen.queryByRole("link")).toBeNull();
      expect(sign().getAttribute("aria-expanded")).toBe("false");
    });
  });
});
