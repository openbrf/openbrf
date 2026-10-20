import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { OverviewScreen } from "./OverviewScreen";

/**
 * Which panels a seat is shown, and which requests the page makes for it.
 *
 * The API stands behind every panel and refuses a caller without the
 * capability, so the page asking for something it may not have would not leak
 * anything. It would put a refusal on the page of every person who opened it,
 * which is the whole reason the overview decides its panels before it asks.
 * So the fake API here refuses, as the real one does, any path the viewer's
 * capabilities do not open, and each test asserts no request was refused.
 */

/** The path the API serves and the capability its controller requires. */
const GUARDS: readonly [path: string, capability: string | null][] = [
  ["/api/me", null],
  ["/api/issues/mine", "issues:report"],
  ["/api/motions/mine", "motions:submit"],
  ["/api/sublet-applications/mine", "sublets:apply"],
  ["/api/key-orders/mine", "keyOrders:place"],
  ["/api/bookings/mine", "bookings:book"],
  ["/api/event-signups", "events:attend"],
  ["/api/news-reader", "news:comment"],
  ["/api/issue-queue", "issues:handle"],
  ["/api/board-mailbox/threads", "boardMailbox:handle"],
  ["/api/motion-queue", "motions:handle"],
  ["/api/sublet-queue", "sublets:handle"],
  ["/api/key-order-queue", "keyOrders:handle"],
  ["/api/broker-update-requests", "site:manage"],
  ["/api/signup-requests", "signupRequest:decide"],
  ["/api/feed/reports", "chat:moderate"],
];

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
const MEMBER = [...RESIDENT, "motions:submit", "sublets:apply"];
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
const BOARD_MEMBER = [...MEMBER, "addressBook:read", ...QUEUE_CAPABILITIES];
const PROPERTY_MANAGER = ["issues:handle", "self:manage"];

const ok = (value: unknown) => ({ ok: true, value });
const failed = { ok: false, failure: { status: 500, reason: "unexpected" } };

/** What each path answers with; a test overrides one to change one panel. */
type Answers = Record<string, unknown>;

function answers(): Answers {
  return {
    "/api/issues/mine": ok([
      {
        id: "issue-open",
        status: "IN_PROGRESS",
        typeId: "t",
        typeName: "Tvättstugan",
        location: null,
        description: "Maskin 2 står still.",
        apartment: null,
        photos: [],
        createdAt: "2026-10-10T08:00:00.000Z",
        updatedAt: "2026-10-10T08:00:00.000Z",
      },
      {
        id: "issue-done",
        status: "DONE",
        typeId: "t",
        typeName: "Hissen",
        location: null,
        description: "",
        apartment: null,
        photos: [],
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T08:00:00.000Z",
      },
    ]),
    "/api/motions/mine": ok({
      deadline: null,
      motions: [
        {
          id: "motion",
          title: "Laddstolpar i garaget",
          body: "",
          status: "SUBMITTED",
          submittedAt: "2026-10-12T08:00:00.000Z",
          closedAt: null,
          meeting: null,
        },
      ],
    }),
    "/api/sublet-applications/mine": ok({ apartments: [], applications: [] }),
    "/api/key-orders/mine": ok({
      apartments: [],
      orders: [
        {
          id: "order",
          apartment: null,
          kind: "TAG",
          quantity: 2,
          note: null,
          status: "SUBMITTED",
          submittedAt: "2026-10-11T08:00:00.000Z",
          closedAt: null,
          boardNote: null,
        },
      ],
    }),
    "/api/bookings/mine": ok([
      {
        id: "booking",
        resourceId: "laundry",
        resourceName: "Tvättstuga 1",
        mode: "WHOLE_DAY",
        status: "BOOKED",
        startsAt: "2026-10-21T22:00:00.000Z",
        endsAt: "2026-10-22T22:00:00.000Z",
        apartment: null,
      },
    ]),
    "/api/event-signups": ok([
      {
        occurrenceId: "occurrence",
        eventId: "event",
        title: "Höststäddag",
        description: null,
        category: null,
        location: "Gården",
        startsAt: "2026-10-24T08:00:00.000Z",
        endsAt: "2026-10-24T12:00:00.000Z",
        on: "2026-10-24",
        cancelledAt: null,
        begun: false,
        visibility: "MEMBER",
        signupOpen: true,
        capacity: null,
        placesTaken: 3,
        placesLeft: null,
        own: null,
      },
    ]),
    "/api/news-reader": ok(
      ["Vattnet stängs av", "Ny styrelse", "Sopsortering", "Äldre nyhet"].map(
        (title, index) => ({
          id: `news-${index}`,
          slug: `news-${index}`,
          title,
          content: { version: 1, blocks: [] },
          publishedAt: `2026-10-0${String(9 - index)}T08:00:00.000Z`,
        }),
      ),
    ),
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
    "/api/feed/reports": ok({ reports: [], mayModerate: true }),
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
        `the overview asked for a path this test does not know: ${path}`,
      );
    }
    const [, capability] = guard;
    if (capability !== null && !capabilities.includes(capability)) {
      refused.push(path);
      return Promise.resolve({
        ok: false,
        failure: { status: 403, reason: "forbidden" },
      });
    }
    if (bare === "/api/me") {
      return Promise.resolve(
        answered["/api/me"] ??
          ok({
            personId: "person",
            firstName: "Maja",
            lastName: "Lind",
            preferredLocale: "sv",
            capabilities,
            housingCooperative: null,
          }),
      );
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

function renderFor(seat: readonly string[], overrides: Answers = {}) {
  capabilities = seat;
  answered = { ...answers(), ...overrides };
  render(<OverviewScreen />);
}

/** A panel, found by its heading. */
async function panel(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name });
  return heading.closest('section, [role="region"]') as HTMLElement;
}

/** Every panel heading on the page, in order. */
async function panelHeadings(): Promise<string[]> {
  await screen.findAllByRole("heading", { level: 2 });
  return screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent ?? "");
}

beforeEach(() => {
  requested.length = 0;
  refused.length = 0;
});

describe("the overview for a resident", () => {
  it("shows their own matters, bookings, events and news, and nothing to handle", async () => {
    renderFor(RESIDENT);

    expect(await panelHeadings()).toEqual([
      "Väntar på föreningen",
      "Dina kommande bokningar",
      "Nästa evenemang",
      "Senaste nyheterna",
    ]);
    expect(screen.queryByRole("heading", { name: "Att hantera" })).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(screen.queryByText("Styrelse och förvaltare")).toBeNull();
    expect(await screen.findByText("Höststäddag")).toBeTruthy();
    expect(refused).toEqual([]);
  });

  it("lists what is still with the association, each with its status and a link", async () => {
    renderFor(MEMBER);
    const waiting = await panel("Väntar på föreningen");

    const issue = await within(waiting).findByRole("link", {
      name: "Tvättstugan",
    });
    expect(issue.getAttribute("href")).toBe("/issues");
    expect(
      within(waiting)
        .getByRole("link", { name: "Laddstolpar i garaget" })
        .getAttribute("href"),
    ).toBe("/motions");
    expect(
      within(waiting)
        .getByRole("link", { name: "2 x Tagg" })
        .getAttribute("href"),
    ).toBe("/key-orders");
    expect(within(waiting).getByText("Pågår")).toBeTruthy();
    expect(within(waiting).getAllByText("Hos styrelsen")).toHaveLength(2);
    // The done issue is answered, so it is not waiting.
    expect(within(waiting).queryByText("Hissen")).toBeNull();
    expect(refused).toEqual([]);
  });

  it("never asks for a member's intakes on a resident's behalf", async () => {
    renderFor(RESIDENT);
    await panel("Väntar på föreningen");

    expect(requested).not.toContain("/api/motions/mine");
    expect(requested).not.toContain("/api/sublet-applications/mine");
    expect(refused).toEqual([]);
  });

  it("shows the three newest news items", async () => {
    renderFor(RESIDENT);
    const news = await panel("Senaste nyheterna");

    expect(await within(news).findByText("Vattnet stängs av")).toBeTruthy();
    expect(within(news).getByText("Sopsortering")).toBeTruthy();
    expect(within(news).queryByText("Äldre nyhet")).toBeNull();
  });
});

describe("the overview for a board member", () => {
  it("puts a row with a count and a link for each queue above the resident panels", async () => {
    renderFor(BOARD_MEMBER);

    expect((await panelHeadings())[0]).toBe("Att hantera");
    const toHandle = await panel("Att hantera");
    const row = (name: string) =>
      within(toHandle).getByRole("link", { name }).closest("li") as HTMLElement;

    await within(toHandle).findByText("3");
    expect(within(row("Nya ärenden")).getByText("3")).toBeTruthy();
    expect(
      within(row("Obesvarade trådar i styrelsens brevlåda")).getByText("2"),
    ).toBeTruthy();
    expect(
      within(row("Motioner som inte är mottagna")).getByText("Inget väntar"),
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
      within(row("Anmälda inlägg")).getByText("Inget väntar"),
    ).toBeTruthy();

    expect(
      within(toHandle)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/issues",
      "/board-mailbox",
      "/motions",
      "/sublets",
      "/key-orders",
      "/settings/account-requests",
      "/settings/account-requests",
      "/feed",
    ]);
    expect(await screen.findByText("Väntar på föreningen")).toBeTruthy();
    expect(refused).toEqual([]);
  });

  it("sets the queues in the board's zone, signed and named for the board", async () => {
    renderFor(BOARD_MEMBER);

    const zone = await screen.findByRole("region", {
      name: "Styrelsen Att hantera",
    });
    expect(within(zone).getByText("Styrelsen")).toBeTruthy();
    expect(
      within(zone).getByText("Det här ser bara styrelsen och administratören."),
    ).toBeTruthy();
    expect(
      within(zone).getByRole("link", { name: "Nya ärenden" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("region")).toHaveLength(1);
  });

  it("says at least when a queue answered with one page of more", async () => {
    renderFor(BOARD_MEMBER, {
      "/api/motion-queue": ok({
        deadline: null,
        motions: [{ id: "a" }, { id: "b" }],
        nextCursor: "cursor",
      }),
    });
    const toHandle = await panel("Att hantera");

    expect(await within(toHandle).findByText("2 eller fler")).toBeTruthy();
  });

  it("leaves out the reported messages for an account the queue is not for", async () => {
    // The administrator's case: chat:moderate held through the grant of every
    // capability, and no board seat.
    renderFor(BOARD_MEMBER, {
      "/api/feed/reports": ok({ reports: [], mayModerate: false }),
    });
    const toHandle = await panel("Att hantera");

    await within(toHandle).findByText("3");
    expect(
      within(toHandle).queryByRole("link", {
        name: "Anmälda inlägg",
      }),
    ).toBeNull();
  });
});

describe("the overview for a property manager", () => {
  it("shows the new issues and nothing else, and asks for nothing it may not have", async () => {
    renderFor(PROPERTY_MANAGER);

    expect(await panelHeadings()).toEqual(["Att hantera"]);
    const toHandle = await panel("Att hantera");
    expect(
      within(toHandle)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Nya ärenden"]);
    expect(await within(toHandle).findByText("3")).toBeTruthy();

    const zone = screen.getByRole("region", {
      name: "Styrelse och förvaltare Att hantera",
    });
    expect(zone).toBe(toHandle);
    expect(
      within(zone).getByText(
        "Det här ser bara styrelsen, föreningens förvaltare och administratören.",
      ),
    ).toBeTruthy();

    expect(requested.toSorted()).toEqual([
      "/api/issue-queue?status=NEW",
      "/api/me",
    ]);
    expect(refused).toEqual([]);
  });
});

describe("the overview for a support session", () => {
  it("lists the account requests and never asks for the brokers' letters", async () => {
    const support = ["association:read", "signupRequest:decide", "site:manage"];
    renderFor(support, {
      "/api/me": ok({
        personId: "person",
        firstName: "Maja",
        lastName: "Lind",
        preferredLocale: "sv",
        capabilities: support,
        housingCooperative: null,
        support: {
          supporter: "Kim at the host",
          endsAt: "2026-10-20T20:00:00.000Z",
        },
      }),
    });

    const toHandle = await panel("Att hantera");
    await within(toHandle).findByText("1");
    expect(
      within(toHandle)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Kontoansökningar att besluta om"]);
    expect(requested).not.toContain("/api/broker-update-requests");
  });
});

describe("the empty states", () => {
  it("says so plainly in each panel with nothing in it", async () => {
    renderFor(MEMBER, {
      "/api/issues/mine": ok([]),
      "/api/motions/mine": ok({ deadline: null, motions: [] }),
      "/api/key-orders/mine": ok({ apartments: [], orders: [] }),
      "/api/bookings/mine": ok([]),
      "/api/event-signups": ok([]),
      "/api/news-reader": ok([]),
    });

    expect(
      await screen.findByText("Inget av det du har skickat in väntar på svar."),
    ).toBeTruthy();
    expect(
      await screen.findByText("Du har inga kommande bokningar."),
    ).toBeTruthy();
    expect(await screen.findByText("Inga evenemang är på gång.")).toBeTruthy();
    expect(
      await screen.findByText("Föreningen har inte publicerat några nyheter."),
    ).toBeTruthy();
  });

  it("says there is nothing for an account offered no panel", async () => {
    renderFor(["self:manage"]);

    expect(
      await screen.findByText(
        "Det finns ingenting på den här sidan för ditt konto.",
      ),
    ).toBeTruthy();
    expect(requested).toEqual(["/api/me"]);
  });
});

describe("a failed read", () => {
  it("puts the error on its own panel and leaves the others standing", async () => {
    renderFor(RESIDENT, { "/api/bookings/mine": failed });

    const bookings = await panel("Dina kommande bokningar");
    expect(
      await within(bookings).findByText("Dina bokningar kunde inte läsas."),
    ).toBeTruthy();
    expect(await screen.findByText("Höststäddag")).toBeTruthy();
    expect(await screen.findByText("Vattnet stängs av")).toBeTruthy();
    expect(screen.getAllByText("Försök igen")).toHaveLength(1);
  });

  it("fails the waiting panel whole when one of its reads fails", async () => {
    // A list without the motions would say nothing is waiting about one that is.
    renderFor(MEMBER, { "/api/motions/mine": failed });

    const waiting = await panel("Väntar på föreningen");
    expect(
      await within(waiting).findByText("Det du väntar på kunde inte läsas."),
    ).toBeTruthy();
    expect(within(waiting).queryByText("Tvättstugan")).toBeNull();
  });

  it("puts a failed queue's error on its own row and reads it again on retry", async () => {
    renderFor(BOARD_MEMBER, { "/api/sublet-queue": failed });
    const toHandle = await panel("Att hantera");
    const row = within(toHandle)
      .getByRole("link", {
        name: "Ansökningar om andrahandsupplåtelse att besluta om",
      })
      .closest("li") as HTMLElement;

    expect(await within(row).findByText("Kunde inte läsas.")).toBeTruthy();
    expect(await within(toHandle).findByText("3")).toBeTruthy();

    answered["/api/sublet-queue"] = ok({ applications: [{ id: "a" }] });
    await userEvent.click(
      within(row).getByRole("button", { name: "Försök igen" }),
    );

    expect(await within(row).findByText("1")).toBeTruthy();
    expect(within(row).queryByText("Kunde inte läsas.")).toBeNull();
  });

  it("says the page could not be read when the viewer cannot be", async () => {
    renderFor(RESIDENT, { "/api/me": failed });

    expect(
      await screen.findByText("Översikten kunde inte läsas."),
    ).toBeTruthy();
    expect(requested).toEqual(["/api/me"]);
  });
});
