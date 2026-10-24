import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
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
const sendBrokerAccessReport = vi.fn();

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

vi.mock("../api/broker-update-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/broker-update-requests")>()),
  fetchBrokerUpdateRequests: () => fetchBrokerUpdateRequests(),
  dismissBrokerUpdateRequest: (id: string) => dismissBrokerUpdateRequest(id),
  sendBrokerAccessReport: (email: string) => sendBrokerAccessReport(email),
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
  sendBrokerAccessReport.mockResolvedValue({
    ok: true,
    value: { requests: 2 },
  });
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

describe("answering the queue", () => {
  it("names where the facts are confirmed, and links there", async () => {
    render(<BrokerUpdateRequestsPanel />);

    expect(
      screen.getByText(
        /öppna Webbplatsen och spara eller bekräfta uppgifterna under Föreningens uppgifter/,
      ),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "Öppna Webbplatsen" });
    expect(link.getAttribute("href")).toBe("/board/site");
  });
});

describe("a broker asking what is held about them", () => {
  const field = (): HTMLElement =>
    screen.getByRole("textbox", { name: "Mäklarens e-postadress" });
  const button = (): HTMLElement =>
    screen.getByRole("button", { name: "Skicka det som finns" });

  it("sends the address and says where the extract went and how much it held", async () => {
    const user = userEvent.setup();
    render(<BrokerUpdateRequestsPanel />);

    await user.type(field(), " mia@maklarbyran.example ");
    await user.click(button());

    expect(sendBrokerAccessReport).toHaveBeenCalledExactlyOnceWith(
      "mia@maklarbyran.example",
    );
    expect(
      await screen.findByText(
        "Skickat till mia@maklarbyran.example: 2 förfrågningar.",
      ),
    ).toBeTruthy();
  });

  it("says so when nothing was held under the address", async () => {
    sendBrokerAccessReport.mockResolvedValue({
      ok: true,
      value: { requests: 0 },
    });
    const user = userEvent.setup();
    render(<BrokerUpdateRequestsPanel />);

    await user.type(field(), "per@maklarbyran.example");
    await user.click(button());

    expect(
      await screen.findByText(
        "Skickat till per@maklarbyran.example: föreningen har ingen förfrågan under den adressen.",
      ),
    ).toBeTruthy();
  });

  it("sends nothing for an empty address", async () => {
    const user = userEvent.setup();
    render(<BrokerUpdateRequestsPanel />);

    await user.type(field(), "   ");
    expect(button().hasAttribute("disabled")).toBe(true);
    expect(sendBrokerAccessReport).not.toHaveBeenCalled();
  });

  it("sends one at a time", async () => {
    let answer: (value: unknown) => void = () => undefined;
    sendBrokerAccessReport.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<BrokerUpdateRequestsPanel />);

    await user.type(field(), "mia@maklarbyran.example");
    await user.click(button());
    const sending = screen.getByRole("button", { name: "Skickar..." });
    expect(sending.hasAttribute("disabled")).toBe(true);
    await user.click(sending);
    expect(sendBrokerAccessReport).toHaveBeenCalledOnce();

    answer({ ok: true, value: { requests: 1 } });
    expect(
      await screen.findByText(
        "Skickat till mia@maklarbyran.example: 1 förfrågan.",
      ),
    ).toBeTruthy();
  });

  it("names an instance that cannot send mail, and clears it once the address changes", async () => {
    sendBrokerAccessReport.mockResolvedValue({
      ok: false,
      failure: { status: 503, reason: "mail-not-configured" },
    });
    const user = userEvent.setup();
    render(<BrokerUpdateRequestsPanel />);

    await user.type(field(), "mia@maklarbyran.example");
    await user.click(button());
    const refusal =
      "Instansen har inga e-postinställningar, så inget kunde skickas.";
    expect(await screen.findByText(refusal)).toBeTruthy();

    await user.type(field(), "x");
    await waitFor(() => {
      expect(screen.queryByText(refusal)).toBeNull();
    });
  });
});
