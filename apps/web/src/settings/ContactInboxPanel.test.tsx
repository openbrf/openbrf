import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContactSubmission } from "../api/contact";
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
const deleteContactSubmission = vi.fn();
const deleteContactSubmissions = vi.fn();

vi.mock("../api/contact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/contact")>()),
  fetchContactSubmissions: (cursor?: string) => fetchContactSubmissions(cursor),
  setContactSubmissionHandled: (id: string, handled: boolean) =>
    setContactSubmissionHandled(id, handled),
  deleteContactSubmission: (id: string) => deleteContactSubmission(id),
  deleteContactSubmissions: (ids: readonly string[]) =>
    deleteContactSubmissions(ids),
}));

const MESSAGE: ContactSubmission = {
  id: "message-1",
  name: "Bo Ek",
  email: "bo@exempel.se",
  message: "Porten mot gatan går inte att stänga.\nDen står på glänt.",
  handled: false,
  handledAt: null,
  createdAt: "2026-08-27T09:30:00.000Z",
};

/** One page of the inbox as the API answers it. */
function page(
  submissions: readonly ContactSubmission[],
  nextCursor: string | null = null,
) {
  return {
    ok: true,
    value: {
      submissions,
      unhandled: submissions.filter((one) => !one.handled).length,
      total: submissions.length,
      nextCursor,
    },
  };
}

const row = () => screen.getByRole("listitem");

beforeEach(() => {
  vi.clearAllMocks();
  fetchContactSubmissions.mockResolvedValue(page([MESSAGE]));
  setContactSubmissionHandled.mockResolvedValue({
    ok: true,
    value: { ...MESSAGE, handled: true, handledAt: "2026-08-28T08:00:00.000Z" },
  });
  deleteContactSubmission.mockResolvedValue({ ok: true, value: undefined });
  deleteContactSubmissions.mockResolvedValue({
    ok: true,
    value: { removed: 2 },
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
    fetchContactSubmissions.mockResolvedValue(
      page([{ ...MESSAGE, name: null }]),
    );

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

    fetchContactSubmissions.mockResolvedValue(
      page([
        { ...MESSAGE, handled: true, handledAt: "2026-08-28T08:00:00.000Z" },
      ]),
    );

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

  it("asks before it removes a message, and there is no undoing it", async () => {
    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(row()).toBeTruthy();
    });

    // The first press only arms it. Nothing behind this recovers a message, and
    // the board is deleting somebody else's words about their own situation.
    await userEvent.click(screen.getByRole("button", { name: "Radera" }));
    expect(deleteContactSubmission).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Tar bort meddelandet från instansen. Det går inte att ångra.",
      ),
    ).toBeTruthy();

    fetchContactSubmissions.mockResolvedValue(page([]));
    await userEvent.click(screen.getByRole("button", { name: "Radera" }));

    expect(deleteContactSubmission).toHaveBeenCalledWith("message-1");
    await waitFor(() => {
      expect(screen.getByText("Inga meddelanden har kommit in.")).toBeTruthy();
    });
  });

  it("takes reaching for the other action as a change of mind", async () => {
    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(row()).toBeTruthy();
    });

    await userEvent.click(screen.getByRole("button", { name: "Radera" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Markera som hanterat" }),
    );

    expect(deleteContactSubmission).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByText(
          "Tar bort meddelandet från instansen. Det går inte att ångra.",
        ),
      ).toBeNull();
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

  it("says how many are waiting and reads on past the first page", async () => {
    const later = { ...MESSAGE, id: "message-2", name: "Ada Al" };
    fetchContactSubmissions.mockImplementation((cursor?: string) =>
      Promise.resolve(
        cursor === undefined
          ? {
              ok: true,
              value: {
                submissions: [MESSAGE],
                unhandled: 2,
                total: 2,
                nextCursor: "after-1",
              },
            }
          : page([later]),
      ),
    );

    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(screen.getByText("Väntar: 2. Totalt: 2.")).toBeTruthy();
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Visa fler meddelanden" }),
    );

    expect(fetchContactSubmissions).toHaveBeenLastCalledWith("after-1");
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
    expect(
      screen.queryByRole("button", { name: "Visa fler meddelanden" }),
    ).toBeNull();
  });

  it("removes the selected messages together, once asked twice", async () => {
    const other = { ...MESSAGE, id: "message-2", name: "Ada Al" };
    fetchContactSubmissions.mockResolvedValue(page([MESSAGE, other]));

    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Välj alla meddelanden som visas" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Radera markerade (2)" }),
    );
    expect(deleteContactSubmissions).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Tar bort de markerade meddelandena från instansen. Det går inte att ångra.",
      ),
    ).toBeTruthy();

    fetchContactSubmissions.mockResolvedValue(page([]));
    await userEvent.click(
      screen.getByRole("button", { name: "Radera markerade (2)" }),
    );

    expect(deleteContactSubmissions).toHaveBeenCalledWith([
      "message-1",
      "message-2",
    ]);
    await waitFor(() => {
      expect(screen.getByText("Inga meddelanden har kommit in.")).toBeTruthy();
    });
  });

  it("removes a selection larger than one request may name in parts", async () => {
    // Five pages of fifty, all on screen: more than the server takes at once.
    const many = Array.from({ length: 250 }, (_, index) => ({
      ...MESSAGE,
      id: `message-${String(index + 1)}`,
    }));
    fetchContactSubmissions.mockResolvedValue(page(many));
    deleteContactSubmissions.mockImplementation((ids: readonly string[]) =>
      Promise.resolve({ ok: true, value: { removed: ids.length } }),
    );

    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(250);
    });

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Välj alla meddelanden som visas" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Radera markerade (250)" }),
    );
    fetchContactSubmissions.mockResolvedValue(page([]));
    await userEvent.click(
      screen.getByRole("button", { name: "Radera markerade (250)" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Inga meddelanden har kommit in.")).toBeTruthy();
    });
    expect(deleteContactSubmissions).toHaveBeenCalledTimes(2);
    expect(deleteContactSubmissions.mock.calls[0]?.[0]).toEqual(
      many.slice(0, 200).map((one) => one.id),
    );
    expect(deleteContactSubmissions.mock.calls[1]?.[0]).toEqual(
      many.slice(200).map((one) => one.id),
    );
  });

  it("keeps what is shown when the next page cannot be read, and tries again", async () => {
    const later = { ...MESSAGE, id: "message-2", name: "Ada Al" };
    let failNext = true;
    fetchContactSubmissions.mockImplementation((cursor?: string) => {
      if (cursor === undefined) {
        return Promise.resolve(page([MESSAGE], "after-1"));
      }
      if (failNext) {
        failNext = false;
        return Promise.resolve({
          ok: false,
          failure: { status: 500, reason: "unexpected" },
        });
      }
      return Promise.resolve(page([later]));
    });

    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(row()).toBeTruthy();
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Visa fler meddelanden" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Fler meddelanden kunde inte hämtas just nu. De som visas är kvar, och du kan försöka igen.",
        ),
      ).toBeTruthy();
    });
    expect(within(row()).getByText("Bo Ek")).toBeTruthy();
    expect(
      screen.queryByText(
        "Meddelandena kunde inte hämtas just nu. Ladda om sidan.",
      ),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Visa fler meddelanden" }),
    );

    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
    expect(
      screen.queryByText(
        "Fler meddelanden kunde inte hämtas just nu. De som visas är kvar, och du kan försöka igen.",
      ),
    ).toBeNull();
  });

  it("shows a message once when it comes round again on the next page", async () => {
    // Handled by somebody else since the first page, so it now sorts after
    // the cursor as well as having been shown before it.
    const later = { ...MESSAGE, id: "message-2", name: "Ada Al" };
    fetchContactSubmissions.mockImplementation((cursor?: string) =>
      Promise.resolve(
        cursor === undefined
          ? page([MESSAGE], "after-1")
          : page([later, { ...MESSAGE, handled: true }]),
      ),
    );

    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(row()).toBeTruthy();
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Visa fler meddelanden" }),
    );

    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
    expect(screen.getAllByText("Bo Ek")).toHaveLength(1);
  });

  it("stays busy until the list is read again after an action", async () => {
    fetchContactSubmissions.mockResolvedValue(page([MESSAGE], "after-1"));
    let answer: (value: unknown) => void = () => undefined;

    render(<ContactInboxPanel />);
    await waitFor(() => {
      expect(row()).toBeTruthy();
    });

    fetchContactSubmissions.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Markera som hanterat" }),
    );

    // Saved, and the list not back yet: reading on now would append to a list
    // about to be replaced.
    await waitFor(() => {
      expect(fetchContactSubmissions).toHaveBeenCalledTimes(2);
    });
    expect(
      screen
        .getByRole("button", { name: "Visa fler meddelanden" })
        .hasAttribute("disabled"),
    ).toBe(true);

    answer(page([{ ...MESSAGE, handled: true }], "after-1"));

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Visa fler meddelanden" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
  });
});
