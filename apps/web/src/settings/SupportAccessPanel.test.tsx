import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SupportAccessOverview, SupportAccessView } from "../api/support";
import "../i18n";
import { SupportAccessPanel } from "./SupportAccessPanel";

/**
 * Opening and closing support access from the settings (ADR 0028).
 *
 * The form says the reason is kept for good before it is sent, offers the five
 * durations and nothing else, and is not there at all for a viewer who may
 * only read; an open access shows who may be looking and offers the close.
 */

const fetchSupportAccess = vi.fn();
const openSupportAccess = vi.fn();
const closeSupportAccess = vi.fn();

vi.mock("../api/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/support")>()),
  fetchSupportAccess: () => fetchSupportAccess(),
  openSupportAccess: (input: unknown) => openSupportAccess(input),
  closeSupportAccess: (id: string) => closeSupportAccess(id),
}));

const OPEN: SupportAccessView = {
  id: "access-1",
  state: "open",
  openedAt: "2026-10-20T08:00:00.000Z",
  openedBy: { personId: "admin-1", name: "Astrid Admin" },
  endsAt: "2026-10-20T16:00:00.000Z",
  closedAt: null,
  closedBy: null,
  sessions: [
    {
      id: "session-1",
      supporter: "Kim at the host",
      issuedAt: "2026-10-20T08:05:00.000Z",
      startedAt: "2026-10-20T08:06:00.000Z",
      expiresAt: "2026-10-20T16:00:00.000Z",
      endedAt: null,
    },
  ],
};

const LAPSED: SupportAccessView = {
  ...OPEN,
  id: "access-0",
  state: "lapsed",
  sessions: [],
};

function overview(value: SupportAccessOverview): void {
  fetchSupportAccess.mockResolvedValue({ ok: true, value });
}

beforeEach(() => {
  fetchSupportAccess.mockReset();
  openSupportAccess.mockReset().mockResolvedValue({ ok: true, value: OPEN });
  closeSupportAccess
    .mockReset()
    .mockResolvedValue({ ok: true, value: undefined });
});

describe("with no access open", () => {
  it("opens one for the hours chosen with the reason given, trimmed", async () => {
    overview({ open: null, accesses: [] });
    render(<SupportAccessPanel editable />);

    const hours = await screen.findByLabelText("Öppen i");
    expect(
      [...(hours as HTMLSelectElement).options].map((option) => option.value),
    ).toEqual(["1", "8", "24", "72", "168"]);
    fireEvent.change(hours, { target: { value: "72" } });
    await userEvent.type(
      screen.getByLabelText(/Anledning/),
      "  Invitations are not arriving.  ",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Öppna supportåtkomst" }),
    );

    await waitFor(() => {
      expect(openSupportAccess).toHaveBeenCalledWith({
        hours: 72,
        reason: "Invitations are not arriving.",
      });
    });
    // Read again, so the panel shows what was opened.
    expect(fetchSupportAccess).toHaveBeenCalledTimes(2);
  });

  it("says the reason is kept for good before it is sent", async () => {
    overview({ open: null, accesses: [] });
    render(<SupportAccessPanel editable />);

    expect(await screen.findByText(/sparas där för alltid/)).toBeTruthy();
  });

  it("does not send a blank reason", async () => {
    overview({ open: null, accesses: [] });
    render(<SupportAccessPanel editable />);

    const open = await screen.findByRole("button", {
      name: "Öppna supportåtkomst",
    });
    await userEvent.type(screen.getByLabelText(/Anledning/), "   ");

    expect((open as HTMLButtonElement).disabled).toBe(true);
    expect(openSupportAccess).not.toHaveBeenCalled();
  });

  it("names the refusal when another administrator opened one first", async () => {
    overview({ open: null, accesses: [] });
    openSupportAccess.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "support-access-open" },
    });
    render(<SupportAccessPanel editable />);

    await userEvent.type(await screen.findByLabelText(/Anledning/), "Why.");
    await userEvent.click(
      screen.getByRole("button", { name: "Öppna supportåtkomst" }),
    );

    expect(
      await screen.findByText(/Supportåtkomst är redan öppen/),
    ).toBeTruthy();
  });

  it("offers no form to a viewer who may only read", async () => {
    overview({ open: null, accesses: [] });
    render(<SupportAccessPanel editable={false} />);

    expect(
      await screen.findByText("Ingen supportåtkomst är öppen."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText(/Anledning/)).toBeNull();
  });
});

describe("with an access open", () => {
  it("shows who opened it, who signed in, and offers the close", async () => {
    overview({ open: OPEN, accesses: [OPEN, LAPSED] });
    render(<SupportAccessPanel editable />);

    expect(await screen.findByText(/Öppnad av Astrid Admin/)).toBeTruthy();
    expect(screen.getAllByText("Kim at the host")).toHaveLength(1);
    expect(screen.getByText("Förfallen")).toBeTruthy();
    expect(screen.queryByLabelText(/Anledning/)).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Stäng supportåtkomst" }),
    );

    await waitFor(() => {
      expect(closeSupportAccess).toHaveBeenCalledWith("access-1");
    });
  });

  it("offers no close to a viewer who may only read", async () => {
    overview({ open: OPEN, accesses: [OPEN] });
    render(<SupportAccessPanel editable={false} />);

    expect(await screen.findByText(/Öppnad av Astrid Admin/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
