import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { expect, it, vi } from "vitest";

import "../i18n";
import { ThemesPanel } from "./ThemesPanel";

/**
 * The settings panel's line on the theme in force.
 *
 * A preview is this browser's alone, so naming the previewed theme as the
 * active one told an administrator something the instance was not doing.
 */

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }): ReactElement => (
    <a href="/admin/themes">{children}</a>
  ),
}));

vi.mock("../theme/theme-runtime-context", () => ({
  useOptionalThemeRuntime: () => ({
    active: { id: "porttavlan", name: "Porttavlan" },
    previewing: { id: "example-theme", name: "Exempeltema" },
  }),
}));

it("names the active theme as active while another is previewed", () => {
  render(<ThemesPanel />);

  expect(screen.getByText(/Porttavlan/)).toBeTruthy();
  expect(screen.queryByText(/Exempeltema/)).toBeNull();
});
