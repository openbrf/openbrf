import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueSavedReply } from "../api/issues";
import { IssueSavedRepliesPanel } from "./IssueSavedRepliesPanel";

/**
 * The association's saved replies (decision 17), as the board writes them.
 *
 * Added, changed only when something changed, removed, and a refusal said in
 * words with the draft kept.
 */

const fetchConfiguredSavedReplies = vi.fn();
const createIssueSavedReply = vi.fn();
const updateIssueSavedReply = vi.fn();
const removeIssueSavedReply = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchConfiguredSavedReplies: () => fetchConfiguredSavedReplies(),
  createIssueSavedReply: (input: unknown) => createIssueSavedReply(input),
  updateIssueSavedReply: (input: unknown) => updateIssueSavedReply(input),
  removeIssueSavedReply: (id: string) => removeIssueSavedReply(id),
}));

const BYLAWS: IssueSavedReply = {
  id: "r-1",
  title: "Ditt ansvar enligt stadgarna",
  body: "Enligt stadgarna är det ditt ansvar.",
  sortOrder: 0,
};

beforeEach(() => {
  fetchConfiguredSavedReplies
    .mockReset()
    .mockResolvedValue({ ok: true, value: [BYLAWS] });
  createIssueSavedReply
    .mockReset()
    .mockResolvedValue({ ok: true, value: BYLAWS });
  updateIssueSavedReply
    .mockReset()
    .mockResolvedValue({ ok: true, value: BYLAWS });
  removeIssueSavedReply
    .mockReset()
    .mockResolvedValue({ ok: true, value: undefined });
});

describe("the saved replies", () => {
  it("adds one and reads the list again", async () => {
    const session = userEvent.setup();
    render(<IssueSavedRepliesPanel />);
    await screen.findByDisplayValue("Ditt ansvar enligt stadgarna");

    const [, titleField] = screen.getAllByLabelText("Namn");
    const [, bodyField] = screen.getAllByLabelText("Text");
    await session.type(titleField as HTMLElement, "Tack");
    await session.type(bodyField as HTMLElement, "Tack för din anmälan.");
    await session.click(screen.getByRole("button", { name: "Lägg till" }));

    await waitFor(() => {
      expect(createIssueSavedReply).toHaveBeenCalledWith({
        title: "Tack",
        body: "Tack för din anmälan.",
      });
    });
    await waitFor(() => {
      expect(fetchConfiguredSavedReplies).toHaveBeenCalledTimes(2);
    });
  });

  it("offers to save a reply only once it changed, and removes one", async () => {
    const session = userEvent.setup();
    render(<IssueSavedRepliesPanel />);

    const body = await screen.findByLabelText(
      "Ditt ansvar enligt stadgarna: text",
    );
    const save = screen.getByRole("button", { name: "Spara" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await session.type(body, " Läs stadgarna.");
    await session.click(save);
    await waitFor(() => {
      expect(updateIssueSavedReply).toHaveBeenCalledWith({
        id: "r-1",
        values: {
          title: "Ditt ansvar enligt stadgarna",
          body: "Enligt stadgarna är det ditt ansvar. Läs stadgarna.",
          sortOrder: 0,
        },
      });
    });

    // The list is read again after the removal, and no longer holds the reply.
    fetchConfiguredSavedReplies.mockResolvedValue({ ok: true, value: [] });
    await session.click(
      screen.getByRole("button", {
        name: "Ta bort Ditt ansvar enligt stadgarna",
      }),
    );
    await waitFor(() => {
      expect(removeIssueSavedReply).toHaveBeenCalledWith("r-1");
    });
    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("Ditt ansvar enligt stadgarna"),
      ).toBeNull();
    });
  });

  it("says why a reply carrying a personal identity number was refused", async () => {
    createIssueSavedReply.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });
    const session = userEvent.setup();
    render(<IssueSavedRepliesPanel />);
    await screen.findByDisplayValue("Ditt ansvar enligt stadgarna");

    const [, titleField] = screen.getAllByLabelText("Namn");
    const [, bodyField] = screen.getAllByLabelText("Text");
    await session.type(titleField as HTMLElement, "Nummer");
    await session.type(bodyField as HTMLElement, "Ring 19811218-9876");
    await session.click(screen.getByRole("button", { name: "Lägg till" }));

    expect(
      await screen.findByText(
        "Texten innehåller ett personnummer. Ta bort det och spara igen.",
      ),
    ).toBeTruthy();
    // The draft is kept to change.
    expect((bodyField as HTMLTextAreaElement).value).toBe("Ring 19811218-9876");
  });

  it("offers a retry when the first read fails, and shows the list once it works", async () => {
    fetchConfiguredSavedReplies.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unknown" },
    });
    const session = userEvent.setup();
    render(<IssueSavedRepliesPanel />);

    expect(
      await screen.findByText("De sparade svaren gick inte att läsa just nu."),
    ).toBeTruthy();
    await session.click(screen.getByRole("button", { name: "Försök igen" }));

    await screen.findByDisplayValue("Ditt ansvar enligt stadgarna");
    expect(fetchConfiguredSavedReplies).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("De sparade svaren gick inte att läsa just nu."),
    ).toBeNull();
  });

  it("keeps the retry in view while a refused write is said, when the list could not be read again", async () => {
    createIssueSavedReply.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });
    const session = userEvent.setup();
    render(<IssueSavedRepliesPanel />);
    await screen.findByDisplayValue("Ditt ansvar enligt stadgarna");

    // The re-read that follows the refusal fails.
    fetchConfiguredSavedReplies.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unknown" },
    });
    const [, titleField] = screen.getAllByLabelText("Namn");
    const [, bodyField] = screen.getAllByLabelText("Text");
    await session.type(titleField as HTMLElement, "Nummer");
    await session.type(bodyField as HTMLElement, "Ring 19811218-9876");
    await session.click(screen.getByRole("button", { name: "Lägg till" }));

    expect(
      await screen.findByText(
        "Texten innehåller ett personnummer. Ta bort det och spara igen.",
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText("De sparade svaren gick inte att läsa just nu."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Försök igen" })).toBeTruthy();
  });
});
