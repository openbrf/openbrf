import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { ApiResult } from "../api/client";
import type { ConnectedApp } from "../connected-apps/connections-api";
import { SecurityPanel } from "./SecurityPanel";

/**
 * The second factor, as the panel reports it.
 *
 * The reported state is not cosmetic here. Pressing "enable" on an account that
 * already has an authenticator app issues a NEW secret and new backup codes, so
 * the entry already in the reader's authenticator stops working - a lockout on an
 * account that reaches the member register. The session that says whether TOTP is
 * enrolled resolves after the first render, so the panel has to follow it rather
 * than freeze whatever it was seeded with.
 *
 * The connected apps below are the fourth way in to an account, and the only one
 * held by something other than the person: what a member let an external program
 * do in their place is read and withdrawn here, beside the password, the
 * authenticator app and the passkeys.
 */

vi.mock("../auth/auth-client", () => ({
  useSession: () => ({ data: undefined }),
  authClient: {
    passkey: {
      listUserPasskeys: () => Promise.resolve({ data: [] }),
    },
  },
}));

const fetchMyConnectedApps = vi.fn();
const disconnectMyConnectedApp = vi.fn();

vi.mock("../connected-apps/connections-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../connected-apps/connections-api")
  >()),
  fetchMyConnectedApps: () => fetchMyConnectedApps(),
  disconnectMyConnectedApp: (clientId: string) =>
    disconnectMyConnectedApp(clientId),
}));

type MineResult = ApiResult<{ connectedApps: ConnectedApp[] }>;

const CONNECTED: ConnectedApp = {
  clientId: "client-1",
  clientName: "Chattklienten",
  clientHost: "chat.example.se",
  scopes: ["mcp:read"],
  connectedAt: "2026-09-01T08:30:00.000Z",
  lastTokenIssuedAt: "2026-09-10T06:00:00.000Z",
};

const mine = (connectedApps: ConnectedApp[]): MineResult => ({
  ok: true,
  value: { connectedApps },
});

beforeEach(() => {
  fetchMyConnectedApps.mockReset();
  disconnectMyConnectedApp.mockReset();
  fetchMyConnectedApps.mockResolvedValue(mine([]));
});

const stateWord = () => screen.getByText(/^(På|Av)$/).textContent;

describe("the authenticator app", () => {
  it("follows the session once it resolves", () => {
    // The first render is what useSession gives before it has an answer.
    const { rerender } = render(<SecurityPanel twoFactorEnabled={false} />);
    expect(stateWord()).toBe("Av");

    rerender(<SecurityPanel twoFactorEnabled />);

    expect(stateWord()).toBe("På");
  });

  it("offers disabling, not enabling, to an account that already has it", () => {
    const { rerender } = render(<SecurityPanel twoFactorEnabled={false} />);
    rerender(<SecurityPanel twoFactorEnabled />);

    // The button is the consequence: an "enable" here re-enrols and breaks the
    // authenticator entry the reader is already using.
    expect(screen.getByRole("button", { name: /^slå av$/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /slå på autentiseringsapp/i }),
    ).toBeNull();
  });
});

/** A promise this test resolves when it wants the answer to arrive. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("the apps this member has connected", () => {
  it("says it is loading before the read lands, then that there are none", async () => {
    const read = deferred<MineResult>();
    fetchMyConnectedApps.mockReturnValueOnce(read.promise);

    render(<SecurityPanel twoFactorEnabled={false} />);

    expect(screen.getByRole("status").textContent).toBe(
      "Läser in anslutna appar",
    );

    await act(async () => {
      read.resolve(mine([]));
    });

    // Its own sentence rather than an empty panel: before the read lands, an
    // empty list is unknown rather than empty.
    expect(screen.getByText("Du har inte anslutit någon app.")).toBeTruthy();
  });

  it("shows the app, its host, when it was connected and the last token", async () => {
    fetchMyConnectedApps.mockResolvedValue(mine([CONNECTED]));

    render(<SecurityPanel twoFactorEnabled={false} />);

    await waitFor(() => {
      expect(screen.getByText("Chattklienten")).toBeTruthy();
    });
    expect(screen.getByText("chat.example.se")).toBeTruthy();
    // The association's zone rather than the browser's, and the time as well as
    // the day: the member is reading about something that just happened.
    expect(screen.getByText(/1 sep\. 2026 10:30/)).toBeTruthy();
    expect(screen.getByText(/10 sep\. 2026 08:00/)).toBeTruthy();
  });

  it("says so plainly when no token is in force rather than leaving a gap", async () => {
    fetchMyConnectedApps.mockResolvedValue(
      mine([{ ...CONNECTED, lastTokenIssuedAt: null }]),
    );

    render(<SecurityPanel twoFactorEnabled={false} />);

    await waitFor(() => {
      expect(screen.getByText(/Ingen token i kraft just nu/)).toBeTruthy();
    });
  });

  it("asks a second time before cutting one, then reads the list again", async () => {
    fetchMyConnectedApps.mockResolvedValue(mine([CONNECTED]));
    const cut = deferred<ApiResult<{ disconnected: true }>>();
    disconnectMyConnectedApp.mockReturnValueOnce(cut.promise);

    render(<SecurityPanel twoFactorEnabled={false} />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Koppla bort Chattklienten",
      }),
    );

    // The first press asks rather than acts, and says what the act does.
    expect(disconnectMyConnectedApp).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Appen slutar nå föreningen vid sitt nästa anrop/),
    ).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Ja, koppla bort" }),
    );

    expect(disconnectMyConnectedApp).toHaveBeenCalledWith("client-1");
    // The row says the cut is under way while it is.
    expect(
      screen.getByRole("button", { name: "Kopplar bort..." }),
    ).toBeTruthy();

    await act(async () => {
      cut.resolve({ ok: true, value: { disconnected: true } });
    });

    // Re-read rather than struck from the list here: what is connected is the
    // server's answer.
    await waitFor(() => {
      expect(fetchMyConnectedApps).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("Appen är bortkopplad.")).toBeTruthy();
  });

  it("keeps the app when the question is answered with no", async () => {
    fetchMyConnectedApps.mockResolvedValue(mine([CONNECTED]));

    render(<SecurityPanel twoFactorEnabled={false} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Koppla bort Chattklienten" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Behåll" }));

    expect(disconnectMyConnectedApp).not.toHaveBeenCalled();
    expect(screen.getByText("Chattklienten")).toBeTruthy();
  });

  it("answers a refusal with a sentence and never with the code", async () => {
    fetchMyConnectedApps.mockResolvedValue(mine([CONNECTED]));
    disconnectMyConnectedApp.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "unexpected" },
    });

    render(<SecurityPanel twoFactorEnabled={false} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Koppla bort Chattklienten" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Ja, koppla bort" }),
    );

    // A connection that is already gone has its own sentence, and the route
    // answers that with a bare not-found carrying no code of its own.
    await waitFor(() => {
      expect(
        screen.getByText("Anslutningen finns inte längre. Läs listan igen."),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/unexpected/)).toBeNull();
  });

  it("offers a retry when the read fails, and reads again on it", async () => {
    fetchMyConnectedApps
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 0, reason: "offline" },
      })
      .mockResolvedValueOnce(mine([CONNECTED]));

    render(<SecurityPanel twoFactorEnabled={false} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Försök igen" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Chattklienten")).toBeTruthy();
    });
    expect(fetchMyConnectedApps).toHaveBeenCalledTimes(2);
  });
});
