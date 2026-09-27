import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { createFirstAdministrator } from "../api/instance";
import { signInWithPassword } from "../auth/sign-in-methods";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { forgetClaim } from "./setup-claim";

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "failed"; messageKey: TranslationKey };

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  "already-claimed": "setup.administrator.errors.alreadyClaimed",
  "claim-token-invalid": "setup.administrator.errors.claimTokenInvalid",
  "invalid-email": "setup.administrator.errors.invalidEmail",
  "invalid-body": "setup.administrator.errors.weakPassword",
};

/**
 * The first step, and the only public one.
 *
 * It creates a person, the ADMIN grant and a sign-in account, and then signs in
 * with the password just chosen. The sign-in goes through the ordinary password
 * path rather than the setup endpoint minting a session, so the rate limiting,
 * the second-factor policy and the cookie settings all apply exactly as they do
 * to every other sign-in on this instance.
 *
 * From here on the wizard is admin-only: every remaining step needs the
 * association:manage capability this account has just been granted. A first-boot
 * wizard that stayed open would be an account-creation hole on an instance
 * holding a statutory register, so the server closes this route the moment an
 * account exists.
 *
 * And it opens only for the holder of the setup link (ADR 0023). Opened with
 * the link, the step says so and sends its token; opened without it, the step
 * asks for the code, which is the token as the link carries it.
 */
export function AdministratorStep({
  claimToken,
  onCreated,
}: {
  claimToken: string | null;
  onCreated: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setStatus({ kind: "working" });

    const created = await createFirstAdministrator({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      password,
      claimToken: claimToken ?? code.trim(),
    });

    if (!created.ok) {
      setStatus({
        kind: "failed",
        messageKey:
          FAILURES[created.failure.reason] ??
          "setup.administrator.errors.unknown",
      });
      return;
    }

    // Claimed, so the token opens nothing any more and is not kept.
    forgetClaim();

    const signedIn = await signInWithPassword({
      email: email.trim(),
      password,
    });
    if (signedIn.status !== "signed-in") {
      // The account exists, so the wizard must not offer to create it again.
      // Sending them to sign in by hand is the honest recovery.
      setStatus({
        kind: "failed",
        messageKey: "setup.administrator.signInPrompt",
      });
      return;
    }

    onCreated();
  };

  return (
    <Panel
      title={t("setup.administrator.title")}
      description={t("setup.administrator.intro")}
      notice={
        status.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(status.messageKey)}
          </Notice>
        ) : null
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {claimToken === null ? (
          <label className={LABEL}>
            {t("setup.administrator.claim.label")}
            <input
              type="text"
              name="claimToken"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
              className={FIELD_DATA}
            />
            <span className={HINT}>{t("setup.administrator.claim.hint")}</span>
          </label>
        ) : (
          <Notice tone="info">{t("setup.administrator.claim.fromLink")}</Notice>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("setup.administrator.firstName")}
            <input
              type="text"
              name="firstName"
              autoComplete="given-name"
              required
              value={firstName}
              onChange={(event) => {
                setFirstName(event.target.value);
              }}
              className={FIELD}
            />
          </label>

          <label className={LABEL}>
            {t("setup.administrator.lastName")}
            <input
              type="text"
              name="lastName"
              autoComplete="family-name"
              required
              value={lastName}
              onChange={(event) => {
                setLastName(event.target.value);
              }}
              className={FIELD}
            />
          </label>
        </div>

        <label className={LABEL}>
          {t("setup.administrator.email")}
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
          {t("setup.administrator.password")}
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
          <span className={HINT}>{t("setup.administrator.passwordHint")}</span>
        </label>

        <div>
          <button
            type="submit"
            disabled={status.kind === "working"}
            className={PRIMARY_BUTTON}
          >
            {status.kind === "working"
              ? t("setup.working")
              : t("setup.administrator.submit")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
