import { authClient } from "./auth-client";

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
  | { status: "failed"; message: string };

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
    return { status: "failed", message: error.message ?? "" };
  }
  if (data !== null && "twoFactorRedirect" in data && data.twoFactorRedirect) {
    return { status: "second-factor-required" };
  }
  return { status: "signed-in" };
}

/**
 * Requests a sign-in link by email.
 *
 * The API refuses this for an account with TOTP enrolled, because a link would
 * hand out a session on mailbox access alone and walk around the second factor.
 * That refusal arrives here as a normal failure and its message explains what
 * to use instead, so it must be shown rather than swallowed.
 */
export async function requestMagicLink(input: {
  email: string;
}): Promise<SignInOutcome> {
  const { error } = await authClient.signIn.magicLink({
    email: input.email,
  });

  if (error !== null && error !== undefined) {
    return { status: "failed", message: error.message ?? "" };
  }
  return { status: "link-sent" };
}
