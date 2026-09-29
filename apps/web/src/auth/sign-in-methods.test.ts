import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestMagicLink,
  signInWithPasskey,
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
const signInPasskey = vi.fn();

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
      passkey: (...args: unknown[]) => signInPasskey(...args),
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
  signInPasskey.mockReset();
});

/** A browser that can offer a passkey prompt, which jsdom is not on its own. */
function withWebAuthn(): void {
  beforeEach(() => {
    Object.defineProperty(navigator, "credentials", {
      value: {},
      configurable: true,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "credentials");
  });
}

describe("a request that never reaches the server", () => {
  /*
   * The auth client resolves with an error for anything the server answered,
   * but rejects when the request itself fails. A rejection reaching the form
   * would leave it on "working" for good, so each method reports it as an
   * ordinary failure instead.
   */
  withWebAuthn();

  it.each([
    [
      "signInWithPassword",
      signInEmail,
      () => signInWithPassword({ email: "a@b.se", password: "x" }),
    ],
    [
      "verifySecondFactor",
      verifyTotp,
      () => verifySecondFactor({ code: "123456" }),
    ],
    [
      "requestMagicLink",
      signInMagicLink,
      () => requestMagicLink({ email: "a@b.se" }),
    ],
    ["signInWithPasskey", signInPasskey, () => signInWithPasskey()],
  ])("is a failure from %s, not a rejection", async (_name, call, attempt) => {
    call.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(attempt()).resolves.toEqual({
      status: "failed",
      code: "unknown",
    });
  });
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

describe("signInWithPasskey", () => {
  withWebAuthn();

  it.each(["AUTH_CANCELLED", "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY"])(
    "reads a prompt that ended with %s as cancelled",
    async (code) => {
      // The library answers a dismissed or timed-out prompt with a 400 and a
      // code of its own, having sent nothing to the server.
      signInPasskey.mockResolvedValue({
        data: null,
        error: { code, status: 400, statusText: "BAD_REQUEST" },
      });

      await expect(signInWithPasskey()).resolves.toEqual({
        status: "failed",
        code: "passkey-cancelled",
      });
    },
  );

  it("does not read a refusal from the server as cancelled", async () => {
    signInPasskey.mockResolvedValue({
      data: null,
      error: { code: "PASSKEY_NOT_FOUND", status: 401, statusText: "" },
    });

    await expect(signInWithPasskey()).resolves.toEqual({
      status: "failed",
      code: "unknown",
    });
  });
});

describe("requestMagicLink", () => {
  it("lands the link where it is told to", async () => {
    signInMagicLink.mockResolvedValue({ data: {}, error: null });

    await requestMagicLink({
      email: "a@b.se",
      destination: "/app/documents",
    });

    expect(signInMagicLink).toHaveBeenCalledWith({
      email: "a@b.se",
      callbackURL: "/app/documents",
    });
  });

  it("keeps an escaped consent query intact through the emailed link", async () => {
    signInMagicLink.mockResolvedValue({ data: {}, error: null });
    const destination =
      "/app/oauth/consent?client_id=https%3A%2F%2Fapp.example%2Fclient&scope=openid%20email&sig=a%2Bb%3D";

    await requestMagicLink({ email: "a@b.se", destination });

    const [{ callbackURL }] = signInMagicLink.mock.calls[0] as [
      { callbackURL: string },
    ];
    // What Better Auth 1.7 does with it: set as a query parameter on the
    // verify link, read back from that query, then decoded once more.
    const link = new URL("https://brf.example/api/auth/magic-link/verify");
    link.searchParams.set("callbackURL", callbackURL);
    const landed = decodeURIComponent(
      new URL(link.toString()).searchParams.get("callbackURL") ?? "",
    );
    expect(landed).toBe(destination);
  });

  it("lands the link at the application's start by default", async () => {
    // The plugin's own default is the origin's root, which is the
    // association's public website rather than the application.
    signInMagicLink.mockResolvedValue({ data: {}, error: null });

    await requestMagicLink({ email: "a@b.se" });

    expect(signInMagicLink).toHaveBeenCalledWith({
      email: "a@b.se",
      callbackURL: "/app",
    });
  });

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
