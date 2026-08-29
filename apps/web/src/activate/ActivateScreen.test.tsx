import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

import "../i18n";
import { ActivateScreen } from "./ActivateScreen";

/**
 * Activation from the emailed link.
 *
 * Two properties carry this screen. A successful activation must leave the
 * person signed in without a second trip through the sign-in form - that is the
 * whole difference between an invitation somebody can follow and one they have
 * to be talked through. And every refusal must say which one it is: the
 * activation endpoint answers the same shape for a link that was never valid, a
 * link that has already been used and an account that already exists, and those
 * three ask for three different things from the person reading them.
 */

const acceptInvitation = vi.fn();
const signInWithPassword = vi.fn();

/*
 * Dereferenced through an arrow: vi.mock factories are hoisted and run when the
 * mocked module is first imported, which is before these consts initialize.
 */
vi.mock("./activate-api", () => ({
  acceptInvitation: (...args: unknown[]) => acceptInvitation(...args),
}));

vi.mock("../auth/sign-in-methods", () => ({
  signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
}));

/** The router's Link needs a router context this screen's tests do not have. */
vi.mock("@tanstack/react-router", () => ({
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

const TOKEN = "a-token-from-the-email";
const PASSWORD = "granngarden-kastanj-2026";
const EMAIL = "astrid@exempel.se";

function renderScreen(onActivated = vi.fn(), token = TOKEN) {
  render(<ActivateScreen token={token} onActivated={onActivated} />);
  return onActivated;
}

/** Chooses a password and submits, as the recipient of the email would. */
async function chooseAPassword(password = PASSWORD): Promise<void> {
  const session = userEvent.setup();
  await session.type(screen.getByLabelText(/lösenord/i), password);
  await session.click(screen.getByRole("button", { name: "Aktivera kontot" }));
}

/** The failure shape apiRequest produces for a refusal with a reason. */
function refusedWith(reason: string, status = 400) {
  return { ok: false, failure: { status, reason } };
}

beforeEach(() => {
  acceptInvitation.mockReset();
  signInWithPassword.mockReset();
});

describe("the activation form", () => {
  it("asks for one password, and for a long one", () => {
    renderScreen();

    const field = screen.getByLabelText(/lösenord/i) as HTMLInputElement;
    expect(field.type).toBe("password");
    // The minimum Better Auth is configured with, and the one the endpoint
    // enforces. Saying it here means the browser catches it before a person
    // sends a password the server will only refuse.
    expect(field.minLength).toBe(12);
    expect(field.autocomplete).toBe("new-password");
    expect(screen.getAllByLabelText(/lösenord/i)).toHaveLength(1);
  });

  it("leaves the person signed in, with no trip through the sign-in form", async () => {
    acceptInvitation.mockResolvedValue({
      ok: true,
      value: { personId: "person-astrid", email: EMAIL },
    });
    signInWithPassword.mockResolvedValue({ status: "signed-in" });
    const onActivated = renderScreen();

    await chooseAPassword();

    await waitFor(() => {
      expect(onActivated).toHaveBeenCalledTimes(1);
    });
    expect(acceptInvitation).toHaveBeenCalledWith({
      token: TOKEN,
      password: PASSWORD,
    });
    // The address is the endpoint's answer, never something the person had to
    // retype: they proved possession of it by holding the token.
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: EMAIL,
      password: PASSWORD,
    });
  });

  it("does not report a failed activation when only the sign-in failed", async () => {
    // The account exists at this point. Saying activation failed would invite a
    // second attempt at something that has already happened, and the second
    // attempt would answer "this link has already been used".
    acceptInvitation.mockResolvedValue({
      ok: true,
      value: { personId: "person-astrid", email: EMAIL },
    });
    signInWithPassword.mockResolvedValue({
      status: "failed",
      code: "unknown",
    });
    const onActivated = renderScreen();

    await chooseAPassword();

    expect(await screen.findByText(/Kontot är aktiverat\./)).not.toBeNull();
    expect(onActivated).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: "Till inloggningen" }),
    ).not.toBeNull();
  });
});

describe("a link that cannot be used", () => {
  it("says so straight away when the link carried no token", () => {
    renderScreen(vi.fn(), "");

    expect(screen.getByText(/Länken fungerar inte\./)).not.toBeNull();
    // Nothing to send, so nothing is sent - and no password is collected for a
    // request that could never be made.
    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/lösenord/i)).toBeNull();
  });

  it.each([
    ["invalid-token", /Länken fungerar inte\./],
    ["already-accepted", /Länken är redan använd\./],
    ["already-has-account", /Du har redan ett konto i föreningen\./],
    ["expired", /Inbjudan har gått ut\./],
    ["no-email", /Registret har ingen e-postadress för dig/],
  ])("explains %s in its own words", async (reason, sentence) => {
    acceptInvitation.mockResolvedValue(refusedWith(reason));
    renderScreen();

    await chooseAPassword();

    expect(await screen.findByText(sentence)).not.toBeNull();
    // Nothing here can be repaired by typing the password again, so the form
    // goes rather than inviting an attempt that cannot succeed.
    expect(screen.queryByLabelText(/lösenord/i)).toBeNull();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it.each(["already-accepted", "already-has-account"])(
    "points %s at the sign-in screen, because the account exists",
    async (reason) => {
      acceptInvitation.mockResolvedValue(refusedWith(reason, 409));
      renderScreen();

      await chooseAPassword();

      expect(
        await screen.findByRole("link", { name: "Till inloggningen" }),
      ).not.toBeNull();
    },
  );

  it("keeps the form for a failure another attempt could survive", async () => {
    acceptInvitation.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    renderScreen();

    await chooseAPassword();

    expect(
      await screen.findByText(/Kontot kunde inte aktiveras just nu\./),
    ).not.toBeNull();
    expect(screen.getByLabelText(/lösenord/i)).not.toBeNull();
    expect(
      screen.queryByRole("link", { name: "Till inloggningen" }),
    ).toBeNull();
  });
});
