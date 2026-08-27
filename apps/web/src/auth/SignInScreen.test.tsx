import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { SignInScreen } from "./SignInScreen";

const signInWithPassword = vi.fn();
const requestMagicLink = vi.fn();
const verifySecondFactor = vi.fn();

vi.mock("./sign-in-methods", () => ({
  signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
  requestMagicLink: (...args: unknown[]) => requestMagicLink(...args),
  verifySecondFactor: (...args: unknown[]) => verifySecondFactor(...args),
}));

/** Fills the form and submits it, as a person would. */
async function submit(email = "anna@exempel.se", password = "hunter2hunter2") {
  const session = userEvent.setup();
  await session.type(screen.getByLabelText(/post|mail/i), email);
  await session.type(screen.getByLabelText(/lösenord|password/i), password);
  await session.click(screen.getByRole("button", { name: /^logga in$/i }));
}

/** Asks for a link, which needs only the address. */
async function requestLink(email = "anna@exempel.se") {
  const session = userEvent.setup();
  await session.type(screen.getByLabelText(/post/i), email);
  await session.click(screen.getByRole("button", { name: /inloggningslänk/i }));
}

const codeField = () => screen.queryByLabelText(/engångskod/i);

beforeEach(() => {
  signInWithPassword.mockReset();
  requestMagicLink.mockReset();
  verifySecondFactor.mockReset();
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

  describe("when a second factor is required", () => {
    beforeEach(() => {
      signInWithPassword.mockResolvedValue({
        status: "second-factor-required",
      });
    });

    it("does NOT report success, and asks for the code", async () => {
      const onSignedIn = vi.fn();
      render(<SignInScreen onSignedIn={onSignedIn} />);

      await submit();

      // Navigating away here would strand the viewer: the password was
      // accepted but there is no session until the code is entered.
      await waitFor(() => {
        expect(codeField()).toBeTruthy();
      });
      expect(onSignedIn).not.toHaveBeenCalled();
    });

    it("completes the sign-in once the code is accepted", async () => {
      verifySecondFactor.mockResolvedValue({ status: "signed-in" });
      const onSignedIn = vi.fn();
      render(<SignInScreen onSignedIn={onSignedIn} />);

      await submit();
      await waitFor(() => {
        expect(codeField()).toBeTruthy();
      });

      const session = userEvent.setup();
      await session.type(codeField() as HTMLElement, "123456");
      await session.click(screen.getByRole("button", { name: /slutför/i }));

      await waitFor(() => {
        expect(onSignedIn).toHaveBeenCalledTimes(1);
      });
      expect(verifySecondFactor).toHaveBeenCalledWith({ code: "123456" });
    });

    it("keeps the code form after a wrong code", async () => {
      verifySecondFactor.mockResolvedValue({
        status: "failed",
        code: "invalid-code",
      });
      render(<SignInScreen />);

      await submit();
      await waitFor(() => {
        expect(codeField()).toBeTruthy();
      });

      const session = userEvent.setup();
      await session.type(codeField() as HTMLElement, "000000");
      await session.click(screen.getByRole("button", { name: /slutför/i }));

      /*
       * Falling back to the password form here would be a dead end: Better
       * Auth still holds the pending two-factor cookie, so there would be no
       * way to finish. The form has to stay put and invite another try.
       */
      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toMatch(/koden/i);
      });
      expect(codeField()).toBeTruthy();
      expect(screen.queryByLabelText(/lösenord/i)).toBeNull();
    });
  });

  it("renders failures in the interface's own language", async () => {
    /*
     * Not the API's words: Better Auth speaks English and this screen is
     * Swedish. The failure arrives as a code and the sentence is chosen here.
     */
    signInWithPassword.mockResolvedValue({
      status: "failed",
      code: "invalid-credentials",
    });
    render(<SignInScreen />);

    await submit();

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "De uppgifterna fungerade inte",
      );
    });
  });

  it("has a translated sentence for every failure code", async () => {
    // A code with no key would render the key itself to a board member.
    for (const code of [
      "invalid-credentials",
      "invalid-code",
      "second-factor-expired",
      "unknown",
    ]) {
      signInWithPassword.mockResolvedValue({ status: "failed", code });
      const { unmount } = render(<SignInScreen />);

      await submit();

      await waitFor(() => {
        const text = screen.getByRole("status").textContent ?? "";
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain("signIn.");
      });
      unmount();
    }
  });

  it("promises a link only conditionally", async () => {
    requestMagicLink.mockResolvedValue({ status: "link-sent" });
    const onSignedIn = vi.fn();
    render(<SignInScreen onSignedIn={onSignedIn} />);

    await requestLink();

    /*
     * The API sends nothing for an unknown address, and refuses an account with
     * TOTP enrolled, answering identically in both cases so the endpoint cannot
     * be used to enumerate accounts. The copy has to match that: a flat "check
     * your inbox" would be a promise the API did not make.
     */
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/om adressen/i);
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
