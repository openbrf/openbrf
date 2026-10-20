import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  BrokerUpdateRequest,
  BrokerUpdateRequestQueue,
} from "../api/broker-update-requests";
import "../i18n";
import { BrokerUpdateRequestsPanel } from "./BrokerUpdateRequestsPanel";

/**
 * The board's queue of brokers' update requests.
 *
 * What is held here: who asked and how to reach them is on the screen as the
 * broker wrote it, what they left out is said to be left out, a failed read is
 * named rather than shown as an empty queue, and a dismissal asks twice
 * because it deletes the broker's details.
 */

const fetchBrokerUpdateRequests = vi.fn();
const dismissBrokerUpdateRequest = vi.fn();

vi.mock("../api/broker-update-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/broker-update-requests")>()),
  fetchBrokerUpdateRequests: () => fetchBrokerUpdateRequests(),
  dismissBrokerUpdateRequest: (id: string) => dismissBrokerUpdateRequest(id),
}));

const OPEN: BrokerUpdateRequest = {
  id: "request-1",
  name: "Mia Mäklare",
  email: "mia@maklarbyran.example",
  brokerage: "Mäklarbyrån AB",
  apartmentReference: "LGH 1101",
  note: "Säljstart nästa vecka.\nVisning på söndag.",
  createdAt: "2026-10-12T09:30:00.000Z",
  answeredAt: null,
};

const ADDRESS_ONLY: BrokerUpdateRequest = {
  ...OPEN,
  id: "request-2",
  name: null,
  email: "per@maklarbyran.example",
  brokerage: null,
  apartmentReference: null,
  note: null,
};

const ANSWERED: BrokerUpdateRequest = {
  ...OPEN,
  id: "request-3",
  name: "Eva Mäklare",
  answeredAt: "2026-10-15T08:00:00.000Z",
};

function queue(overrides: Partial<BrokerUpdateRequestQueue> = {}): {
  ok: true;
  value: BrokerUpdateRequestQueue;
} {
  const value = { open: [OPEN], answered: [], openTotal: 1, ...overrides };
  return { ok: true, value };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchBrokerUpdateRequests.mockResolvedValue(queue());
  dismissBrokerUpdateRequest.mockResolvedValue({ ok: true, value: undefined });
});

const rowFor = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole("heading", { name })).closest("li") as HTMLElement;

describe("the update request queue", () => {
  it("shows who asked, how to reach them, about which apartment and when", async () => {
    render(<BrokerUpdateRequestsPanel />);

    const row = within(await rowFor("Mia Mäklare"));
    expect(row.getByText("Mäklarbyrån AB")).toBeTruthy();
    expect(row.getByText("mia@maklarbyran.example")).toBeTruthy();
    expect(row.getByText("Lägenhet").nextElementSibling?.textContent).toBe(
      "LGH 1101",
    );
    expect(row.getByText("Inkom").nextElementSibling?.textContent).toBe(
      "2026-10-12",
    );
    // The broker's own words, line breaks and all.
    expect(row.getByText(/Säljstart nästa vecka/).textContent).toBe(
      "Säljstart nästa vecka.\nVisning på söndag.",
    );
  });

  it("says what a broker who gave only an address left out", async () => {
    fetchBrokerUpdateRequests.mockResolvedValue(
      queue({ open: [ADDRESS_ONLY], openTotal: 1 }),
    );
    render(<BrokerUpdateRequestsPanel />);

    const row = within(await rowFor("Inget namn angivet"));
    expect(row.getByText("per@maklarbyran.example")).toBeTruthy();
    expect(row.getByText("Lägenhet").nextElementSibling?.textContent).toBe(
      "Inte angivet",
    );
  });

  it("lists the answered ones apart, with the day they were answered", async () => {
    fetchBrokerUpdateRequests.mockResolvedValue(
      queue({ open: [], answered: [ANSWERED], openTotal: 0 }),
    );
    render(<BrokerUpdateRequestsPanel />);

    expect(
      await screen.findByText("Ingen mäklare väntar på uppdaterade uppgifter."),
    ).toBeTruthy();
    const row = within(await rowFor("Eva Mäklare"));
    expect(row.getByText("Besvarad").nextElementSibling?.textContent).toBe(
      "2026-10-15",
    );
  });

  it("says how many are open when the list holds only the oldest", async () => {
    fetchBrokerUpdateRequests.mockResolvedValue(queue({ openTotal: 250 }));
    render(<BrokerUpdateRequestsPanel />);

    expect(
      await screen.findByText("De 1 äldsta av 250 öppna förfrågningar"),
    ).toBeTruthy();
  });

  it("names a failed read rather than showing an empty queue", async () => {
    fetchBrokerUpdateRequests.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    render(<BrokerUpdateRequestsPanel />);

    expect(
      await screen.findByText(
        "Förfrågningarna kunde inte läsas. Ladda om sidan för att försöka igen.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Ingen mäklare väntar på uppdaterade uppgifter."),
    ).toBeNull();
  });

  it("dismisses on the second press, and reads the queue again", async () => {
    const user = userEvent.setup();
    render(<BrokerUpdateRequestsPanel />);
    const row = within(await rowFor("Mia Mäklare"));

    await user.click(row.getByRole("button", { name: "Avfärda" }));
    expect(dismissBrokerUpdateRequest).not.toHaveBeenCalled();
    expect(
      row.getByText(
        "Tryck igen för att ta bort förfrågan och mäklarens uppgifter.",
      ),
    ).toBeTruthy();

    fetchBrokerUpdateRequests.mockResolvedValue(
      queue({ open: [], openTotal: 0 }),
    );
    await user.click(row.getByRole("button", { name: "Avfärda" }));
    expect(dismissBrokerUpdateRequest).toHaveBeenCalledWith("request-1");

    expect(
      await screen.findByText("Ingen mäklare väntar på uppdaterade uppgifter."),
    ).toBeTruthy();
    expect(fetchBrokerUpdateRequests).toHaveBeenCalledTimes(2);
  });

  it("says a request someone else removed is gone, and shows the queue as it now is", async () => {
    const user = userEvent.setup();
    dismissBrokerUpdateRequest.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });
    render(<BrokerUpdateRequestsPanel />);
    const row = within(await rowFor("Mia Mäklare"));

    fetchBrokerUpdateRequests.mockResolvedValue(
      queue({ open: [], openTotal: 0 }),
    );
    await user.click(row.getByRole("button", { name: "Avfärda" }));
    await user.click(row.getByRole("button", { name: "Avfärda" }));

    expect(
      await screen.findByText("Förfrågan har redan tagits bort."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Mia Mäklare" })).toBeNull();
    });
  });

  it("says the list may be out of date when a dismissal went through and reading it again failed", async () => {
    const user = userEvent.setup();
    render(<BrokerUpdateRequestsPanel />);
    const row = within(await rowFor("Mia Mäklare"));

    fetchBrokerUpdateRequests.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    await user.click(row.getByRole("button", { name: "Avfärda" }));
    await user.click(row.getByRole("button", { name: "Avfärda" }));

    expect(
      await screen.findByText(
        "Listan kunde inte läsas om och kan vara inaktuell. Ladda om sidan.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mia Mäklare" })).toBeTruthy();
  });

  it("keeps the list it showed when reading it again fails", async () => {
    const user = userEvent.setup();
    render(<BrokerUpdateRequestsPanel />);
    const row = within(await rowFor("Mia Mäklare"));

    dismissBrokerUpdateRequest.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    fetchBrokerUpdateRequests.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    await user.click(row.getByRole("button", { name: "Avfärda" }));
    await user.click(row.getByRole("button", { name: "Avfärda" }));

    expect(
      await screen.findByText("Förfrågan kunde inte avfärdas. Försök igen."),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mia Mäklare" })).toBeTruthy();
  });
});
