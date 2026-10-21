import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { startSupportSession } from "../api/support";
import type { TranslationKey } from "../i18n/translation-key";
import { PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { OpenBrfLogo } from "../ui/OpenBrfLogo";

/** Where the one attempt this page makes has got to. */
type Status =
  | { kind: "working" }
  | { kind: "failed"; messageKey: TranslationKey; retry: boolean }
  /** Reached with no link: signed out, or opened by hand. */
  | { kind: "noLink" };

/** The token in the address's fragment, or empty. Reads and changes nothing. */
function tokenInAddress(): string {
  return window.location.hash.replace(/^#/, "").trim();
}

export interface SupportSignInScreenProps {
  /** Called once the support session has started. */
  onSignedIn: () => void;
}

/**
 * Where a supporter's sign-in link lands (ADR 0028).
 *
 * The link carries a single-use token in its fragment, so the browser never
 * sends it to a server and it appears in no access log and no Referer. This
 * page takes it out of the address bar before anything else happens - a link
 * left there would be in the history and in anything the supporter copied -
 * and sends it once to start the session. There is nothing to type: a
 * supporter has no account and no password, and the host sent the link to the
 * person it named.
 *
 * A link that does not work gets one sentence, whatever the reason was: used,
 * older than ten minutes, or issued under an access that has since closed. The
 * remedy is the same in each case, a new link from the host.
 */
export function SupportSignInScreen({
  onSignedIn,
}: SupportSignInScreenProps): ReactElement {
  const { t } = useTranslation();
  // Read once, while the fragment is still there.
  const [token] = useState(tokenInAddress);
  const [status, setStatus] = useState<Status>(
    token === "" ? { kind: "noLink" } : { kind: "working" },
  );
  // A link works once, so the effect sends it once, however often it runs.
  const sent = useRef(false);

  const signIn = async (): Promise<void> => {
    setStatus({ kind: "working" });
    const started = await startSupportSession(token);
    if (started.ok) {
      onSignedIn();
      return;
    }
    setStatus(
      started.failure.reason === "offline"
        ? { kind: "failed", messageKey: "support.signIn.offline", retry: true }
        : {
            kind: "failed",
            messageKey: "support.signIn.invalid",
            retry: false,
          },
    );
  };

  useEffect(() => {
    if (window.location.hash !== "") {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    if (token === "" || sent.current) {
      return;
    }
    sent.current = true;
    void signIn();
    // Once, on arrival: the token does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-5 py-10">
      <OpenBrfLogo className="mb-3" />
      <header className="flex flex-col gap-1">
        <h1 className="text-headline">{t("support.signIn.heading")}</h1>
        <p className="text-body text-ink-muted">{t("support.signIn.intro")}</p>
      </header>

      {status.kind === "working" ? (
        <p role="status" className="text-body text-ink-muted">
          {t("support.signIn.working")}
        </p>
      ) : null}

      {status.kind === "noLink" ? (
        <Notice tone="info">{t("support.signIn.noLink")}</Notice>
      ) : null}

      {status.kind === "failed" ? (
        <>
          <Notice tone="danger" live>
            {t(status.messageKey)}
          </Notice>
          {status.retry ? (
            <div>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={() => {
                  void signIn();
                }}
              >
                {t("support.signIn.retry")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
