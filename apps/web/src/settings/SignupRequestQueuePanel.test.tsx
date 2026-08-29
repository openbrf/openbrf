import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { AddressView } from "../api/instance";
import { SignupRequestQueuePanel } from "./SignupRequestQueuePanel";

/**
 * The board's queue.
 *
 * The claim is free text - the public form must not enumerate the register
 * before sign-in - so the decision this panel exists for is a human matching
 * what somebody wrote against a real apartment. Two of its refusals are worth
 * testing on their own, because both would be read wrongly if they were shown
 * as an ordinary failure: an approval that could not send its invitation has
 * already created the person and the residency, and a request somebody else has
 * decided is not a request to try again.
 */

const fetchSignupRequests = vi.fn();
const approveSignupRequest = vi.fn();
const rejectSignupRequest = vi.fn();
const fetchApartments = vi.fn();

vi.mock("../api/signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/signup")>()),
  fetchSignupRequests: () => fetchSignupRequests(),
  approveSignupRequest: (id: string, input: unknown) =>
    approveSignupRequest(id, input),
  rejectSignupRequest: (id: string, input: unknown) =>
    rejectSignupRequest(id, input),
}));

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchApartments: (addressId: string) => fetchApartments(addressId),
}));

const ADDRESSES: readonly AddressView[] = [
  {
    id: "address-12",
    street: "Storgatan",
    number: "12",
    postalCode: "11122",
    city: "Stockholm",
    sortOrder: 1,
    apartmentCount: 2,
  },
];

const REQUEST = {
  id: "request-1",
  firstName: "Elsa",
  lastName: "Norberg",
  email: "elsa@exempel.se",
  claimedAddress: "storgatan 12, tv",
  claimedApartmentNumber: "1203",
  createdAt: "2026-08-27T09:30:00.000Z",
};

function renderPanel() {
  return render(<SignupRequestQueuePanel addresses={ADDRESSES} />);
}

const row = () => screen.getByRole("listitem");
const approveButton = () => screen.getByRole("button", { name: "Godkänn" });

/** Waits for the queue to have arrived and its apartment list with it. */
async function waitForTheRow(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Elsa Norberg" })).toBeTruthy();
  });
  await waitFor(() => {
    expect(
      within(screen.getByLabelText("Lägenhet i registret")).getByRole(
        "option",
        {
          name: "1203",
        },
      ),
    ).toBeTruthy();
  });
}

beforeEach(() => {
  fetchSignupRequests.mockReset().mockResolvedValue({
    ok: true,
    value: [REQUEST],
  });
  approveSignupRequest
    .mockReset()
    .mockResolvedValue({ ok: true, value: { personId: "person-1" } });
  rejectSignupRequest.mockReset().mockResolvedValue({ ok: true });
  fetchApartments.mockReset().mockResolvedValue({
    ok: true,
    value: [
      { id: "apartment-1203", number: "1203", floor: 2 },
      { id: "apartment-1204", number: "1204", floor: 2 },
    ],
  });
});

describe("what a row shows", () => {
  it("renders the applicant and the claim as it was written", async () => {
    renderPanel();

    await waitForTheRow();
    const entry = within(row());
    expect(entry.getByText("elsa@exempel.se")).toBeTruthy();

    // Verbatim: the lower-case street and the trailing "tv" are what the board
    // is judging, and a screen that tidied them up would be answering a
    // different question from the one that was asked.
    const claim = entry
      .getByText("Uppgiven adress och lägenhet")
      .closest("p")?.textContent;
    expect(claim).toContain("storgatan 12, tv");
    expect(claim).toContain("1203");

    expect(entry.getByText("Inkom").closest("p")?.textContent).toContain(
      "2026-08-27",
    );
  });

  it("says the queue is empty rather than showing nothing", async () => {
    fetchSignupRequests.mockResolvedValue({ ok: true, value: [] });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText("Inga ansökningar väntar.")).toBeTruthy();
    });
  });

  it("names a failed read instead of reporting an empty queue", async () => {
    // The two look identical and mean opposite things: one invites the board to
    // close the screen, the other hides somebody who has been waiting.
    fetchSignupRequests.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/kunde inte hämtas just nu/i)).toBeTruthy();
    });
  });
});

describe("approving", () => {
  it("waits for a real apartment before it offers the decision", async () => {
    renderPanel();

    await waitForTheRow();
    // The claim is free text and matches nothing on its own.
    expect(approveButton()).toHaveProperty("disabled", true);
  });

  it("approves against the chosen apartment and never sends a role", async () => {
    const session = userEvent.setup();
    renderPanel();

    await waitForTheRow();
    await session.selectOptions(
      screen.getByLabelText("Lägenhet i registret"),
      "apartment-1203",
    );
    await session.click(approveButton());

    await waitFor(() => {
      expect(approveSignupRequest).toHaveBeenCalledWith("request-1", {
        apartmentId: "apartment-1203",
      });
    });
    // A self-signup never grants membership: the API records a resident, and
    // sending a role from here would be a way to ask for one.
    expect(screen.getByRole("status").textContent).toContain("elsa@exempel.se");
  });

  it("says the approval landed even when the invitation could not be sent", async () => {
    approveSignupRequest.mockResolvedValue({
      ok: false,
      failure: { status: 503, reason: "mail-not-configured" },
    });

    const session = userEvent.setup();
    renderPanel();

    await waitForTheRow();
    await session.selectOptions(
      screen.getByLabelText("Lägenhet i registret"),
      "apartment-1203",
    );
    await session.click(approveButton());

    await waitFor(() => {
      /*
       * The person, the residency and the invitation are written before the
       * email goes out, so this is not a failed approval. A board told "that
       * could not be saved" would approve the same request again and put a
       * second residency on the apartment.
       */
      expect(screen.getByRole("alert").textContent).toContain(
        "Ansökan är godkänd och personen finns i registret",
      );
    });
  });

  it("reads the queue again when somebody else has already decided", async () => {
    approveSignupRequest.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "already-decided" },
    });

    const session = userEvent.setup();
    renderPanel();

    await waitForTheRow();
    await session.selectOptions(
      screen.getByLabelText("Lägenhet i registret"),
      "apartment-1203",
    );
    await session.click(approveButton());

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "redan avgjort den ansökan",
      );
    });
    expect(fetchSignupRequests).toHaveBeenCalledTimes(2);
  });
});

describe("rejecting", () => {
  it("sends the reason the board wrote", async () => {
    const session = userEvent.setup();
    renderPanel();

    await waitForTheRow();
    await session.type(
      screen.getByLabelText("Skäl (frivilligt)"),
      "Ingen boende på den adressen",
    );
    await session.click(screen.getByRole("button", { name: "Avslå" }));

    await waitFor(() => {
      expect(rejectSignupRequest).toHaveBeenCalledWith("request-1", {
        reason: "Ingen boende på den adressen",
      });
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Ingenting skapades",
    );
  });

  it("leaves the reason out entirely when none was written", async () => {
    const session = userEvent.setup();
    renderPanel();

    await waitForTheRow();
    await session.click(screen.getByRole("button", { name: "Avslå" }));

    await waitFor(() => {
      expect(rejectSignupRequest).toHaveBeenCalledWith("request-1", {});
    });
  });
});
