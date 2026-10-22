import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { BoardFrontScreen } from "./BoardFrontScreen";

/**
 * The board's front page, "To handle": one row for each queue the account
 * works, with what is waiting in it and the way to it.
 *
 * The fake API refuses, as the real one does, any path the viewer's
 * capabilities do not open, so a row that asked for a queue it may not have
 * would show up here as a refused request rather than as a quiet 403 on
 * somebody's page.
 */

/** The path the API serves and the capability its controller requires. */
const GUARDS: readonly [path: string, capability: string][] = [
  ["/api/issue-queue", "issues:handle"],
  ["/api/board-mailbox/threads", "boardMailbox:handle"],
  ["/api/motion-queue", "motions:handle"],
  ["/api/sublet-queue", "sublets:handle"],
  ["/api/key-order-queue", "keyOrders:handle"],
  ["/api/broker-update-requests", "site:manage"],
  ["/api/signup-requests", "signupRequest:decide"],
  ["/api/feed/reports", "chat:moderate"],
];

const QUEUE_CAPABILITIES = [
  "issues:handle",
  "boardMailbox:handle",
  "motions:handle",
  "sublets:handle",
  "keyOrders:handle",
  "site:manage",
  "signupRequest:decide",
  "chat:moderate",
];
const BOARD_MEMBER = ["self:manage", "addressBook:read", ...QUEUE_CAPABILITIES];
const PROPERTY_MANAGER = ["issues:handle", "self:manage"];
const RESIDENT = [
  "self:manage",
  "residentDirectory:read",
  "issues:report",
  "news:comment",
  "bookings:book",
  "events:attend",
  "keyOrders:place",
  "chat:participate",
];

const ok = (value: unknown) => ({ ok: true, value });
const failed = { ok: false, failure: { status: 500, reason: "unexpected" } };

/** What each path answers with; a test overrides one to change one row. */
type Answers = Record<string, unknown>;

function answers(): Answers {
  return {
    "/api/issue-queue": ok([{ id: "a" }, { id: "b" }, { id: "c" }]),
    "/api/board-mailbox/threads": ok({
      threads: [
        { id: "1", status: "NEW" },
        { id: "2", status: "TAKEN" },
        { id: "3", status: "CLOSED" },
      ],
      more: false,
      nextCursor: null,
    }),
    "/api/motion-queue": ok({ deadline: null, motions: [], nextCursor: null }),
    "/api/sublet-queue": ok({ applications: [{ id: "a" }] }),
    "/api/key-order-queue": ok({ orders: [{ id: "a" }, { id: "b" }] }),
    "/api/broker-update-requests": ok({ open: [], answered: [], openTotal: 4 }),
    "/api/signup-requests": ok([{ id: "a" }]),
    "/api/feed/reports": ok({ reports: [], next: null, mayModerate: true }),
  };
}

let capabilities: readonly string[] = [];
let answered: Answers = {};
const requested: string[] = [];
const refused: string[] = [];

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  apiRequest: (_method: string, path: string) => {
    requested.push(path);
    const bare = path.split("?")[0] ?? path;
    const guard = GUARDS.find(([prefix]) => prefix === bare);
    if (guard === undefined) {
      throw new Error(
        `the front page asked for a path this test does not know: ${path}`,
      );
    }
    const [, capability] = guard;
    if (!capabilities.includes(capability)) {
      refused.push(path);
      return Promise.resolve({
        ok: false,
        failure: { status: 403, reason: "forbidden" },
      });
    }
    return Promise.resolve(answered[bare]);
  },
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
}));

function renderFor(
  seat: readonly string[],
  overrides: Answers = {},
  session: Pick<Viewer, "support"> = {},
) {
  capabilities = seat;
  answered = { ...answers(), ...overrides };
  const viewer: Viewer = {
    personId: "person",
    firstName: "Maja",
    lastName: "Lind",
    preferredLocale: "sv",
    capabilities: [...seat],
    housingCooperative: null,
    ...session,
  };
  render(<BoardFrontScreen viewer={viewer} />);
}

/** A queue's row, found by the link that names it. */
const row = (name: string) =>
  screen.getByRole("link", { name }).closest("li") as HTMLElement;

beforeEach(() => {
  requested.length = 0;
  refused.length = 0;
});

describe("the front page for a board member", () => {
  it("is headed by the board's sign and says who sees it", () => {
    renderFor(BOARD_MEMBER);

    expect(
      screen.getByRole("heading", { level: 1, name: "Styrelsen Att hantera" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Det här ser bara styrelsen och administratören."),
    ).toBeTruthy();
  });

  it("puts a row with a count and a link for each queue", async () => {
    renderFor(BOARD_MEMBER);

    await within(row("Nya ärenden")).findByText("3");
    expect(
      within(row("Obesvarade trådar i styrelsens brevlåda")).getByText("2"),
    ).toBeTruthy();
    expect(
      await within(row("Motioner som inte är mottagna")).findByText(
        "Inget väntar",
      ),
    ).toBeTruthy();
    expect(
      within(
        row("Ansökningar om andrahandsupplåtelse att besluta om"),
      ).getByText("1"),
    ).toBeTruthy();
    expect(
      within(row("Nyckelbeställningar att besvara")).getByText("2"),
    ).toBeTruthy();
    expect(
      within(row("Mäklares förfrågningar om uppdatering")).getByText("4"),
    ).toBeTruthy();
    expect(
      within(row("Kontoansökningar att besluta om")).getByText("1"),
    ).toBeTruthy();
    expect(
      await within(row("Anmälda inlägg")).findByText("Inget väntar"),
    ).toBeTruthy();
    expect(refused).toEqual([]);
  });

  it("leads each row to the page the queue is worked on", async () => {
    renderFor(BOARD_MEMBER);
    await within(row("Nya ärenden")).findByText("3");

    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual([
      "/board/issues",
      "/board-mailbox",
      "/motions",
      "/sublets",
      "/key-orders",
      "/settings/account-requests",
      "/settings/account-requests",
      "/feed",
    ]);
  });

  it("says at least when a queue answered with one page of more", async () => {
    renderFor(BOARD_MEMBER, {
      "/api/motion-queue": ok({
        deadline: null,
        motions: [{ id: "a" }, { id: "b" }],
        nextCursor: "cursor",
      }),
    });

    expect(
      await within(row("Motioner som inte är mottagna")).findByText(
        "2 eller fler",
      ),
    ).toBeTruthy();
  });

  it("leaves out the reported posts for an account the queue is not for", async () => {
    // The administrator's case: chat:moderate held through the grant of every
    // capability, and no board seat.
    renderFor(BOARD_MEMBER, {
      "/api/feed/reports": ok({ reports: [], next: null, mayModerate: false }),
    });

    await within(row("Nya ärenden")).findByText("3");
    // The row stands while its read is out, so wait for the answer to take it.
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Anmälda inlägg" })).toBeNull();
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });
});

describe("the front page in a support session", () => {
  it("lists the account requests and never asks for the brokers' letters", async () => {
    // The support list (ADR 0028): site:manage opens the website's screens,
    // and the brokers' requests read under it are refused a support session.
    renderFor(
      ["association:read", "signupRequest:decide", "site:manage"],
      {},
      {
        support: {
          supporter: "Kim at the host",
          endsAt: "2026-10-20T20:00:00.000Z",
        },
      },
    );

    await within(row("Kontoansökningar att besluta om")).findByText("1");
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      ["Kontoansökningar att besluta om"],
    );
    expect(requested).not.toContain("/api/broker-update-requests");
  });
});

describe("the front page for a property manager", () => {
  it("is not offered, and asks for nothing, not even the one queue they work", () => {
    /*
     * The front page gathers two or more board pages, and the property
     * manager has one: their section is the issue queue itself, under its own
     * sign (ADR 0049, decision 4). Opening /board by hand is refused as it is
     * for anybody else the band does not offer it to, rather than a second
     * signed page summing the same queue.
     */
    renderFor(PROPERTY_MANAGER);

    expect(
      screen.getByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(
      screen.queryByText("Styrelse och förvaltare", { exact: true }),
    ).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(requested).toEqual([]);
  });
});

describe("who the page is for", () => {
  it("is not offered to a resident, and asks for nothing", () => {
    renderFor(RESIDENT);

    expect(
      screen.getByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(requested).toEqual([]);
  });

  it("says so in words to a board account that works no queue", () => {
    // Offered the front page, because the band offers it two board pages to
    // gather, and still no queue of its own.
    renderFor(["fees:manage", "memberCharges:manage"]);

    expect(
      screen.getByRole("heading", { level: 1, name: /Att hantera$/ }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Du arbetar inte med någon av styrelsens köer. Det du kan göra finns under Styrelsen i menyn.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(requested).toEqual([]);
  });
});

describe("a failed read", () => {
  it("puts a failed queue's error on its own row and reads it again on retry", async () => {
    renderFor(BOARD_MEMBER, { "/api/sublet-queue": failed });
    const sublets = row("Ansökningar om andrahandsupplåtelse att besluta om");

    expect(await within(sublets).findByText("Kunde inte läsas.")).toBeTruthy();
    // The other rows keep their counts.
    expect(await within(row("Nya ärenden")).findByText("3")).toBeTruthy();
    expect(screen.getAllByText("Försök igen")).toHaveLength(1);

    answered["/api/sublet-queue"] = ok({ applications: [{ id: "a" }] });
    await userEvent.click(
      within(sublets).getByRole("button", { name: "Försök igen" }),
    );

    expect(await within(sublets).findByText("1")).toBeTruthy();
    expect(within(sublets).queryByText("Kunde inte läsas.")).toBeNull();
  });
});
