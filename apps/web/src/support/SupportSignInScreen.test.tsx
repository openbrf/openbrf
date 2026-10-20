import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import "../i18n";
import { SupportSignInScreen } from "./SupportSignInScreen";

/**
 * Where a supporter's sign-in link lands (ADR 0028).
 *
 * The link's token is in the fragment and works once, so what matters is that
 * it leaves the address bar before anything else and is sent exactly once,
 * however often React runs the effect.
 */

const startSupportSession = vi.fn();

vi.mock("../api/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/support")>()),
  startSupportSession: (token: string) => startSupportSession(token),
}));

function arriveAt(hash: string): void {
  window.history.replaceState(null, "", `/app/support${hash}`);
}

beforeEach(() => {
  startSupportSession.mockReset().mockResolvedValue({
    ok: true,
    value: { supporter: "Kim", expiresAt: "2026-10-20T20:00:00.000Z" },
  });
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("a sign-in link", () => {
  it("takes the token out of the address bar and sends it once", async () => {
    arriveAt("#the-sign-in-token");
    const onSignedIn = vi.fn();

    render(
      <StrictMode>
        <SupportSignInScreen onSignedIn={onSignedIn} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/app/support");
    expect(startSupportSession).toHaveBeenCalledTimes(1);
    expect(startSupportSession).toHaveBeenCalledWith("the-sign-in-token");
  });

  it("says a link that does not work is spent, and offers no retry", async () => {
    arriveAt("#a-used-token");
    startSupportSession.mockResolvedValue({
      ok: false,
      failure: { status: 401, reason: "support-sign-in-invalid" },
    });

    render(<SupportSignInScreen onSignedIn={vi.fn()} />);

    expect(await screen.findByText(/Länken fungerar inte/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a retry when the instance could not be reached", async () => {
    arriveAt("#the-sign-in-token");
    startSupportSession.mockResolvedValueOnce({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    const onSignedIn = vi.fn();

    render(<SupportSignInScreen onSignedIn={onSignedIn} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Försök igen" }),
    );

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });
    expect(startSupportSession).toHaveBeenCalledTimes(2);
  });

  it("sends nothing without a link, and says where one comes from", () => {
    arriveAt("");

    render(<SupportSignInScreen onSignedIn={vi.fn()} />);

    expect(screen.getByText(/börjar med inloggningslänken/)).toBeTruthy();
    expect(startSupportSession).not.toHaveBeenCalled();
  });
});
