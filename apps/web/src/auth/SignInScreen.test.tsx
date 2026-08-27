import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { SignInScreen } from "./SignInScreen";

const signInWithPassword = vi.fn();
const requestMagicLink = vi.fn();

vi.mock("./sign-in-methods", () => ({
  signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
  requestMagicLink: (...args: unknown[]) => requestMagicLink(...args),
}));

/** Fills the form and submits it, as a person would. */
async function submit(email = "anna@exempel.se", password = "hunter2hunter2") {
  const user = (await import("@testing-library/user-event")).default;
  const session = user.setup();
  await session.type(screen.getByLabelText(/post|mail/i), email);
  await session.type(screen.getByLabelText(/lösenord|password/i), password);
  await session.click(screen.getByRole("button", { name: /logga in/i }));
}

beforeEach(() => {
  signInWithPassword.mockReset();
  requestMagicLink.mockReset();
});

describe("SignInScreen", () => {
  it("offers both a password and a link", () => {
    render(<SignInScreen />);

    expect(screen.getByLabelText(/post/i)).toBeTruthy();
    expect(screen.getByLabelText(/lösenord/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /inloggningslänk/i }),
    ).toBeTruthy();
  });

  it("tells the caller once a session exists", async () => {
    signInWithPassword.mockResolvedValue({ status: "signed-in" });
    const onSignedIn = vi.fn();
    render(<SignInScreen onSignedIn={onSignedIn} />);

    await submit();

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });
  });

  it("does NOT report success when a second factor is still required", async () => {
    signInWithPassword.mockResolvedValue({ status: "second-factor-required" });
    const onSignedIn = vi.fn();
    render(<SignInScreen onSignedIn={onSignedIn} />);

    await submit();

    // Navigating away here would strand the viewer: the password was accepted
    // but there is no session until the code is entered.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /autentiseringsapp/,
      );
    });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("shows the server's own refusal verbatim", async () => {
    // The API refuses a magic link for a TOTP account and explains what to use
    // instead. Replacing that with a generic error would hide the way forward.
    requestMagicLink.mockResolvedValue({
      status: "failed",
      message: "This account uses an authenticator app.",
    });
    render(<SignInScreen />);

    const user = (await import("@testing-library/user-event")).default.setup();
    await user.type(screen.getByLabelText(/post/i), "anna@exempel.se");
    await user.click(screen.getByRole("button", { name: /inloggningslänk/i }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "This account uses an authenticator app.",
      );
    });
  });

  it("confirms a sent link without claiming a session", async () => {
    requestMagicLink.mockResolvedValue({ status: "link-sent" });
    const onSignedIn = vi.fn();
    render(<SignInScreen onSignedIn={onSignedIn} />);

    const user = (await import("@testing-library/user-event")).default.setup();
    await user.type(screen.getByLabelText(/post/i), "anna@exempel.se");
    await user.click(screen.getByRole("button", { name: /inloggningslänk/i }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/inkorg/);
    });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("announces every outcome in one live region", () => {
    render(<SignInScreen />);

    // A single polite live region means a screen reader hears the result
    // without the focus being moved out from under the reader.
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});
