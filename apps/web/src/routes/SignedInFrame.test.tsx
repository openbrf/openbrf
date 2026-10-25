import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";

/**
 * The association's accent on a page opened by its address.
 *
 * The accent is a style element in the document, so moving between pages keeps
 * it and hides a page that never put it there. These tests mount the frame
 * first, as a fresh load or a refresh does, with no other route visited before
 * it, and read the document.
 */

let primaryColor: string | null = null;

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchViewer: (): Promise<{ ok: true; value: Viewer }> =>
    Promise.resolve({
      ok: true,
      value: {
        personId: "person",
        firstName: "Maja",
        lastName: "Lind",
        preferredLocale: "sv",
        capabilities: ["settings.manage"],
        housingCooperative: {
          name: "Brf Lindgården",
          logoUrl: null,
          logoDarkUrl: null,
          primaryColor,
        },
      } as Viewer,
    }),
}));

vi.mock("../auth/auth-client", () => ({
  authClient: { signOut: vi.fn() },
  useSession: () => ({ data: null }),
}));

vi.mock("../shell/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }): ReactElement => (
    <main>{children}</main>
  ),
}));

vi.mock("../settings/AssociationSettingsScreen", () => ({
  AssociationSettingsScreen: ({
    section,
  }: {
    section: string | undefined;
  }): ReactElement => (
    <div data-testid="settings-screen" data-section={section} />
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ section: "branding" }),
}));

const { SignedInFrame } = await import("./SignedInFrame");
const { AssociationSettingsRoute } = await import("./BoardRoutes");

const override = () => document.getElementById("openbrf-accent-override");

afterEach(() => {
  override()?.remove();
});

describe("a page opened by its address", () => {
  it("applies the association's accent on the association settings", async () => {
    primaryColor = "#2F6DB5";
    expect(override()).toBeNull();

    render(<AssociationSettingsRoute />);

    expect((await screen.findByTestId("settings-screen")).dataset.section).toBe(
      "branding",
    );
    expect(override()?.textContent).toContain("--obrf-accent-trust:");
  });

  it("applies it on a page that does not need the viewer", async () => {
    primaryColor = "#2F6DB5";

    render(
      <SignedInFrame>
        <div data-testid="page" />
      </SignedInFrame>,
    );

    await screen.findByTestId("page");
    await vi.waitFor(() => {
      expect(override()).not.toBeNull();
    });
  });

  it("leaves the theme's own accent when the association has none", async () => {
    primaryColor = null;

    render(<SignedInFrame>{() => <div data-testid="page" />}</SignedInFrame>);

    await screen.findByTestId("page");
    expect(override()).toBeNull();
  });
});
