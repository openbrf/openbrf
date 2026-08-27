import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import {
  requestMagicLink,
  signInWithPassword,
  verifySecondFactor,
  type SignInFailureCode,
  type SignInOutcome,
} from "./sign-in-methods";

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "sent" }
  | { kind: "failed"; code: SignInFailureCode };

/** Every failure the form can render, as a translated sentence. */
const FAILURE_KEY: Readonly<Record<SignInFailureCode, TranslationKey>> = {
  "invalid-credentials": "signIn.errors.invalidCredentials",
  "invalid-code": "signIn.errors.invalidCode",
  "second-factor-expired": "signIn.errors.secondFactorExpired",
  unknown: "signIn.errors.unknown",
};

const FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-raised px-3 text-body text-ink";
const LABEL = "flex flex-col gap-1.5 text-label uppercase text-ink-muted";
const PRIMARY_BUTTON =
  "min-h-11 rounded-control bg-ink px-4 text-small font-semibold text-page transition-colors duration-150 ease-out disabled:opacity-60";

/**
 * Sign-in.
 *
 * Two things here are deliberate and easy to "fix" into a security problem.
 *
 * It never explains a failure in the API's own words. Those words are English
 * while this screen is Swedish by default, and they are also the wrong place to
 * settle how much a public endpoint gives away. Every failure therefore arrives
 * as a code and is rendered as one translated sentence - see the note on the
 * code mapping in sign-in-methods.ts.
 *
 * It also never decides whether a magic link is allowed. The API refuses one
 * for an account with TOTP enrolled, because a link would grant a session on
 * mailbox access alone and bypass the second factor - but it refuses by email
 * to the mailbox owner and answers this endpoint identically either way. A
 * client-side check for "does this account have TOTP" would leak exactly what
 * that policy protects, so the copy shown here is conditional ("if that address
 * has an account") rather than a promise.
 */
export function SignInScreen({
  onSignedIn,
}: {
  onSignedIn?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  /*
   * Held apart from `status` on purpose. A rejected code is a failure, and if
   * the challenge were a status the form would fall back to email-and-password
   * on the first typo - while Better Auth still holds a pending two-factor
   * cookie, so there would be no way to finish signing in.
   */
  const [awaitingSecondFactor, setAwaitingSecondFactor] = useState(false);

  const apply = (outcome: SignInOutcome): void => {
    switch (outcome.status) {
      case "signed-in":
        setStatus({ kind: "idle" });
        onSignedIn?.();
        return;
      case "link-sent":
        setStatus({ kind: "sent" });
        return;
      case "second-factor-required":
        setStatus({ kind: "idle" });
        setAwaitingSecondFactor(true);
        return;
      case "failed":
        /*
         * An expired or missing challenge is the one failure that has to hand
         * the viewer back: the two-factor cookie is gone, so no code can be
         * accepted any more, and the message tells them to start again from the
         * password. Every other failure stays on the code form, where another
         * attempt still works.
         */
        if (outcome.code === "second-factor-expired") {
          setAwaitingSecondFactor(false);
          setCode("");
        }
        setStatus({ kind: "failed", code: outcome.code });
        return;
    }
  };

  const onSubmitPassword = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    setStatus({ kind: "working" });
    apply(await signInWithPassword({ email, password }));
  };

  const onSubmitCode = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    setStatus({ kind: "working" });
    apply(await verifySecondFactor({ code }));
  };

  const onRequestLink = async (): Promise<void> => {
    setStatus({ kind: "working" });
    apply(await requestMagicLink({ email }));
  };

  const working = status.kind === "working";

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-5 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-headline">{t("signIn.heading")}</h1>
        <p className="text-body text-ink-muted">
          {awaitingSecondFactor
            ? t("signIn.secondFactorRequired")
            : t("signIn.intro")}
        </p>
      </header>

      {awaitingSecondFactor ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            void onSubmitCode(event);
          }}
        >
          <label className={LABEL}>
            {t("signIn.code")}
            <input
              type="text"
              name="code"
              /* The browser and a phone keyboard both need telling: this is a
                 short numeric one-time code, not a password to remember. */
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              required
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
              className={`${FIELD} font-data tracking-[0.3em]`}
            />
          </label>

          <button type="submit" disabled={working} className={PRIMARY_BUTTON}>
            {working ? t("signIn.working") : t("signIn.verify")}
          </button>
        </form>
      ) : (
        <>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              void onSubmitPassword(event);
            }}
          >
            <label className={LABEL}>
              {t("signIn.email")}
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                className={FIELD}
              />
            </label>

            <label className={LABEL}>
              {t("signIn.password")}
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
                className={FIELD}
              />
            </label>

            <button type="submit" disabled={working} className={PRIMARY_BUTTON}>
              {working ? t("signIn.working") : t("signIn.submit")}
            </button>
          </form>

          <button
            type="button"
            disabled={working || email === ""}
            onClick={() => {
              void onRequestLink();
            }}
            className="min-h-11 rounded-control border border-line-strong px-4 text-small font-semibold text-ink transition-colors duration-150 ease-out disabled:opacity-60"
          >
            {t("signIn.magicLink")}
          </button>
        </>
      )}

      {/*
        One live region for every outcome, so a screen reader hears the result
        without the focus being moved out from under the reader.
      */}
      <p role="status" aria-live="polite" className="text-small">
        {status.kind === "sent" ? (
          <span className="text-ok">{t("signIn.linkSent")}</span>
        ) : null}
        {status.kind === "failed" ? (
          <span className="text-danger">{t(FAILURE_KEY[status.code])}</span>
        ) : null}
      </p>
    </div>
  );
}
