import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  requestMagicLink,
  signInWithPassword,
  type SignInOutcome,
} from "./sign-in-methods";

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "sent" }
  | { kind: "second-factor" }
  | { kind: "failed"; message: string };

const FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-raised px-3 text-body text-ink";
const LABEL = "flex flex-col gap-1.5 text-label uppercase text-ink-muted";

/**
 * Sign-in.
 *
 * Offers a password and a magic link. Notice what it does NOT do: decide
 * whether a magic link is allowed. The API refuses one for an account with TOTP
 * enrolled, because a link would grant a session on mailbox access alone and
 * bypass the second factor. That refusal comes back as a normal failure whose
 * message says what to use instead, and is shown verbatim - a client-side guess
 * about which accounts have TOTP would leak who has it.
 */
export function SignInScreen({
  onSignedIn,
}: {
  onSignedIn?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

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
        setStatus({ kind: "second-factor" });
        return;
      case "failed":
        // The API's own message is preferred when it has one: it carries the
        // reason, such as a magic link being refused for a TOTP account.
        setStatus({
          kind: "failed",
          message:
            outcome.message === "" ? t("signIn.failed") : outcome.message,
        });
        return;
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setStatus({ kind: "working" });
    apply(await signInWithPassword({ email, password }));
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
        <p className="text-body text-ink-muted">{t("signIn.intro")}</p>
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void onSubmit(event);
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

        <button
          type="submit"
          disabled={working}
          className="min-h-11 rounded-control bg-ink px-4 text-small font-semibold text-page transition-colors duration-150 ease-out disabled:opacity-60"
        >
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

      {/*
        One live region for every outcome, so a screen reader hears the result
        without the focus being moved out from under the reader.
      */}
      <p role="status" aria-live="polite" className="text-small">
        {status.kind === "sent" ? (
          <span className="text-ok">{t("signIn.linkSent")}</span>
        ) : null}
        {status.kind === "second-factor" ? (
          <span className="text-warn">{t("signIn.secondFactorRequired")}</span>
        ) : null}
        {status.kind === "failed" ? (
          <span className="text-danger">{status.message}</span>
        ) : null}
      </p>
    </div>
  );
}
