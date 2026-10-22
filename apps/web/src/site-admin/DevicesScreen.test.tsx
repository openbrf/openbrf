import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { DevicesScreen } from "./DevicesScreen";
import type { DeviceToken } from "./devices-api";

/**
 * The board's devices screen (ADR 0031): what it lists of each live device
 * token, and that revoking one is two presses that send the token's id and
 * then read the list again.
 */

const fetchDeviceTokens = vi.fn();
const revokeDeviceToken = vi.fn();

vi.mock("./devices-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./devices-api")>()),
  fetchDeviceTokens: () => fetchDeviceTokens(),
  revokeDeviceToken: (id: string) => revokeDeviceToken(id),
}));

const DEVICE: DeviceToken = {
  id: "device-token-1",
  pluginId: "signage",
  route: "screen",
  subject: "scr_1",
  label: "Entré B, bottenvåningen",
  issuedAt: "2026-10-01T08:30:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  issuedBy: { personId: "person-1", name: "Mia Modig" },
};

const listed = (devices: DeviceToken[]) => ({
  ok: true,
  value: { devices },
});

beforeEach(() => {
  fetchDeviceTokens.mockReset();
  revokeDeviceToken.mockReset();
});

describe("the devices screen", () => {
  it("says so when no device holds a token", async () => {
    fetchDeviceTokens.mockResolvedValue(listed([]));

    render(<DevicesScreen />);

    expect(
      await screen.findByText("Ingen enhet har något token."),
    ).toBeTruthy();
  });

  it("lists each device with its plugin, who issued it and when it was last used", async () => {
    fetchDeviceTokens.mockResolvedValue(
      listed([
        DEVICE,
        {
          ...DEVICE,
          id: "device-token-2",
          label: "Tvättstugan",
          lastUsedAt: "2026-10-19T06:00:00.000Z",
          issuedBy: null,
        },
      ]),
    );

    render(<DevicesScreen />);

    expect(await screen.findByText("Entré B, bottenvåningen")).toBeTruthy();
    expect(screen.getByText("Tvättstugan")).toBeTruthy();
    expect(screen.getAllByText("signage")).toHaveLength(2);
    expect(screen.getByText("Mia Modig")).toBeTruthy();
    expect(
      screen.getByText("Någon som inte längre finns i registret"),
    ).toBeTruthy();
    // A device that has not called since it was issued says so in words.
    expect(screen.getByText("Aldrig")).toBeTruthy();
  });

  it("offers to read the list again when it could not be read", async () => {
    fetchDeviceTokens.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<DevicesScreen />);

    expect(
      await screen.findByText("Enheterna kunde inte läsas in."),
    ).toBeTruthy();
  });

  it("revokes a token on the second press, and reads the list again", async () => {
    fetchDeviceTokens
      .mockResolvedValueOnce(listed([DEVICE]))
      .mockResolvedValueOnce(listed([]));
    revokeDeviceToken.mockResolvedValue({ ok: true, value: { revoked: true } });
    const session = userEvent.setup();

    render(<DevicesScreen />);
    await session.click(
      await screen.findByRole("button", {
        name: "Återkalla token för Entré B, bottenvåningen",
      }),
    );
    expect(revokeDeviceToken).not.toHaveBeenCalled();

    await session.click(
      screen.getByRole("button", { name: "Återkalla token" }),
    );

    await waitFor(() => {
      expect(revokeDeviceToken).toHaveBeenCalledWith("device-token-1");
    });
    expect(
      await screen.findByText("Ingen enhet har något token."),
    ).toBeTruthy();
  });

  it("says a token is already revoked rather than that the revoke failed", async () => {
    fetchDeviceTokens.mockResolvedValue(listed([DEVICE]));
    revokeDeviceToken.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "device-token-not-found" },
    });
    const session = userEvent.setup();

    render(<DevicesScreen />);
    await session.click(
      await screen.findByRole("button", {
        name: "Återkalla token för Entré B, bottenvåningen",
      }),
    );
    await session.click(
      screen.getByRole("button", { name: "Återkalla token" }),
    );

    expect(
      await screen.findByText(
        "Det token är redan återkallat. Läs in listan igen.",
      ),
    ).toBeTruthy();
  });
});
