import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { ApiResult } from "../api/client";
import type { Viewer } from "../api/instance";
import { ConnectedAppsScreen } from "./ConnectedAppsScreen";
import type { ConnectedAppGrant } from "./connections-api";

/**
 * What each seat is offered, and what a disconnect actually sends.
 *
 * The screen answers three different questions with three different
 * capabilities: reading the list is association:read, cutting somebody else's
 * connection is dataProtection:manage, and registering a client is
 * association:manage. A board member who may read the list and not cut a
 * connection is an ordinary seat rather than an edge case, so the controls have
 * to follow the capability rather than the screen.
 *
 * The disconnect is keyed on the account the grant hangs on, not on the person:
 * a person and their account are not interchangeable, and the route looks the
 * account up by id.
 */

const fetchConnectedApps = vi.fn();
const disconnectConnectedApp = vi.fn();
const fetchProtectedResource = vi.fn();
const registerOAuthClient = vi.fn();

vi.mock("./connections-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connections-api")>()),
  fetchConnectedApps: () => fetchConnectedApps(),
  disconnectConnectedApp: (userId: string, clientId: string) =>
    disconnectConnectedApp(userId, clientId),
  fetchProtectedResource: () => fetchProtectedResource(),
  registerOAuthClient: (input: unknown) => registerOAuthClient(input),
}));

type ListResult = ApiResult<{ connectedApps: ConnectedAppGrant[] }>;

const GRANT: ConnectedAppGrant = {
  clientId: "client-1",
  clientName: "Chattklienten",
  clientHost: "chat.example.se",
  scopes: ["mcp:read"],
  connectedAt: "2026-09-01T08:30:00.000Z",
  lastTokenIssuedAt: "2026-09-10T06:00:00.000Z",
  personId: "person-1",
  personName: "Mia Modig",
  userId: "user-1",
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-9",
    firstName: "Bo",
    lastName: "Berg",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Exemplet",
      primaryColor: null,
      logoUrl: null,
      logoDarkUrl: null,
    },
  };
}

/** A promise this test resolves when it wants the answer to arrive. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const listed = (connectedApps: ConnectedAppGrant[]): ListResult => ({
  ok: true,
  value: { connectedApps },
});

const refused = (status: number, reason: string): ListResult => ({
  ok: false,
  failure: { status, reason },
});

beforeEach(() => {
  fetchConnectedApps.mockReset();
  disconnectConnectedApp.mockReset();
  registerOAuthClient.mockReset();
  fetchProtectedResource.mockReset();
  fetchProtectedResource.mockResolvedValue({
    ok: true,
    value: { resource: "https://brf.example.se/api/plugin/connector/mcp" },
  });
});

describe("the four states of the list", () => {
  it("says it is loading before the first read lands", async () => {
    const read = deferred<ListResult>();
    fetchConnectedApps.mockReturnValueOnce(read.promise);

    render(<ConnectedAppsScreen viewer={viewerWith(["association:read"])} />);

    expect(screen.getByRole("status").textContent).toBe(
      "Läser in anslutna appar",
    );

    await act(async () => {
      read.resolve(listed([GRANT]));
    });

    // An empty list and an unfinished read look the same and mean opposite
    // things, so the loading line has to go when the answer arrives.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nobody has connected anything rather than showing an empty panel", async () => {
    fetchConnectedApps.mockResolvedValue(listed([]));

    render(<ConnectedAppsScreen viewer={viewerWith(["association:read"])} />);

    await waitFor(() => {
      expect(
        screen.getByText("Ingen i föreningen har anslutit någon app."),
      ).toBeTruthy();
    });
  });

  it("offers a retry when the first read fails, and reads again on it", async () => {
    fetchConnectedApps
      .mockResolvedValueOnce(refused(0, "offline"))
      .mockResolvedValueOnce(listed([GRANT]));

    render(<ConnectedAppsScreen viewer={viewerWith(["association:read"])} />);

    const retry = await screen.findByRole("button", { name: "Försök igen" });
    await userEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByText("Chattklienten")).toBeTruthy();
    });
    expect(fetchConnectedApps).toHaveBeenCalledTimes(2);
  });

  it("shows the app, its host and who connected it", async () => {
    fetchConnectedApps.mockResolvedValue(listed([GRANT]));

    render(<ConnectedAppsScreen viewer={viewerWith(["association:read"])} />);

    await waitFor(() => {
      expect(screen.getByText("Chattklienten")).toBeTruthy();
    });
    expect(screen.getByText("chat.example.se")).toBeTruthy();
    expect(screen.getByText("Mia Modig")).toBeTruthy();
  });
});

describe("two reads in flight", () => {
  it("keeps the newest answer when an older one lands after it", async () => {
    const stale = deferred<ListResult>();
    const fresh = deferred<ListResult>();
    fetchConnectedApps
      .mockResolvedValueOnce(refused(0, "offline"))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    render(<ConnectedAppsScreen viewer={viewerWith(["association:read"])} />);

    // Two retries, so two reads are outstanding at once. Both answers are well
    // formed, so the screen cannot tell them apart by content.
    await userEvent.click(
      await screen.findByRole("button", { name: "Försök igen" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));

    await act(async () => {
      fresh.resolve(listed([GRANT]));
    });
    expect(screen.getByText("Chattklienten")).toBeTruthy();

    // The superseded read answering afterwards must change nothing. Without the
    // version guard it would put the failure notice back over a list that had
    // just been read successfully.
    await act(async () => {
      stale.resolve(refused(0, "offline"));
    });

    expect(screen.getByText("Chattklienten")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Försök igen" })).toBeNull();
  });
});

describe("cutting a connection on somebody's behalf", () => {
  const BOARD = ["association:read", "dataProtection:manage"];

  it("is not offered to a seat that may only read the list", async () => {
    fetchConnectedApps.mockResolvedValue(listed([GRANT]));

    render(<ConnectedAppsScreen viewer={viewerWith(["association:read"])} />);

    await waitFor(() => {
      expect(screen.getByText("Chattklienten")).toBeTruthy();
    });
    // Reading what has been connected and acting on another person's data are
    // two different questions, and this seat has only answered the first.
    expect(screen.queryByRole("button", { name: /koppla bort/i })).toBeNull();
  });

  it("asks a second time, and sends the account the grant hangs on", async () => {
    fetchConnectedApps.mockResolvedValue(listed([GRANT]));
    const cut = deferred<ApiResult<{ disconnected: true }>>();
    disconnectConnectedApp.mockReturnValueOnce(cut.promise);

    render(<ConnectedAppsScreen viewer={viewerWith(BOARD)} />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Koppla bort Chattklienten som Mia Modig har anslutit",
      }),
    );

    // The first press asks rather than acts, and says what the act does.
    expect(disconnectConnectedApp).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Appen slutar nå föreningen vid sitt nästa anrop/),
    ).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Ja, koppla bort" }),
    );

    // The account id, never the person id: the route looks the account up by
    // it, and a person in the register may have no account at all.
    expect(disconnectConnectedApp).toHaveBeenCalledWith("user-1", "client-1");
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
      expect(fetchConnectedApps).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the connection when the question is answered with no", async () => {
    fetchConnectedApps.mockResolvedValue(listed([GRANT]));

    render(<ConnectedAppsScreen viewer={viewerWith(BOARD)} />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Koppla bort Chattklienten som Mia Modig har anslutit",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Behåll" }));

    expect(disconnectConnectedApp).not.toHaveBeenCalled();
    expect(screen.getByText("Chattklienten")).toBeTruthy();
  });

  it("answers a refusal with a sentence and never with the code", async () => {
    fetchConnectedApps.mockResolvedValue(listed([GRANT]));
    disconnectConnectedApp.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "forbidden-capability" },
    });

    render(<ConnectedAppsScreen viewer={viewerWith(BOARD)} />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Koppla bort Chattklienten som Mia Modig har anslutit",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Ja, koppla bort" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Ditt konto får inte koppla bort någon annans anslutning.",
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/forbidden-capability/)).toBeNull();
  });

  it("falls back to the general sentence for a code this build has no words for", async () => {
    fetchConnectedApps.mockResolvedValue(listed([GRANT]));
    disconnectConnectedApp.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "some-future-reason" },
    });

    render(<ConnectedAppsScreen viewer={viewerWith(BOARD)} />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Koppla bort Chattklienten som Mia Modig har anslutit",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Ja, koppla bort" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Anslutningen kunde inte kopplas bort just nu. Försök igen.",
        ),
      ).toBeTruthy();
    });
    // A code on screen is the API's English reaching a Swedish interface.
    expect(screen.queryByText(/some-future-reason/)).toBeNull();
  });
});

describe("registering a client", () => {
  it("is offered only to whoever may change how the instance is configured", async () => {
    fetchConnectedApps.mockResolvedValue(listed([]));

    const { rerender } = render(
      <ConnectedAppsScreen
        viewer={viewerWith(["association:read", "dataProtection:manage"])}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Ingen i föreningen har anslutit någon app."),
      ).toBeTruthy();
    });
    expect(screen.queryByLabelText("Appens namn")).toBeNull();

    rerender(
      <ConnectedAppsScreen
        viewer={viewerWith(["association:read", "association:manage"])}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Appens namn")).toBeTruthy();
    });
  });
});
