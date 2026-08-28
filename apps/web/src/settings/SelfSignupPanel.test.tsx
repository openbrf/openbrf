import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { SelfSignupPanel } from "./SelfSignupPanel";

/**
 * Whether the instance accepts sign-up requests.
 *
 * This switch decides whether a form anyone can reach exists at all on an
 * instance holding a statutory register of personal data, so what the panel says
 * about it has to be what the server actually accepted. The dangerous direction
 * is closing: a board that unticks the box, sees "off", and walks away has been
 * told a public route is shut while it is still open.
 */

const saveSelfSignup = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveSelfSignup: (input: unknown) => saveSelfSignup(input),
}));

const checkbox = () => screen.getByRole("checkbox");

beforeEach(() => {
  saveSelfSignup.mockReset();
});

describe("the state in words", () => {
  it("goes back to the server's answer when the save is refused", async () => {
    saveSelfSignup.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    const session = userEvent.setup();
    render(<SelfSignupPanel enabled />);

    await session.click(checkbox());

    await waitFor(() => {
      expect(screen.getByText(/kunde inte sparas/i)).toBeTruthy();
    });
    // Still open, and the panel says so: the request to close it failed.
    expect(checkbox()).toHaveProperty("checked", true);
    expect(screen.getByText(/^På:/)).toBeTruthy();
  });

  it("keeps the new state when the save lands", async () => {
    saveSelfSignup.mockResolvedValue({ ok: true, value: { enabled: false } });

    const session = userEvent.setup();
    render(<SelfSignupPanel enabled />);

    await session.click(checkbox());

    await waitFor(() => {
      expect(checkbox()).toHaveProperty("checked", false);
    });
    expect(screen.getByText(/^Av:/)).toBeTruthy();
  });

  it("follows the server when a reload corrects the prop", () => {
    const { rerender } = render(<SelfSignupPanel enabled={false} />);
    expect(checkbox()).toHaveProperty("checked", false);

    rerender(<SelfSignupPanel enabled />);

    // The server is the authority on whether a public form exists, so a parent
    // that refetched the settings must not be ignored by local state.
    expect(checkbox()).toHaveProperty("checked", true);
  });
});
