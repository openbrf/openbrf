import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { DisplayScreen } from "../display/DisplayScreen";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { Notice } from "../ui/Notice";

/**
 * The display screen inside the application frame (ADR 0050).
 *
 * As the devices screen is: the viewer is loaded here so the band carries the
 * housing cooperative's name and accent colour, and the capability is checked
 * here because the whole screen belongs to whoever manages the website. The
 * API refuses every call behind it regardless of what this decides.
 */
export function DisplayRoute(): ReactElement {
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
          {t("display.loadFailed")}
        </Notice>
      ) : viewer === null ? (
        <p className="text-body text-ink-muted" role="status">
          {t("display.loading")}
        </p>
      ) : viewer.capabilities.includes("site:manage") ? (
        <DisplayScreen />
      ) : (
        <Notice tone="info">{t("siteAdmin.notAllowed")}</Notice>
      )}
    </AppShell>
  );
}
