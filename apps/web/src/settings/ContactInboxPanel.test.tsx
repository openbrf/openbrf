import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ContactInboxPanel } from "./ContactInboxPanel";

/**
 * The board's inbox for the website's contact form.
 *
 * Two things are worth holding here. A message is shown as it was written -
 * the board is reading somebody's own words, so nothing is trimmed or
 * summarised on the way to the screen - and a failed read is named rather than
 * rendered as an empty inbox, because "nobody has written" and "the list could
 * not be fetched" look identical and mean opposite things.
 */

const fetchContactSubmissions = vi.fn();
const setContactSubmissionHandled = vi.fn();

vi.mock("../api/contact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/contact")>()),
  fetchContactSubmissions: () => fetchContactSubmissions(),
  setContactSubmissionHandled: (id: string, handled: boolean) =>
    setContactSubmissionHandled(id, handled),
}));

const MESSAGE = {
  id: "message-1",
  name: "Bo Ek",
  email: "bo@exempel.se",
  message: "Porten mot gatan går inte att stänga.\nDen står på glänt.",
  handled: false,
  handledAt: null,
  createdAt: "2026-08-27T09:30:00.000Z",
};

const row = () => screen.getByRole("listitem");

beforeEach(() => {
  vi.clearAllMocks();
  fetchContactSubmissions.mockResolvedValue({ ok: true, value: [MESSAGE] });
  setContactSubmissionHandled.mockResolvedValue({
    ok: true,
    value: { ...MESSAGE, handled: true, handledAt: "2026-08-28T08:00:00.000Z" },
  });
});

describe("the contact inbox", () => {
  it("shows who wrote, when, and what they wrote", async () => {
    render(<ContactInboxPanel />);

    await waitFor(() => {
      expect(row()).toBeTruthy();
    });

    const message = within(row());
    expect(message.getByText("Bo Ek")).toBeTruthy();
    expect(message.getByText("bo@exempel.se")).toBeTruthy();
    // The day, not the timestamp: the inbox is read to see how long somebody
    // has been waiting.
    expect(message.getByText("Inkom").closest("p")?.textContent).toContain(
      "2026-08-27",
    );
    expect(
      message.getByText(/Porten mot gatan går inte att stänga\./),
    ).toBeTruthy();
  });

  it("names the sender who left no name", async () => {
    fetchContactSubmissions.mockResolvedValue({
      ok: true,
      value: [{ ...MESSAGE, name: null }],
    });

    render(<ContactInboxPanel />);

    await waitFor(() => {
      expect(screen.getByText("Inget namn angivet")).toBeTruthy();
    });
  });

  it("marks a message handled and reads the list again", async () => {
    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(row()).toBeTruthy();
    });

    fetchContactSubmissions.mockResolvedValue({
      ok: true,
      value: [
        { ...MESSAGE, handled: true, handledAt: "2026-08-28T08:00:00.000Z" },
      ],
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Markera som hanterat" }),
    );

    expect(setContactSubmissionHandled).toHaveBeenCalledWith("message-1", true);
    // The row comes back as it now stands, so the button offers the way back
    // rather than the same action a second time.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Markera som ohanterat" }),
      ).toBeTruthy();
    });
  });

  it("says the inbox could not be read rather than showing it as empty", async () => {
    fetchContactSubmissions.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<ContactInboxPanel />);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Meddelandena kunde inte hämtas just nu. Ladda om sidan.",
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Inga meddelanden har kommit in.")).toBeNull();
  });

  it("reports a message that is gone in its own words", async () => {
    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(row()).toBeTruthy();
    });

    setContactSubmissionHandled.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Markera som hanterat" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Meddelandet finns inte kvar. Listan är hämtad på nytt.",
        ),
      ).toBeTruthy();
    });
  });
});
