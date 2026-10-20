import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { asSupportSession } from "../support/support-fixtures";
import { ThemeComposerRoute } from "./ThemeComposerRoute";

/**
 * Who is shown the composer.
 *
 * Everything on it edits a theme, so a support session (ADR 0028), which holds
 * the administrator's capability and changes nothing, is told why there is
 * nothing here for it rather than shown a form it cannot send.
 */

const fetchViewer = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchViewer: () => fetchViewer(),
}));

// The frame and the composer have tests of their own.
vi.mock("../shell/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }): ReactElement => (
    <main>{children}</main>
  ),
}));

vi.mock("../themes/ThemeComposerScreen", () => ({
  ThemeComposerScreen: (): ReactElement => <p>{COMPOSER}</p>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));

const COMPOSER = "the composer";

const ADMINISTRATOR: Viewer = {
  personId: "person-1",
  firstName: "Astrid",
  lastName: "Admin",
  preferredLocale: "sv",
  capabilities: ["association:read", "association:manage"],
  housingCooperative: null,
};

beforeEach(() => {
  fetchViewer.mockReset();
});

describe("the theme composer", () => {
  it("is the administrator's to work", async () => {
    fetchViewer.mockResolvedValue({ ok: true, value: ADMINISTRATOR });
    render(<ThemeComposerRoute />);

    expect(await screen.findByText(COMPOSER)).toBeTruthy();
  });

  it("tells a support session it is read only instead of offering the form", async () => {
    fetchViewer.mockResolvedValue({
      ok: true,
      value: asSupportSession(ADMINISTRATOR),
    });
    render(<ThemeComposerRoute />);

    expect(
      await screen.findByText(
        "Supportåtkomst är bara läsande. Be administratören att göra ändringen.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(COMPOSER)).toBeNull();
  });
});
