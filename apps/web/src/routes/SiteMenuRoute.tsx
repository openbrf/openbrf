import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { MenuScreen } from "../site-admin/MenuScreen";
import { applyAccentOverride } from "../theme/accent-override";
import { Notice } from "../ui/Notice";

/**
 * The site menu inside the application frame.
 *
 * The viewer is loaded here rather than in the screen so the band carries the
 * housing cooperative's real name and its accent colour, both of which arrive
 * with the same request that says what this person may do. The capability is
 * checked here because the whole screen belongs to whoever manages the
 * website: there is nothing on it for an account without site:manage, and the
 * API refuses every call behind it regardless of what this decides.
 */
export function SiteMenuRoute(): ReactElement {
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
      personName={
        viewer === null
          ? undefined
          : `${viewer.firstName} ${viewer.lastName}`.trim()
      }
    >
      {failed ? (
        <Notice live tone="danger">
          {t("siteAdmin.menu.errors.loadFailed")}
        </Notice>
      ) : viewer === null ? (
        <p className="text-body text-ink-muted" role="status">
          {t("siteAdmin.menu.loading")}
        </p>
      ) : viewer.capabilities.includes("site:manage") ? (
        <MenuScreen />
      ) : (
        <Notice tone="info">{t("settings.errors.forbidden")}</Notice>
      )}
    </AppShell>
  );
}
