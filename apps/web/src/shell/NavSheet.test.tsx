import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { navItemsFor, sectionsOf, type NavItem } from "./nav-items";
import { NavSheet } from "./NavSheet";

/** The router's Link, as an anchor that reports its press. */
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
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
}));

/** A member's whole grant: a resident's and the tenant-ownership's two. */
const MEMBER = [
  "self:manage",
  "residentDirectory:read",
  "issues:report",
  "news:comment",
  "bookings:book",
  "events:attend",
  "keyOrders:place",
  "chat:participate",
  "motions:submit",
  "sublets:apply",
];

const items = navItemsFor(MEMBER);
const sections = sectionsOf(items);

/**
 * A stand-in for the browser's media query, holding the listener the sheet
 * registers so a test can widen the window.
 */
function stubWindow(wide: boolean) {
  const listeners: ((event: { matches: boolean }) => void)[] = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: (
      _type: string,
      listener: (event: { matches: boolean }) => void,
    ) => {
      listeners.push(listener);
    },
    removeEventListener: vi.fn(),
  }));
  return {
    widen: () => {
      for (const listener of listeners) {
        listener({ matches: true });
      }
    },
  };
}

function renderSheet(current?: NavItem) {
  const onClose = vi.fn();
  render(
    <NavSheet
      id="sheet"
      sections={sections}
      current={current}
      onClose={onClose}
    />,
  );
  return onClose;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NavSheet", () => {
  it("reads floor by floor: each section a heading, its destinations beneath", () => {
    stubWindow(false);
    renderSheet();

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Föreningen",
      "Huset",
      "Inställningar",
    ]);

    const under = (heading: string) =>
      within(
        screen.getByRole("heading", { name: heading })
          .parentElement as HTMLElement,
      )
        .getAllByRole("link")
        .map((link) => link.textContent);
    expect(under("Föreningen")).toEqual([
      "Adressbok",
      "Nyheter",
      "Evenemang",
      "Chatt",
      "Dokument",
      "Motioner",
    ]);
    expect(under("Huset")).toEqual([
      "Ärenden",
      "Bokningar",
      "Nycklar",
      "Lägenhetspärm",
      "Andrahand",
    ]);
    expect(under("Inställningar")).toEqual(["Inställningar"]);
  });

  it("lists the bar's destinations too, because it is the whole map", () => {
    stubWindow(false);
    renderSheet();

    expect(screen.getAllByRole("link")).toHaveLength(items.length);
    expect(screen.getByRole("link", { name: "Bokningar" })).toBeTruthy();
  });

  it("gives the current destination the brass edge", () => {
    stubWindow(false);
    renderSheet(items.find((item) => item.to === "/sublets"));

    const current = screen.getByRole("link", { name: "Andrahand" });
    expect(current.className).toContain("border-s-[3px]");
    expect(current.className).toContain("border-trust-register");
    expect(
      screen.getByRole("link", { name: "Nycklar" }).className,
    ).not.toContain("border-trust-register");
  });

  it("closes when a destination is chosen", () => {
    stubWindow(false);
    const onClose = renderSheet();

    fireEvent.click(screen.getByRole("link", { name: "Lägenhetspärm" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the window widens to where the band shows", () => {
    // Left open, it would hide with the bar and leave the room behind inert.
    const window = stubWindow(false);
    const onClose = renderSheet();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      window.widen();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes at once when the window is already that wide", () => {
    stubWindow(true);
    const onClose = renderSheet();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays put where the browser cannot be asked", () => {
    vi.stubGlobal("matchMedia", undefined);
    const onClose = renderSheet();
    expect(onClose).not.toHaveBeenCalled();
  });
});
