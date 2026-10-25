import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { FeesScreen } from "../fees/FeesScreen";
import { AppShell } from "../shell/AppShell";
import { isOffered, navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { BoardPageRefused } from "../ui/BoardPage";
import { Notice } from "../ui/Notice";

/**
 * The fees and their notices inside the application frame.
 *
 * The viewer is loaded here rather than in the screen so the band can carry the
 * housing cooperative's real name and its accent colour, and so the navigation
 * is the one this account is actually offered. An account the band does not
 * offer the page is told so in the sentence every refused board page says,
 * and the screen asks the API for nothing.
 */
export function FeesRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const load = async (): Promise<void> => {
      const result = await fetchViewer();
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
          {t("fees.loadFailed")}
        </Notice>
      ) : viewer === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("fees.loading")}
        </p>
      ) : isOffered(viewer.capabilities, "/board/fees") ? (
        <FeesScreen />
      ) : (
        <BoardPageRefused />
      )}
    </AppShell>
  );
}
