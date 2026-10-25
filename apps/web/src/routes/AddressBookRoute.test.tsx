import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { SUPPORT_SESSION } from "../support/support-fixtures";
import { AddressBookRoute } from "./AddressBookRoute";

/**
 * The address book's own acts, who is offered them, and who is offered the
 * page at all.
 *
 * The board's view is a stand-in here: what is checked is the row of acts
 * above it, which the route decides from the viewer, that a support session
 * (ADR 0028) reads the board's view without them, and that an account the page
 * is not offered to reads the refused page's sentence without the register
 * being asked for (ADR 0049).
 */

const viewerOf = vi.hoisted(() =>
  vi.fn((): Pick<Viewer, "capabilities" | "support"> => ({
    capabilities: ["addressBook:read"],
  })),
);

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchViewer: (): Promise<{ ok: true; value: Viewer }> =>
    Promise.resolve({
      ok: true,
      value: {
        personId: "person-maja",
        firstName: "Maja",
        lastName: "Lind",
        preferredLocale: "sv",
        housingCooperative: null,
        ...viewerOf(),
      },
    }),
}));

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
  useNavigate: () => vi.fn(),
}));

vi.mock("../auth/auth-client", () => ({
  authClient: { signOut: vi.fn() },
  useSession: () => ({ data: null }),
}));

vi.mock("../shell/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }): ReactElement => (
    <>{children}</>
  ),
}));

vi.mock("../theme/ThemeModeToggle", () => ({
  ThemeModeToggle: (): null => null,
}));

vi.mock("../register/Board", () => ({
  Board: (): null => null,
}));

const BOARD_VIEW = {
  state: "board",
  page: {
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
    stats: { apartments: 12, persons: 20, members: 15 },
  },
} as const;

const addressBookView = vi.hoisted(() => vi.fn((): unknown => undefined));

vi.mock("../register/use-address-book", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../register/use-address-book")>()),
  useAddressBook: () => ({
    view: addressBookView(),
    refreshing: false,
    reload: vi.fn(),
  }),
}));

const NOT_OFFERED =
  "Den här sidan är styrelsens. Ditt konto har inget att göra här.";

beforeEach(() => {
  viewerOf.mockReset();
  viewerOf.mockReturnValue({ capabilities: ["addressBook:read"] });
  addressBookView.mockReset();
  addressBookView.mockReturnValue(BOARD_VIEW);
});

describe("the address book's acts", () => {
  it("offers the board adding a person, a move-in and the import", async () => {
    render(<AddressBookRoute />);

    expect(
      await screen.findByRole("button", { name: "Lägg till person" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flytta in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /import/i })).toBeTruthy();
  });

  it("offers a support session the board's view and the registers, and none of the acts", async () => {
    viewerOf.mockReturnValue({
      capabilities: ["addressBook:read", "memberRegister:read"],
      support: SUPPORT_SESSION,
    });
    render(<AddressBookRoute />);

    expect(
      await screen.findByRole("link", { name: /medlemsförteckning/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Lägg till person" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Flytta in" })).toBeNull();
    expect(screen.queryByRole("link", { name: /import/i })).toBeNull();
    // Reading on is still offered: the member register is a document, not an act.
    expect(
      screen.getByRole("link", { name: /medlemsförteckning/i }),
    ).toBeTruthy();
  });
});

describe("the board's sign", () => {
  const NOTE = "Det här ser bara styrelsen och administratören.";

  it("is on the page once the board's view has answered", async () => {
    render(<AddressBookRoute />);

    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  it.each([
    ["is loading", { state: "loading" }],
    ["has failed", { state: "failed" }],
  ])("is not on the page while the view %s", async (_, view) => {
    addressBookView.mockReturnValue(view);
    render(<AddressBookRoute />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Adressbok" }),
    ).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});

describe("an account the page is not offered to", () => {
  it("reads the refused page's sentence, and the register is not asked for", async () => {
    // A resident, who once got the resident directory at this address. It has
    // no house page now, and this page is the board's (ADR 0049).
    viewerOf.mockReturnValue({
      capabilities: ["residentDirectory:read", "issues:report"],
    });
    render(<AddressBookRoute />);

    expect(await screen.findByText(NOT_OFFERED)).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText("Styrelsen", { exact: true })).toBeNull();
    expect(addressBookView).not.toHaveBeenCalled();
  });

  it("reads the same sentence when the server refuses the board's view", async () => {
    // A seat that ended while the page was open.
    addressBookView.mockReturnValue({ state: "refused" });
    render(<AddressBookRoute />);

    expect(await screen.findByText(NOT_OFFERED)).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("heading")).toBeNull();
    });
  });
});
