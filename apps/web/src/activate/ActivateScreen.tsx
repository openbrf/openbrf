import { Link } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { signInWithPassword } from "../auth/sign-in-methods";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { acceptInvitation } from "./activate-api";

/**
 * Where one activation attempt has got to.
 *
 * `stopped` and `retryable` are separate states because the difference decides
 * whether the form stays on screen. An expired link cannot be repaired by
 * typing the password again, and leaving the form there would invite somebody
 * to keep trying something that will never work; a request that failed to reach
 * the server is the opposite case, and taking the form away would strand a
 * person who has an invitation that is perfectly good.
 */
type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "retryable"; messageKey: TranslationKey }
  | { kind: "stopped"; messageKey: TranslationKey; offerSignIn: boolean };

/**
 * Every refusal the activation endpoint answers with, as one sentence each.
 *
 * `offerSignIn` marks the two that mean the account already exists. They are
 * not failures from the person's side at all - the ordinary cause is a second
 * click on the same emailed link - so those say so and point at the sign-in
 * screen rather than reading as a dead end.
 */
const FAILURES: Readonly<
  Record<string, { messageKey: TranslationKey; offerSignIn: boolean }>
> = {
  "invalid-token": {
    messageKey: "activate.errors.invalidToken",
    offerSignIn: false,
  },
  "already-accepted": {
    messageKey: "activate.errors.alreadyAccepted",
    offerSignIn: true,
  },
  "already-has-account": {
    messageKey: "activate.errors.alreadyHasAccount",
    offerSignIn: true,
  },
  expired: { messageKey: "activate.errors.expired", offerSignIn: false },
  "no-email": { messageKey: "activate.errors.noEmail", offerSignIn: false },
};

export interface ActivateScreenProps {
  /** The token out of the emailed link. Empty when the link carried none. */
  token: string;
  /** Called once the new account holds a session. */
  onActivated: () => void;
}

/**
 * Activation, reached from the link in an invitation email.
 *
 * The screen asks for one thing - a password - because everything else about
 * the person is already in the register, and the token in the URL is what says
 * which person this is. There is no second password field: a browser fills a
 * new password into both, and a repeat field mostly catches the people who
 * would notice a typo at the next sign-in anyway.
 *
 * A successful activation leaves the person signed in. That is not the endpoint
 * minting a session: the endpoint answers with the address the account was
 * created for, and this screen signs in with it through the ordinary password
 * path, so the rate limiting, the cookie settings and the second-factor policy
 * all apply exactly as they do to every other sign-in on the instance. If that
 * sign-in does not land, the activation still happened, and the screen says so
 * and offers the sign-in screen rather than inviting a second activation of an
 * account that now exists.
 */
export function ActivateScreen({
  token,
  onActivated,
}: ActivateScreenProps): ReactElement {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  /*
   * A link with no token at all never reaches the API. There is nothing to
   * send, the answer would be the same, and asking for a password first would
   * be collecting one for nothing.
   */
  const linkCarriesNoToken = token.trim() === "";

  const stopped = linkCarriesNoToken
    ? {
        messageKey: "activate.errors.invalidToken" as const,
        offerSignIn: false,
      }
    : status.kind === "stopped"
      ? { messageKey: status.messageKey, offerSignIn: status.offerSignIn }
      : null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setStatus({ kind: "working" });

    const accepted = await acceptInvitation({ token, password });
    if (!accepted.ok) {
      const known = FAILURES[accepted.failure.reason];
      setStatus(
        known === undefined
          ? { kind: "retryable", messageKey: "activate.errors.unknown" }
          : { kind: "stopped", ...known },
      );
      return;
    }

    /*
     * The account exists from here on, whatever happens next. A brand-new
     * account cannot have an authenticator app enrolled, so the only outcomes
     * are a session or a request that did not land - and neither is a failed
     * activation, which is why nothing below says the activation went wrong.
     */
    const signedIn = await signInWithPassword({
      email: accepted.value.email,
      password,
    });
    if (signedIn.status !== "signed-in") {
      setStatus({
        kind: "stopped",
        messageKey: "activate.autoSignInFailed",
        offerSignIn: true,
      });
      return;
    }

    onActivated();
  };

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-5 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-headline">{t("activate.heading")}</h1>
        <p className="text-body text-ink-muted">{t("activate.intro")}</p>
      </header>

      {stopped === null ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <label className={LABEL}>
            {t("activate.password")}
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className={FIELD}
            />
            <span className={HINT}>{t("activate.passwordHint")}</span>
          </label>

          <button
            type="submit"
            disabled={status.kind === "working"}
            className={PRIMARY_BUTTON}
          >
            {status.kind === "working"
              ? t("activate.working")
              : t("activate.submit")}
          </button>
        </form>
      ) : null}

      {/*
        One notice for every outcome. The tone follows what the message means
        rather than which state produced it: an account that already exists is a
        caution with somewhere to go, while a link that cannot be used is a
        refusal. Live except for the one standing case - a link that arrived
        without a token at all, which is on screen from the first render.
      */}
      {status.kind === "retryable" ? (
        <Notice tone="danger" live>
          {t(status.messageKey)}
        </Notice>
      ) : null}

      {stopped === null ? null : (
        <>
          <Notice
            tone={stopped.offerSignIn ? "warn" : "danger"}
            live={!linkCarriesNoToken}
          >
            {t(stopped.messageKey)}
          </Notice>
          {stopped.offerSignIn ? (
            <Link to="/sign-in" className={SECONDARY_BUTTON}>
              {t("activate.signInInstead")}
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}
