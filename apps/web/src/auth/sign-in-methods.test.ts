import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestMagicLink, signInWithPassword } from "./sign-in-methods";

/**
 * These map the auth client's responses onto outcomes the form can render.
 *
 * The case that matters most is the two-factor challenge: Better Auth answers a
 * password sign-in for a TOTP account with `twoFactorRedirect` instead of a
 * session, and treating that as success would tell the viewer they are signed
 * in when they are not.
 */
const signInEmail = vi.fn();
const signInMagicLink = vi.fn();

vi.mock("./auth-client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => signInEmail(...args),
      magicLink: (...args: unknown[]) => signInMagicLink(...args),
    },
  },
}));

beforeEach(() => {
  signInEmail.mockReset();
  signInMagicLink.mockReset();
});

describe("signInWithPassword", () => {
  it("reports a session as signed in", async () => {
    signInEmail.mockResolvedValue({ data: { user: {} }, error: null });

    await expect(
      signInWithPassword({ email: "a@b.se", password: "x" }),
    ).resolves.toEqual({ status: "signed-in" });
  });

  it("reports a two-factor challenge instead of success", async () => {
    signInEmail.mockResolvedValue({
      data: { twoFactorRedirect: true },
      error: null,
    });

    // Calling this signed-in would be a lie the viewer acts on.
    await expect(
      signInWithPassword({ email: "a@b.se", password: "x" }),
    ).resolves.toEqual({ status: "second-factor-required" });
  });

  it("passes the server's message through on failure", async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { message: "Invalid email or password" },
    });

    await expect(
      signInWithPassword({ email: "a@b.se", password: "x" }),
    ).resolves.toEqual({
      status: "failed",
      message: "Invalid email or password",
    });
  });
});

describe("requestMagicLink", () => {
  it("reports a sent link", async () => {
    signInMagicLink.mockResolvedValue({ data: {}, error: null });

    await expect(requestMagicLink({ email: "a@b.se" })).resolves.toEqual({
      status: "link-sent",
    });
  });

  it("surfaces the refusal for an account with TOTP enrolled", async () => {
    // The API refuses a link for a TOTP account, because it would grant a
    // session on mailbox access alone. The reason must reach the viewer.
    signInMagicLink.mockResolvedValue({
      data: null,
      error: {
        message:
          "This account uses an authenticator app. Sign in with your password and code, or with a passkey.",
      },
    });

    const outcome = await requestMagicLink({ email: "a@b.se" });

    expect(outcome.status).toBe("failed");
    expect(outcome).toMatchObject({ message: /authenticator app/ });
  });
});
