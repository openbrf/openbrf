import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { AppShell } from "./AppShell";
import type { NavItem } from "./nav-items";

/** The page this stand-in router is on; a test may move it. */
const location = vi.hoisted(() => ({ pathname: "/" }));

/**
 * The router's Link needs a router context this test has no use for, so it is
 * replaced with an anchor. The shell's job here is the frame, not routing.
 *
 * It does reproduce what the real Link contributes: the press, and
 * aria-current="page" on the link to the page itself. The shell's own marker
 * comes from the location, which the stand-in useLocation answers.
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
      aria-current={to === location.pathname ? "page" : undefined}
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
  }): string => select({ pathname: location.pathname }),
}));

/** Child text, held in a constant so the no-literal-string rule stays strict. */
const CHILD_TEXT = "content";

/*
 * Two sections that open, one of one destination, and the settings: every
 * kind of sign the band has. Two destinations are in the bar.
 */
const NAV: readonly NavItem[] = [
  { to: "/", labelKey: "nav.addressBook", section: "association", barSlot: 1 },
  {
    to: "/overview",
    labelKey: "nav.overview",
    section: "association",
    count: 3,
  },
  {
    to: "/issues",
    labelKey: "issues.navLabel",
    section: "building",
    barSlot: 2,
  },
  { to: "/meetings", labelKey: "meetings.navLabel", section: "board" },
  { to: "/fees", labelKey: "fees.navLabel", section: "board" },
  { to: "/settings", labelKey: "nav.settings", section: "settings" },
];

function renderShell(props: Partial<Parameters<typeof AppShell>[0]> = {}) {
  return render(
    <AppShell housingCooperativeName="Brf Eksemplet" navItems={NAV} {...props}>
      <p>{CHILD_TEXT}</p>
    </AppShell>,
  );
}

/*
 * Both navigations are in the markup; only one is ever displayed, which the
 * stylesheet decides and this test has none of. The band comes first.
 */
const band = () => screen.getAllByRole("navigation")[0] as HTMLElement;
const bar = () => screen.getAllByRole("navigation")[1] as HTMLElement;
const sheetButton = () => within(bar()).getByRole("button", { name: /Meny/ });

/** The link targets inside the element a trigger controls. */
function linksControlledBy(trigger: HTMLElement): string[] {
  const panel = document.getElementById(
    trigger.getAttribute("aria-controls") ?? "",
  );
  if (panel === null) {
    throw new Error("the trigger controls nothing");
  }
  return within(panel)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "");
}

afterEach(() => {
  location.pathname = "/";
});

describe("AppShell", () => {
  it("carries the housing cooperative's identity in the band", () => {
    renderShell();
    expect(screen.getByText("Brf Eksemplet")).toBeTruthy();
  });

  it("gives both navigations the one name", () => {
    renderShell();

    // Two navigations exist because they sit in different parents and CSS
    // cannot move an element between them. Only one is ever exposed: the other
    // is display:none at that width, which removes it from the accessibility
    // tree too. They share a label because they are the same navigation.
    const navs = screen.getAllByRole("navigation");
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      expect(nav.getAttribute("aria-label")).toBe("Huvudnavigering");
    }
  });

  it("puts one sign per offered section in the band, the settings last", () => {
    renderShell();

    const signs = within(band())
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(signs).toEqual([
      "Föreningen3",
      "Ärenden",
      "Styrelsen",
      "Inställningar",
    ]);

    // The settings sign stands at the band's end, whatever comes before it.
    const last = within(band()).getAllByRole("listitem").at(-1);
    expect(last?.className).toContain("ml-auto");
  });

  it("reaches every destination from both navigations", () => {
    renderShell();
    const everything = NAV.map((item) => item.to).toSorted();

    /*
     * The one list is what keeps them in step: a destination cannot appear in
     * one and be forgotten in the other. In the band, every sign that opens is
     * opened and every sign that is a link is read.
     */
    const inTheBand: string[] = [];
    for (const item of within(band()).getAllByRole("listitem")) {
      const sign = item.firstElementChild as HTMLElement;
      if (sign.tagName === "A") {
        inTheBand.push(sign.getAttribute("href") ?? "");
        continue;
      }
      fireEvent.click(sign);
      inTheBand.push(...linksControlledBy(sign));
      fireEvent.click(sign);
    }
    expect(inTheBand.toSorted()).toEqual(everything);

    // On a phone the sheet behind the menu holds every one of them again.
    fireEvent.click(sheetButton());
    expect(linksControlledBy(sheetButton()).toSorted()).toEqual(everything);
  });

  it("holds the bar's destinations in their columns and the menu in the fourth", () => {
    renderShell();

    const columns = within(bar())
      .getAllByRole("listitem")
      .map((item) => [item.className, item.textContent]);
    expect(columns).toEqual([
      ["col-start-1", "Adressbok"],
      ["col-start-2", "Ärenden"],
      ["col-start-4", "Meny3"],
    ]);
    expect(sheetButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a count on the sign that holds it, and on the menu it is behind", () => {
    renderShell();
    // The overview's 3, summed on Föreningen and on Meny, which covers every
    // destination outside the bar.
    expect(screen.getAllByText("3")).toHaveLength(2);
  });

  it("makes the room inert while the sheet covers it, and live again after", () => {
    renderShell();
    const main = screen.getByRole("main");
    expect(main.hasAttribute("inert")).toBe(false);

    fireEvent.click(sheetButton());
    expect(sheetButton().getAttribute("aria-expanded")).toBe("true");
    expect(main.hasAttribute("inert")).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(main.hasAttribute("inert")).toBe(false);
    expect(sheetButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("releases the room when a destination in the sheet is chosen", () => {
    renderShell();
    fireEvent.click(sheetButton());

    fireEvent.click(within(bar()).getByRole("link", { name: "Avgifter" }));

    expect(screen.getByRole("main").hasAttribute("inert")).toBe(false);
  });

  it("marks the menu as where you are when the page is not in the bar", () => {
    location.pathname = "/meetings";
    renderShell();

    expect(sheetButton().getAttribute("aria-current")).toBe("true");
    expect(sheetButton().className).toContain("border-trust-register");
    for (const link of within(bar()).getAllByRole("link")) {
      expect(link.className).not.toContain("border-trust-register");
    }
  });

  it("leaves the menu unmarked when the page is one of the bar's", () => {
    renderShell();
    expect(sheetButton().hasAttribute("aria-current")).toBe(false);
  });

  it("marks the active destination with more than colour", () => {
    renderShell();

    /*
     * DESIGN.md: colour is never the only signal - and a brass-on-dark shift is
     * exactly what a red-green colour blind board member cannot see. Both
     * navigations therefore carry a 3px brass edge where you are: the band
     * underlines the section's sign, the bar rules the item's top edge. The bar
     * once changed only text-trust-register, which this catches.
     */
    const sign = within(band()).getByRole("button", { name: /Föreningen/ });
    expect(sign.getAttribute("aria-current")).toBe("true");
    expect(sign.className).toMatch(/border-trust-register/);

    const item = within(bar()).getByRole("link", { name: "Adressbok" });
    expect(item.getAttribute("aria-current")).toBe("page");
    expect(item.className).toMatch(/border-t-\[3px\]/);
    expect(item.className).toMatch(/border-trust-register/);
  });

  it("keeps the frame off paper", () => {
    renderShell();
    expect(screen.getByRole("banner").className).toContain("print:hidden");
    expect(bar().className).toContain("print:hidden");
  });

  it("shows the signed-in person and their role", () => {
    renderShell({ personName: "Anna Lindqvist", roleLabel: "Ordförande" });

    expect(screen.getByText("Anna Lindqvist")).toBeTruthy();
    expect(screen.getByText("Ordförande")).toBeTruthy();
  });

  it("omits the identity block entirely when nobody is known", () => {
    renderShell();
    expect(screen.queryByText("Anna Lindqvist")).toBeNull();
  });

  it("offers sign-out only when the caller handles it", () => {
    renderShell();
    expect(screen.queryByRole("button", { name: /logga ut/i })).toBeNull();

    const onSignOut = vi.fn();
    renderShell({ onSignOut });
    const signOut = screen.getByRole("button", { name: /logga ut/i });
    // On the board, so it rings in the on-board brass like the signs.
    expect(signOut.className).toContain("focus-visible:outline-trust-register");
  });

  it("renders its children in the room below the band", () => {
    renderShell();
    const main = screen.getByRole("main");
    expect(main.textContent).toContain(CHILD_TEXT);
  });
});

/**
 * The mark in the band.
 *
 * The band is dark and a logo is somebody else's artwork, most of it drawn in
 * dark ink on white. What the shell does about that is the point of these
 * cases: with a variant made for dark surfaces it uses that one, and without it
 * puts the mark on a light plate rather than letting it disappear.
 */
describe("the housing cooperative's mark", () => {
  const LIGHT = "/api/media/light-1";
  const DARK = "/api/media/dark-1";

  /** The mark carries no alt text: the name beside it is already there. */
  const mark = () => screen.queryByRole("presentation");

  it("is absent until one is uploaded", () => {
    renderShell({ logo: { light: null, dark: null } });

    expect(mark()).toBeNull();
  });

  it("uses the dark-surface variant when there is one", () => {
    renderShell({ logo: { light: LIGHT, dark: DARK } });

    const image = mark();

    expect(image?.getAttribute("src")).toBe(DARK);
    expect(image?.parentElement?.className ?? "").not.toContain("bg-raised");
  });

  it("puts the plain mark on a light plate when there is not", () => {
    renderShell({ logo: { light: LIGHT, dark: null } });

    const image = mark();

    expect(image?.getAttribute("src")).toBe(LIGHT);
    // The plate is the deliberate fallback: a dark-ink mark straight on the
    // band would be invisible, and the settings screen previews this exact
    // case so a board sees it rather than discovers it.
    expect(image?.parentElement?.className ?? "").toContain("bg-raised");
  });

  it("says nothing to a screen reader that the name has not said", () => {
    renderShell({ logo: { light: LIGHT, dark: null } });

    expect(mark()?.getAttribute("alt")).toBe("");
    expect(screen.getByText("Brf Eksemplet")).toBeTruthy();
  });

  it("cannot take the band from the name and the navigation", () => {
    /*
     * A mark's proportions are the association's own, and nothing in the upload
     * bounds them. Constrained by height alone, one twenty times as wide as it
     * is tall would fill the band, and shrink-0 - which is there so the mark
     * does not collapse - would stop it giving the room back. Both variants are
     * therefore bounded in width as well and contained inside that box.
     */
    for (const { logo, maxWidth } of [
      { logo: { light: LIGHT, dark: DARK }, maxWidth: "max-w-36" },
      { logo: { light: LIGHT, dark: null }, maxWidth: "max-w-32" },
    ]) {
      const view = renderShell({ logo });
      const className = mark()?.className ?? "";

      expect(className).toContain(maxWidth);
      expect(className).toContain("object-contain");
      view.unmount();
    }
  });
});
