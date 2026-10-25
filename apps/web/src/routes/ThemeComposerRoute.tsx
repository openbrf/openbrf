import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { isReadOnly } from "../support/read-only";
import { applyAccentOverride } from "../theme/accent-override";
import { ThemeComposerScreen } from "../themes/ThemeComposerScreen";
import { Notice } from "../ui/Notice";

/**
 * The theme composer inside the application frame.
 *
 * Admin only, and the screen says so rather than rendering a form the API will
 * refuse. Hiding it is courtesy; the API enforces the same rule on every save.
 * A support session (ADR 0028) holds the capability and changes nothing, so it
 * is told that instead of being shown a form it cannot send.
 */
export function ThemeComposerRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ from: "/board/themes/compose" });
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

  const canManage =
    viewer?.capabilities.includes("association:manage") ?? false;

  return (
    <AppShell
      housingCooperativeName={
        viewer?.housingCooperative?.name ?? t("app.housingCooperative")
      }
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
          {t("themeCatalog.errors.unknown")}
        </Notice>
      ) : viewer === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("themeCatalog.loading")}
        </p>
      ) : canManage && isReadOnly(viewer) ? (
        /*
         * Everything on the composer is editing a theme, and its preview is
         * the draft being edited. A support session reads the themes, and
         * previews them, on the theme screen; here it is told why there is
         * nothing for it.
         */
        <Notice tone="info">{t("support.errors.readOnly")}</Notice>
      ) : canManage ? (
        <ThemeComposerScreen themeId={search.theme} />
      ) : (
        <Notice tone="info">{t("themeCatalog.errors.forbidden")}</Notice>
      )}
    </AppShell>
  );
}
