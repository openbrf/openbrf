import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { Notice } from "../ui/Notice";
import { ConnectedAppsScreen } from "./ConnectedAppsScreen";

/**
 * Every connection on the instance, inside the application frame.
 *
 * The viewer is loaded here rather than in the screen so the band carries the
 * housing cooperative's real name and its accent colour, and so the navigation
 * is the one this account is actually offered. Which of the screen's three
 * capabilities this account holds is the screen's own question, and the API
 * enforces all three regardless.
 *
 * This module sits beside the screen rather than under routes/ so that the
 * router registers it; see the route registration in routes/router.tsx.
 */
export function ConnectedAppsRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    /*
     * An answer that arrives after the screen is gone is dropped. The accent
     * override is the reason this matters beyond a stale state write: it
     * installs a stylesheet on the document rather than styling anything here,
     * so a late response would repaint whatever screen the member had moved on
     * to in this association's colour.
     */
    let active = true;

    const load = async (): Promise<void> => {
      const result = await fetchViewer();
      if (!active) {
        return;
      }
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setViewer(result.value);
      applyAccentOverride(
        result.value.housingCooperative?.primaryColor ?? null,
      );
    };

    void load();

    return () => {
      active = false;
    };
  }, []);

  return (
    <AppShell
      housingCooperativeName={
        viewer?.housingCooperative?.name ?? t("app.housingCooperative")
      }
      logo={{
        light: viewer?.housingCooperative?.logoUrl ?? null,
        dark: viewer?.housingCooperative?.logoDarkUrl ?? null,
      }}
      personName={
        viewer === null
          ? undefined
          : `${viewer.firstName} ${viewer.lastName}`.trim()
      }
      navItems={navItemsFor(viewer?.capabilities)}
      onSignOut={() => {
        void authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              void navigate({ to: "/sign-in" });
            },
          },
        });
      }}
    >
      {failed ? (
        <Notice tone="danger" live>
          {t("connectedApps.loadFailed")}
        </Notice>
      ) : viewer === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("connectedApps.loading")}
        </p>
      ) : (
        <ConnectedAppsScreen viewer={viewer} />
      )}
    </AppShell>
  );
}
