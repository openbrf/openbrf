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

const changePassword = vi.fn();
const listUserPasskeys = vi.fn();

vi.mock("../auth/auth-client", () => ({
  useSession: () => ({ data: undefined }),
  authClient: {
    changePassword: (input: unknown) => changePassword(input),
    passkey: {
      listUserPasskeys: () => listUserPasskeys(),
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
  dormant: false,
};

const mine = (connectedApps: ConnectedApp[]): MineResult => ({
  ok: true,
  value: { connectedApps },
});

beforeEach(() => {
  listUserPasskeys.mockReset().mockResolvedValue({ data: [], error: null });
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

  it("says a connection is dormant once the member's standing has narrowed", async () => {
    /*
     * Nothing revokes a token when a board term or a residency ends: what a
     * grant is worth is decided per call. The row would otherwise read as
     * connected while the app could reach nothing - and look fresher as it
     * became more useless, because it keeps refreshing its token on schedule.
     */
    fetchMyConnectedApps.mockResolvedValue(
      mine([{ ...CONNECTED, dormant: true }]),
    );

    render(<SecurityPanel twoFactorEnabled={false} />);

    await waitFor(() => {
      expect(screen.getByText("Vilande")).toBeTruthy();
    });
    // A word and a sentence beside the row, never colour alone.
    expect(
      screen.getByText(/når ingenting i föreningens register/),
    ).toBeTruthy();
  });

  it("says nothing about standing on a connection that still works", async () => {
    fetchMyConnectedApps.mockResolvedValue(mine([CONNECTED]));

    render(<SecurityPanel twoFactorEnabled={false} />);

    await waitFor(() => {
      expect(screen.getByText("Chattklienten")).toBeTruthy();
    });
    expect(screen.queryByText("Vilande")).toBeNull();
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
    // Back on the button that asked, rather than dropped to the page with the
    // button that was pressed.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Koppla bort Chattklienten" }),
    );
  });

  it("leaves the keyboard on the question asked when it moves to an earlier row", async () => {
    // Both rows' questions change at once. The later row used to read its
    // closing as a "keep" and take focus back to its own button, leaving the
    // keyboard on one app while the question was about another.
    fetchMyConnectedApps.mockResolvedValue(
      mine([
        CONNECTED,
        { ...CONNECTED, clientId: "client-2", clientName: "Second" },
      ]),
    );

    render(<SecurityPanel twoFactorEnabled={false} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Koppla bort Second" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Koppla bort Chattklienten" }),
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Ja, koppla bort" }),
    );
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

describe("changing the password", () => {
  beforeEach(() => {
    changePassword.mockReset();
  });

  const changeTo = async (next: string): Promise<void> => {
    render(<SecurityPanel twoFactorEnabled={false} />);
    await userEvent.type(
      screen.getByLabelText("Nuvarande lösenord"),
      "the-old-password",
    );
    await userEvent.type(screen.getByLabelText(/^Nytt lösenord/), next);
    await userEvent.type(
      screen.getByLabelText("Upprepa det nya lösenordet"),
      next,
    );
    await userEvent.click(screen.getByRole("button", { name: "Byt lösenord" }));
  };

  it("says the current password did not match only when that is the refusal", async () => {
    changePassword.mockResolvedValue({
      error: { status: 400, code: "INVALID_PASSWORD" },
    });

    await changeTo("a-long-enough-password");

    expect(
      await screen.findByText("Det nuvarande lösenordet stämde inte."),
    ).toBeTruthy();
  });

  it("says a too long new password is too long, not that the current one is wrong", async () => {
    // The sign-in library refuses past its maximum with a 400 of its own. Read
    // by its status alone it blamed the current password, which was right.
    changePassword.mockResolvedValue({
      error: { status: 400, code: "PASSWORD_TOO_LONG" },
    });

    await changeTo("a-long-enough-password");

    expect(
      await screen.findByText("Det nya lösenordet får vara högst 128 tecken."),
    ).toBeTruthy();
    expect(
      screen.queryByText("Det nuvarande lösenordet stämde inte."),
    ).toBeNull();
  });

  it("says a too short new password is too short when the library refuses it", async () => {
    changePassword.mockResolvedValue({
      error: { status: 400, code: "PASSWORD_TOO_SHORT" },
    });

    await changeTo("a-long-enough-password");

    expect(
      await screen.findByText("Det nya lösenordet behöver minst 12 tecken."),
    ).toBeTruthy();
  });

  it("holds the new password to the length the library accepts", () => {
    render(<SecurityPanel twoFactorEnabled={false} />);

    expect(
      screen.getByLabelText(/^Nytt lösenord/).getAttribute("maxlength"),
    ).toBe("128");
  });
});

describe("passkeys that could not be read", () => {
  it("say so with a retry, rather than that there are none", async () => {
    // "No passkeys yet" over a failed read tells somebody whose passkey is
    // there that it is gone.
    listUserPasskeys
      .mockResolvedValueOnce({ data: null, error: { status: 500 } })
      .mockResolvedValueOnce({
        data: [{ id: "passkey-1", name: "Telefonen" }],
        error: null,
      });

    render(<SecurityPanel twoFactorEnabled={false} />);

    expect(
      await screen.findByText("Dina nycklar kunde inte läsas just nu."),
    ).toBeTruthy();
    expect(screen.queryByText("Inga nycklar än.")).toBeNull();

    // The connected apps read fine, so the only retry is the passkeys'.
    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));

    expect(await screen.findByText("Telefonen")).toBeTruthy();
    expect(
      screen.queryByText("Dina nycklar kunde inte läsas just nu."),
    ).toBeNull();
  });

  it("keep the newest read when an older retry fails after it", async () => {
    // The retry stays enabled while a read is out, so two can overlap. The
    // older one failing last must not put the failure back over a list the
    // newer one has already read.
    let failOlder: (value: unknown) => void = () => undefined;
    listUserPasskeys
      .mockResolvedValueOnce({ data: null, error: { status: 500 } })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          failOlder = resolve;
        }),
      )
      .mockResolvedValueOnce({
        data: [{ id: "passkey-1", name: "Telefonen" }],
        error: null,
      });
    const session = userEvent.setup();

    render(<SecurityPanel twoFactorEnabled={false} />);
    await screen.findByText("Dina nycklar kunde inte läsas just nu.");

    const retry = screen.getByRole("button", { name: "Försök igen" });
    await session.click(retry);
    await session.click(retry);
    expect(await screen.findByText("Telefonen")).toBeTruthy();

    failOlder({ data: null, error: { status: 500 } });

    await waitFor(() => {
      expect(listUserPasskeys).toHaveBeenCalledTimes(3);
    });
    expect(
      screen.queryByText("Dina nycklar kunde inte läsas just nu."),
    ).toBeNull();
    expect(screen.getByText("Telefonen")).toBeTruthy();
  });
});
