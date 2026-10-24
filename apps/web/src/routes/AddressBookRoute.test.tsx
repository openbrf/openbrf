import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { ViewerAccess } from "../shell/use-viewer-capabilities";
import { AddressBookRoute } from "./AddressBookRoute";

/**
 * The address book's own acts, and who is offered them.
 *
 * The board's view is a stand-in here: what is checked is the row of acts
 * above it, which the route decides from the viewer, and that a support
 * session (ADR 0028) reads the board's view without them.
 */

const access = vi.hoisted(() =>
  vi.fn((): ViewerAccess => ({
    capabilities: ["addressBook:read"],
    readOnly: false,
  })),
);

vi.mock("../shell/use-viewer-capabilities", () => ({
  useViewerAccess: () => access(),
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

vi.mock("../shell/use-housing-cooperative-logo", () => ({
  useHousingCooperativeLogo: () => undefined,
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

beforeEach(() => {
  access.mockClear();
  addressBookView.mockReset();
  addressBookView.mockReturnValue(BOARD_VIEW);
});

describe("the address book's acts", () => {
  it("offers the board adding a person, a move-in and the import", () => {
    render(<AddressBookRoute />);

    expect(
      screen.getByRole("button", { name: "Lägg till person" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flytta in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /import/i })).toBeTruthy();
  });

  it("offers a support session the board's view and the registers, and none of the acts", () => {
    access.mockReturnValue({
      capabilities: ["addressBook:read", "memberRegister:read"],
      readOnly: true,
    });
    render(<AddressBookRoute />);

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

  it("is on the page once the board's view has answered", () => {
    render(<AddressBookRoute />);

    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it.each([
    ["is loading", { state: "loading" }],
    ["has failed", { state: "failed" }],
  ])("is not on the page while the view %s", (_, view) => {
    addressBookView.mockReturnValue(view);
    render(<AddressBookRoute />);

    expect(screen.queryByText(NOTE)).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Adressbok" }),
    ).toBeTruthy();
  });
});
