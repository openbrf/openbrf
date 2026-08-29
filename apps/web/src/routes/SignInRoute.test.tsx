import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { SignInRoute } from "./SignInRoute";

/**
 * The way from the sign-in screen to the request form.
 *
 * Offered only while the board has the form switched on. A standing link to a
 * closed door tells a resident their cooperative accepts requests, sends them
 * to a screen that says the opposite, and leaves them believing the instance is
 * broken rather than that a decision was made.
 */

const fetchSignupState = vi.fn();

vi.mock("../api/signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/signup")>()),
  fetchSignupState: () => fetchSignupState(),
}));

// The screen under test is a route component; the router itself is not what
// these assertions are about.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const requestLink = () =>
  screen.queryByRole("link", { name: "Ansök om konto" });

beforeEach(() => {
  fetchSignupState.mockReset();
});

describe("the link to the request form", () => {
  it("is offered when the instance accepts requests", async () => {
    fetchSignupState.mockResolvedValue({ ok: true, value: { enabled: true } });

    render(<SignInRoute />);

    await waitFor(() => {
      expect(requestLink()).toBeTruthy();
    });
    expect(requestLink()).toHaveProperty(
      "href",
      expect.stringContaining("/request-account"),
    );
  });

  it("is absent when the board has the form switched off", async () => {
    fetchSignupState.mockResolvedValue({ ok: true, value: { enabled: false } });

    render(<SignInRoute />);

    await waitFor(() => {
      expect(fetchSignupState).toHaveBeenCalled();
    });
    expect(requestLink()).toBeNull();
    // The screen itself is unaffected: this is only about the extra way in.
    expect(screen.getByRole("heading", { name: "Logga in" })).toBeTruthy();
  });

  it("is absent when the instance cannot be asked", async () => {
    fetchSignupState.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });

    render(<SignInRoute />);

    await waitFor(() => {
      expect(fetchSignupState).toHaveBeenCalled();
    });
    expect(requestLink()).toBeNull();
  });
});
