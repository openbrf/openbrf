import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { RegisterClientPanel } from "./RegisterClientPanel";

/**
 * The one credential this product ever shows a person, and shows once.
 *
 * A client secret exists in exactly one place: the response that minted it.
 * Nothing stores it and no endpoint answers with it again, so a panel that
 * appeared to hold on to it would be promising a second look that does not
 * exist - and an administrator who relied on that promise would have to
 * register the app over again.
 *
 * The address a client binds its token to is the opposite kind of value: a
 * standing fact about the instance, read from the discovery document rather
 * than composed here, because which route is the resource depends on which
 * connector plugin the instance runs.
 */

const registerOAuthClient = vi.fn();
const fetchProtectedResource = vi.fn();

vi.mock("./connections-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connections-api")>()),
  registerOAuthClient: (input: unknown) => registerOAuthClient(input),
  fetchProtectedResource: () => fetchProtectedResource(),
}));

const RESOURCE = "https://brf.example.se/api/plugin/connector/mcp";

/** Fills the form and submits it. */
async function registerApp(name: string, uris: string): Promise<void> {
  await userEvent.type(screen.getByLabelText(/Appens namn/), name);
  await userEvent.type(
    screen.getByLabelText(/Adresser att skicka tillbaka till/),
    uris,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Registrera appen" }),
  );
}

beforeEach(() => {
  registerOAuthClient.mockReset();
  fetchProtectedResource.mockReset();
  fetchProtectedResource.mockResolvedValue({
    ok: true,
    value: { resource: RESOURCE },
  });
});

describe("the address a client must send", () => {
  it("stands on the panel whether or not anything has been registered", async () => {
    render(<RegisterClientPanel />);

    await waitFor(() => {
      expect(screen.getByText(RESOURCE)).toBeTruthy();
    });
    expect(registerOAuthClient).not.toHaveBeenCalled();
  });

  it("says it could not be read rather than showing an invented address", async () => {
    fetchProtectedResource.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });

    render(<RegisterClientPanel />);

    await waitFor(() => {
      expect(
        screen.getByText("Adressen kunde inte läsas just nu."),
      ).toBeTruthy();
    });
    expect(screen.queryByText(RESOURCE)).toBeNull();
  });
});

describe("registering a client", () => {
  it("sends one address per line and drops the blank ones", async () => {
    registerOAuthClient.mockResolvedValue({
      ok: true,
      value: { clientId: "client-1", clientSecret: "s3cret-value" },
    });

    render(<RegisterClientPanel />);
    await registerApp(
      "Föreningens egen app",
      "https://app.example.se/callback{enter}{enter}https://app.example.se/other",
    );

    // A trailing newline is what a text area is left with after one address,
    // and an empty string is refused by the endpoint as an address that is not
    // one.
    expect(registerOAuthClient).toHaveBeenCalledWith({
      clientName: "Föreningens egen app",
      redirectUris: [
        "https://app.example.se/callback",
        "https://app.example.se/other",
      ],
    });
  });

  it("shows the client id and the secret the response carried", async () => {
    registerOAuthClient.mockResolvedValue({
      ok: true,
      value: { clientId: "client-1", clientSecret: "s3cret-value" },
    });

    render(<RegisterClientPanel />);
    await registerApp(
      "Föreningens egen app",
      "https://app.example.se/callback",
    );

    await waitFor(() => {
      expect(screen.getByText("s3cret-value")).toBeTruthy();
    });
    expect(screen.getByText("client-1")).toBeTruthy();
    // Said plainly, beside the value, because there is no second look.
    expect(
      screen.getByText(/visas den här enda gången och går inte att visa igen/),
    ).toBeTruthy();
  });

  it("answers a refusal with a sentence and never with the code", async () => {
    registerOAuthClient.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "name-taken" },
    });

    render(<RegisterClientPanel />);
    await registerApp(
      "Föreningens egen app",
      "https://app.example.se/callback",
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Det finns redan en app med det namnet. Välj ett annat.",
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/name-taken/)).toBeNull();
  });

  it("falls back to the general sentence for a code this build has no words for", async () => {
    registerOAuthClient.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "some-future-reason" },
    });

    render(<RegisterClientPanel />);
    await registerApp(
      "Föreningens egen app",
      "https://app.example.se/callback",
    );

    await waitFor(() => {
      expect(
        screen.getByText("Appen kunde inte registreras just nu. Försök igen."),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/some-future-reason/)).toBeNull();
  });
});

describe("the secret is shown once", () => {
  it("is dropped when another client is registered", async () => {
    registerOAuthClient
      .mockResolvedValueOnce({
        ok: true,
        value: { clientId: "client-1", clientSecret: "s3cret-value" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { clientId: "client-2", clientSecret: null },
      });

    render(<RegisterClientPanel />);
    await registerApp("Första appen", "https://app.example.se/callback");
    await waitFor(() => {
      expect(screen.getByText("s3cret-value")).toBeTruthy();
    });

    await registerApp("Andra appen", "https://annan.example.se/callback");
    await waitFor(() => {
      expect(screen.getByText("client-2")).toBeTruthy();
    });

    // A secret belongs to the client it was minted for. Left on screen beside
    // another client's id, it is the pair an administrator would save.
    expect(screen.queryByText("s3cret-value")).toBeNull();
    expect(screen.queryByText("client-1")).toBeNull();
    expect(
      screen.getByText("Den här appen fick ingen hemlighet."),
    ).toBeTruthy();
  });

  it("does not come back when the panel is read again", async () => {
    registerOAuthClient.mockResolvedValue({
      ok: true,
      value: { clientId: "client-1", clientSecret: "s3cret-value" },
    });

    render(<RegisterClientPanel />);
    await registerApp(
      "Föreningens egen app",
      "https://app.example.se/callback",
    );
    await waitFor(() => {
      expect(screen.getByText("s3cret-value")).toBeTruthy();
    });

    // The panel read again from scratch, which is what an administrator who
    // comes back to this screen gets.
    cleanup();
    registerOAuthClient.mockClear();
    render(<RegisterClientPanel />);

    await waitFor(() => {
      expect(screen.getByText(RESOURCE)).toBeTruthy();
    });
    // Nothing holds the secret: not this panel, and no read that could fetch it
    // back. The only call a fresh panel makes is for the standing address.
    expect(screen.queryByText("s3cret-value")).toBeNull();
    expect(screen.queryByText("client-1")).toBeNull();
    expect(registerOAuthClient).not.toHaveBeenCalled();
  });
});
