import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchSetupState, fetchViewer } from "../api/instance";
import { AdministratorStep } from "../setup/AdministratorStep";
import { SetupWizard } from "../setup/SetupWizard";
import { PANEL, SECONDARY_BUTTON } from "../ui/controls";

type Access =
  | { kind: "loading" }
  | { kind: "first-boot" }
  | { kind: "authorized-admin" }
  | { kind: "closed" };

/**
 * The setup screen, and the client half of its access rule.
 *
 * Two ways in, and no third:
 *
 *   First boot. The instance is unclaimed - no account exists and setup has
 *   never been completed - so the wizard is served to whoever reaches it,
 *   starting at the administrator step. This is the only unauthenticated path.
 *
 *   An authorised admin. Setup was started and left unfinished, so an admin who
 *   is signed in can resume it. The administrator step is not offered: the
 *   server refuses it once an account exists, and showing it would invite a
 *   second administrator to be created from a screen that cannot do it.
 *
 * Anything else is closed, and the screen says so rather than rendering a form
 * whose every submission would be refused. This is presentation only: the guard
 * that matters is the server's, which decides the same question from the
 * database rather than from what a browser was told.
 */
export function SetupRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [access, setAccess] = useState<Access>({ kind: "loading" });

  useEffect(() => {
    const decide = async (): Promise<void> => {
      const state = await fetchSetupState();
      if (state.ok && state.value.setupRequired) {
        setAccess({ kind: "first-boot" });
        return;
      }

      // Not first boot, so the only remaining way in is an admin resuming.
      const viewer = await fetchViewer();
      setAccess(
        viewer.ok && viewer.value.capabilities.includes("association:manage")
          ? { kind: "authorized-admin" }
          : { kind: "closed" },
      );
    };

    void decide();
  }, []);

  if (access.kind === "loading") {
    return (
      <p role="status" className="p-6 text-body text-ink-muted">
        {t("app.loading")}
      </p>
    );
  }

  if (access.kind === "closed") {
    return (
      <div className={`mx-auto mt-10 flex max-w-md flex-col gap-4 ${PANEL}`}>
        <h1 className="text-headline">{t("setup.closed.title")}</h1>
        <p className="text-body text-ink-muted">{t("setup.closed.body")}</p>
        <div>
          <button
            type="button"
            onClick={() => {
              void navigate({ to: "/sign-in" });
            }}
            className={SECONDARY_BUTTON}
          >
            {t("setup.closed.signIn")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <SetupWizard
      administratorNeeded={access.kind === "first-boot"}
      administratorStep={(props) => <AdministratorStep {...props} />}
      onFinished={() => {
        void navigate({ to: "/" });
      }}
    />
  );
}
