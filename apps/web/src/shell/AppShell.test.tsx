import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import "../i18n";
import { AppShell, type NavItem } from "./AppShell";

/** The destination this stand-in treats as the current route. */
const ACTIVE_PATH = "/";

/**
 * The router's Link needs a router context this test has no use for, so it is
 * replaced with an anchor. The shell's job here is the frame, not routing.
 *
 * It does reproduce the two things the real Link contributes to the active
 * state: it merges `activeProps` for the current route, and it marks that link
 * with aria-current="page". Without those the active styling could not be
 * asserted at all, and a marker regression would pass unnoticed.
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
    activeProps,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    activeProps?: { className?: string };
  }): ReactElement => {
    const active = to === ACTIVE_PATH;
    return (
      <a
        href={to}
        className={active ? activeProps?.className : className}
        aria-current={active ? "page" : undefined}
      >
        {children}
      </a>
    );
  },
}));

/** Child text, held in a constant so the no-literal-string rule stays strict. */
const CHILD_TEXT = "content";

const NAV: readonly NavItem[] = [
  { to: "/", labelKey: "nav.addressBook" },
  { to: "/overview", labelKey: "nav.overview", count: 3 },
];

function renderShell(props: Partial<Parameters<typeof AppShell>[0]> = {}) {
  return render(
    <AppShell housingCooperativeName="Brf Eksemplet" navItems={NAV} {...props}>
      <p>{CHILD_TEXT}</p>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("carries the housing cooperative's identity in the band", () => {
    renderShell();
    expect(screen.getByText("Brf Eksemplet")).toBeTruthy();
  });

  it("renders the same destinations in the band and the bottom bar", () => {
    renderShell();

    // Two navigations exist because they sit in different parents and CSS
    // cannot move an element between them. Only one is ever exposed: the other
    // is display:none at that breakpoint, which removes it from the
    // accessibility tree too. They share a label because they are the same
    // navigation.
    const navs = screen.getAllByRole("navigation");
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      expect(nav.getAttribute("aria-label")).toBe("Huvudnavigering");
    }

    // Sharing one renderer is what keeps them in step: a new destination
    // cannot appear in one and be forgotten in the other.
    expect(screen.getAllByText("Adressbok")).toHaveLength(2);
    expect(screen.getAllByText("Översikt")).toHaveLength(2);
  });

  it("shows a count as a plate beside its destination", () => {
    renderShell();
    expect(screen.getAllByText("3")).toHaveLength(2);
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
    expect(screen.getByRole("button", { name: /logga ut/i })).toBeTruthy();
  });

  it("marks the active destination with more than colour", () => {
    renderShell();

    /*
     * DESIGN.md: colour is never the only signal - and a brass-on-dark shift is
     * exactly what a red-green colour blind board member cannot see. Both
     * navigations therefore carry a 3px brass edge on the active item: the band
     * underlines it, the bar rules its top edge. The bar used to change only
     * text-trust-register, which this catches.
     */
    const active = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");

    expect(active).toHaveLength(2);
    for (const link of active) {
      expect(link.className).toMatch(/border-trust-register/);
    }
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
});
