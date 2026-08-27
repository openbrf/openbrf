import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import "../i18n";
import { AppShell, type NavItem } from "./AppShell";

/**
 * The router's Link needs a router context this test has no use for, so it is
 * replaced with an anchor. The shell's job here is the frame, not routing.
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

/** Child text, held in a constant so the no-literal-string rule stays strict. */
const CHILD_TEXT = "content";

const NAV: readonly NavItem[] = [
  { to: "/", labelKey: "nav.addressBook" },
  { to: "/overview", labelKey: "nav.overview", count: 3 },
];

function renderShell(props: Partial<Parameters<typeof AppShell>[0]> = {}) {
  return render(
    <AppShell associationName="Brf Eksemplet" navItems={NAV} {...props}>
      <p>{CHILD_TEXT}</p>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("carries the association's identity in the band", () => {
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

  it("renders its children in the room below the band", () => {
    renderShell();
    const main = screen.getByRole("main");
    expect(main.textContent).toContain(CHILD_TEXT);
  });
});
