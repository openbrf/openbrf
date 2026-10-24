import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";

/**
 * The board's pages that moved under /board, opened by their address by an
 * account the band does not offer them to.
 *
 * Every route here asks for a session and nothing more, so a resident who
 * types the address reaches the component. What they must read there is the
 * one sentence every refused board page says (DESIGN.md, "The board's pages",
 * Gating): no sign, no heading over a screen that has nothing for them, no
 * control of the board's - and no request, because a screen that is not
 * mounted asks the API for nothing it would only refuse.
 */

const requested: string[] = [];
let capabilities: readonly string[] = [];

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  apiRequest: (_method: string, path: string) => {
    requested.push(path);
    return Promise.resolve({
      ok: false,
      failure: { status: 403, reason: "forbidden" },
    });
  },
}));

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
        capabilities: [...capabilities],
        housingCooperative: null,
      },
    }),
}));

vi.mock("../auth/auth-client", () => ({
  authClient: { signOut: vi.fn() },
  useSession: () => ({ data: null }),
}));

// The band is the navigation's own test; here it is only the room around the
// page, so the assertions read the page and nothing the band would add.
vi.mock("../shell/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }): ReactElement => (
    <main>{children}</main>
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

const { ApartmentRegisterRoute } = await import("./ApartmentRegisterRoute");
const { BoardMailboxRoute } = await import("./BoardMailboxRoute");
const { ChargesRoute } = await import("./ChargesRoute");
const { DataProtectionRoute } = await import("./DataProtectionRoute");
const { DevicesRoute } = await import("./DevicesRoute");
const { DisplayRoute } = await import("./DisplayRoute");
const { FeesRoute } = await import("./FeesRoute");
const { ImportRoute } = await import("./ImportRoute");
const { InitialSupplyRoute } = await import("./InitialSupplyRoute");
const { MeetingsRoute } = await import("./MeetingsRoute");
const { MemberRegisterRoute } = await import("./MemberRegisterRoute");
const { NewsRoute } = await import("./NewsRoute");
const { RegisterReportQueueRoute } = await import("./RegisterReportQueueRoute");
const { SiteAdminRoute } = await import("./SiteAdminRoute");
const { SiteMenuRoute } = await import("./SiteMenuRoute");

const NOT_OFFERED =
  "Den här sidan är styrelsens. Ditt konto har inget att göra här.";

const RESIDENT = [
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
const PROPERTY_MANAGER = ["issues:handle", "self:manage"];

const ROUTES: readonly [path: string, route: () => ReactElement][] = [
  ["/board/registers/members", MemberRegisterRoute],
  ["/board/registers/apartments", ApartmentRegisterRoute],
  ["/board/registers/reports", RegisterReportQueueRoute],
  ["/board/registers/reports/supply", InitialSupplyRoute],
  ["/board/import", ImportRoute],
  ["/board/mailbox", BoardMailboxRoute],
  ["/board/news", NewsRoute],
  ["/board/site", SiteAdminRoute],
  ["/board/site/menu", SiteMenuRoute],
  ["/board/site/devices", DevicesRoute],
  ["/board/fees", FeesRoute],
  ["/board/charges", ChargesRoute],
  ["/board/data-protection", DataProtectionRoute],
  ["/board/meetings", MeetingsRoute],
  ["/board/site/display", DisplayRoute],
];

beforeEach(() => {
  requested.length = 0;
});

describe.each([
  ["a resident", RESIDENT],
  ["the property manager", PROPERTY_MANAGER],
])("a board page opened by its address by %s", (_who, seat) => {
  it.each(ROUTES)(
    "%s says the page is the board's, with no sign and no request",
    async (_path, Route) => {
      capabilities = seat;
      render(<Route />);

      expect(await screen.findByText(NOT_OFFERED)).toBeTruthy();
      expect(screen.queryByRole("heading")).toBeNull();
      expect(screen.queryByText("Styrelsen", { exact: true })).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(requested).toEqual([]);
    },
  );
});
