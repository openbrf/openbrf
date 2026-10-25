import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import {
  SETTINGS_SECTIONS,
  type AssociationSection,
} from "./settings-sections";
import { SettingsNav } from "./SettingsNav";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
    "aria-current": ariaCurrent,
  }: {
    to: string;
    params: { section: string };
    children: ReactNode;
    className?: string;
    "aria-current"?: "page";
  }): ReactElement => (
    <a
      href={to.replace("$section", params.section)}
      className={className}
      aria-current={ariaCurrent}
    >
      {children}
    </a>
  ),
}));

/** The association's sections, which are all the navigation ever lists. */
const ASSOCIATION = SETTINGS_SECTIONS.filter(
  (section): section is AssociationSection => section.group === "association",
);

describe("the settings navigation", () => {
  it("is a named navigation landmark of links, one per section", () => {
    render(<SettingsNav sections={ASSOCIATION} current="association" />);

    expect(
      screen.getByRole("navigation", { name: /delar av inställningarna/i }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(ASSOCIATION.map((section) => `/board/settings/${section.id}`));
  });

  it("marks the current section with aria-current and the brass edge", () => {
    render(<SettingsNav sections={ASSOCIATION} current="appearance" />);

    const current = screen.getByRole("link", { current: "page" });
    expect(current.textContent).toBe("Utseende");
    expect(current.className).toContain("border-trust");

    // Brass marks the current section and nothing else.
    for (const link of screen.getAllByRole("link")) {
      if (link !== current) {
        expect(link.getAttribute("aria-current")).toBeNull();
        expect(link.className).not.toContain("border-trust");
      }
    }
  });

  it("gives every entry the 44px touch target", () => {
    render(<SettingsNav sections={ASSOCIATION} current="association" />);

    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain("min-h-11");
    }
  });

  it("carries no group, heading or sign: the page's own heading does", () => {
    render(<SettingsNav sections={ASSOCIATION} current="meetings" />);

    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(screen.queryByRole("link", { name: "Mitt konto" })).toBeNull();
  });
});
