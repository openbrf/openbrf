import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestMagicLink,
  signInWithPassword,
  verifySecondFactor,
} from "./sign-in-methods";

/**
 * These map the auth client's responses onto outcomes the form can render.
 *
 * Two cases matter most. A two-factor challenge must not read as success:
 * Better Auth answers a password sign-in for a TOTP account with
 * `twoFactorRedirect` instead of a session, and treating that as success would
 * tell the viewer they are signed in when they are not. And every
 * wrong-credential shape must collapse onto one outcome, so no upstream code -
 * present or future - can make the client answer "does this address have an
 * account".
 */
const signInEmail = vi.fn();
const signInMagicLink = vi.fn();
const verifyTotp = vi.fn();

/*
 * The indirection through an arrow is load-bearing, not style: vi.mock factories
 * are hoisted and run when the mocked module is first imported, which happens
 * before these consts initialize. Capturing the binding is fine, dereferencing
 * it is not - so `email: (...args) => signInEmail(...args)` works where
 * `email: signInEmail` would read the binding too early.
 */
vi.mock("./auth-client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => signInEmail(...args),
      magicLink: (...args: unknown[]) => signInMagicLink(...args),
    },
    twoFactor: {
      verifyTotp: (...args: unknown[]) => verifyTotp(...args),
    },
  },
}));

beforeEach(() => {
  signInEmail.mockReset();
  signInMagicLink.mockReset();
  verifyTotp.mockReset();
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

  it.each([
    "INVALID_EMAIL_OR_PASSWORD",
    "INVALID_PASSWORD",
    "USER_NOT_FOUND",
    "USER_EMAIL_NOT_FOUND",
    "CREDENTIAL_ACCOUNT_NOT_FOUND",
  ])("renders %s as one indistinguishable credential failure", async (code) => {
    /*
     * An unknown address and a wrong password must stay indistinguishable.
     * Better Auth currently sends INVALID_EMAIL_OR_PASSWORD for both on this
     * endpoint; the rest are real codes it uses elsewhere and are covered here
     * so the property does not quietly depend on that default holding.
     */
    signInEmail.mockResolvedValue({
      data: null,
      error: { code, message: `upstream text for ${code}` },
    });

    await expect(
      signInWithPassword({ email: "a@b.se", password: "x" }),
    ).resolves.toEqual({ status: "failed", code: "invalid-credentials" });
  });

  it("never carries the upstream message", async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { code: "INVALID_PASSWORD", message: "Invalid password" },
    });

    const outcome = await signInWithPassword({
      email: "a@b.se",
      password: "x",
    });

    // A message field would end up rendered, in whatever language the API
    // happens to speak.
    expect(outcome).not.toHaveProperty("message");
  });

  it("falls back to a generic failure for an unrecognised code", async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { code: "SOMETHING_NEW_UPSTREAM" },
    });

    await expect(
      signInWithPassword({ email: "a@b.se", password: "x" }),
    ).resolves.toEqual({ status: "failed", code: "unknown" });
  });

  it("falls back to a generic failure when there is no code at all", async () => {
    signInEmail.mockResolvedValue({ data: null, error: {} });

    await expect(
      signInWithPassword({ email: "a@b.se", password: "x" }),
    ).resolves.toEqual({ status: "failed", code: "unknown" });
  });
});

describe("verifySecondFactor", () => {
  it("reports a session once the code is accepted", async () => {
    verifyTotp.mockResolvedValue({ data: { token: "t" }, error: null });

    await expect(verifySecondFactor({ code: "123456" })).resolves.toEqual({
      status: "signed-in",
    });
  });

  it("sends only the code, since the challenge lives in a cookie", async () => {
    verifyTotp.mockResolvedValue({ data: {}, error: null });

    await verifySecondFactor({ code: "123456" });

    expect(verifyTotp).toHaveBeenCalledWith({ code: "123456" });
  });

  it("distinguishes a wrong code from an expired challenge", async () => {
    verifyTotp.mockResolvedValue({
      data: null,
      error: { code: "INVALID_CODE" },
    });
    await expect(verifySecondFactor({ code: "000000" })).resolves.toEqual({
      status: "failed",
      code: "invalid-code",
    });

    // Different remedy: a wrong code invites another try, an expired challenge
    // means starting over from the password.
    verifyTotp.mockResolvedValue({
      data: null,
      error: { code: "INVALID_TWO_FACTOR_COOKIE" },
    });
    await expect(verifySecondFactor({ code: "000000" })).resolves.toEqual({
      status: "failed",
      code: "second-factor-expired",
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

  it("reports the same thing for an address the API will not send to", async () => {
    /*
     * The API answers this endpoint identically whether the address is unknown,
     * ordinary, or has TOTP enrolled and is therefore refused a link. It
     * explains a refusal by email to the mailbox owner instead. This asserts
     * the client keeps that property rather than reintroducing a
     * distinguishable answer.
     */
    signInMagicLink.mockResolvedValue({ data: {}, error: null });

    await expect(
      requestMagicLink({ email: "totp-enrolled@exempel.se" }),
    ).resolves.toEqual({ status: "link-sent" });
  });
});
