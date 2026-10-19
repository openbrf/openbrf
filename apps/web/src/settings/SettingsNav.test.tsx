import { render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { SETTINGS_SECTIONS } from "./settings-sections";
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

describe("the settings navigation", () => {
  it("is a named navigation landmark of links, one per section", () => {
    render(<SettingsNav sections={SETTINGS_SECTIONS} current="account" />);

    expect(
      screen.getByRole("navigation", { name: /delar av inställningarna/i }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(SETTINGS_SECTIONS.map((section) => `/settings/${section.id}`));
  });

  it("marks the current section with aria-current and the brass edge", () => {
    render(<SettingsNav sections={SETTINGS_SECTIONS} current="appearance" />);

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
    render(<SettingsNav sections={SETTINGS_SECTIONS} current="account" />);

    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain("min-h-11");
    }
  });

  describe("grouping", () => {
    it("lists the account first, outside the group that carries the board's sign", () => {
      render(<SettingsNav sections={SETTINGS_SECTIONS} current="account" />);

      const group = screen.getByRole("group", {
        name: /styrelsen föreningens administration/i,
      });
      const [first] = screen.getAllByRole("link");
      expect(first?.textContent).toBe("Mitt konto");
      expect(
        within(group).queryByRole("link", { name: "Mitt konto" }),
      ).toBeNull();
      expect(
        within(group)
          .getAllByRole("link")
          .map((link) => link.getAttribute("href")),
      ).toEqual(
        SETTINGS_SECTIONS.filter(
          (section) => section.group === "association",
        ).map((section) => `/settings/${section.id}`),
      );
    });

    it("keeps the links real and the current one marked inside the group", () => {
      render(<SettingsNav sections={SETTINGS_SECTIONS} current="meetings" />);

      const group = screen.getByRole("group");
      expect(
        within(group).getByRole("link", { current: "page" }).textContent,
      ).toBe("Föreningsstämman");
    });

    it("shows a viewer with only their account no group and no sign", () => {
      render(
        <SettingsNav sections={[SETTINGS_SECTIONS[0]]} current="account" />,
      );

      expect(screen.queryByRole("group")).toBeNull();
      expect(screen.queryByText("Styrelsen")).toBeNull();
      expect(screen.getAllByRole("link")).toHaveLength(1);
    });
  });
});
