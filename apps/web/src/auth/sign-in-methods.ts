import { authClient } from "./auth-client";

/**
 * Why a sign-in attempt did not succeed, in this application's own vocabulary.
 *
 * Deliberately not Better Auth's error codes: those are an upstream detail, and
 * mapping them here once means a rename upstream is a one-line change rather
 * than a hunt through translation files.
 */
export type SignInFailureCode =
  "invalid-credentials" | "invalid-code" | "second-factor-expired" | "unknown";

/**
 * The result of an attempted sign-in.
 *
 * A discriminated union rather than throwing, because every one of these is an
 * expected outcome the form has to render, not an exception.
 */
export type SignInOutcome =
  | { status: "signed-in" }
  /** The account has TOTP enrolled; a code is required to finish. */
  | { status: "second-factor-required" }
  /** A magic link was sent, so there is nothing more to do in this tab. */
  | { status: "link-sent" }
  | { status: "failed"; code: SignInFailureCode };

/*
 * Every wrong-credential shape collapses onto one outcome on purpose.
 *
 * Better Auth 1.7.1 already answers /sign-in/email with a single
 * INVALID_EMAIL_OR_PASSWORD whether the address is unknown or the password is
 * wrong, so there is nothing to repair today - this keeps it that way. The
 * finer-grained codes below are real and appear on other endpoints, so mapping
 * them all onto one outcome means the property holds no matter which code
 * arrives, rather than resting on an upstream default that could change in a
 * minor release. On an instance holding a statutory register, "does this
 * address have an account" is not a question a public endpoint should answer.
 */
const FAILURE_CODES: Readonly<Record<string, SignInFailureCode>> = {
  INVALID_EMAIL_OR_PASSWORD: "invalid-credentials",
  INVALID_PASSWORD: "invalid-credentials",
  USER_NOT_FOUND: "invalid-credentials",
  USER_EMAIL_NOT_FOUND: "invalid-credentials",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "invalid-credentials",
  INVALID_CODE: "invalid-code",
  INVALID_TWO_FACTOR_COOKIE: "second-factor-expired",
};

/** Maps an upstream error onto an outcome this application can translate. */
function toFailure(error: { code?: string | undefined }): SignInOutcome {
  const code = error.code === undefined ? undefined : FAILURE_CODES[error.code];
  return { status: "failed", code: code ?? "unknown" };
}

/**
 * Signs in with an email address and password.
 *
 * An account with TOTP enrolled does not get a session here: Better Auth
 * answers with a two-factor challenge instead, which the caller must handle
 * rather than treat as success.
 */
export async function signInWithPassword(input: {
  email: string;
  password: string;
}): Promise<SignInOutcome> {
  const { data, error } = await authClient.signIn.email({
    email: input.email,
    password: input.password,
  });

  if (error !== null && error !== undefined) {
    return toFailure(error);
  }
  if (data !== null && "twoFactorRedirect" in data && data.twoFactorRedirect) {
    return { status: "second-factor-required" };
  }
  return { status: "signed-in" };
}

/**
 * Finishes a sign-in that was held back for a second factor.
 *
 * The challenge itself lives in a cookie Better Auth set when the password
 * check passed, so only the code travels from here.
 */
export async function verifySecondFactor(input: {
  code: string;
}): Promise<SignInOutcome> {
  const { error } = await authClient.twoFactor.verifyTotp({
    code: input.code,
  });

  if (error !== null && error !== undefined) {
    return toFailure(error);
  }
  return { status: "signed-in" };
}

/**
 * Requests a sign-in link by email.
 *
 * This reports success for any address, including one with no account and one
 * the API refuses to send a link to because it has TOTP enrolled. That is the
 * API's documented policy, not an oversight: a distinguishable answer on a
 * public endpoint would confirm whether an address has an account, and whether
 * that account has a second factor. The refusal is explained in an email to the
 * mailbox owner, so the copy shown here says a link has been sent *if* the
 * address is known rather than promising one unconditionally.
 */
export async function requestMagicLink(input: {
  email: string;
}): Promise<SignInOutcome> {
  const { error } = await authClient.signIn.magicLink({
    email: input.email,
  });

  if (error !== null && error !== undefined) {
    return toFailure(error);
  }
  return { status: "link-sent" };
}
