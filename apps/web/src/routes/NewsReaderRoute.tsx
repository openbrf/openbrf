import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { NewsScreen } from "../news/NewsScreen";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { Notice } from "../ui/Notice";

/**
 * The association's news, as the house reads it, inside the application frame.
 *
 * The viewer is loaded here rather than in the screen so the band can carry the
 * housing cooperative's real name and its accent colour, and so the navigation is
 * the one this account is actually offered. The capabilities arrive with the same
 * request, which is what the screen reads to decide whether it offers the
 * strike-through control.
 *
 * Not to be confused with NewsRoute, which is the board writing the news under
 * the website's own part of the administration. Two screens over one table,
 * exactly as the API has two controllers over it: one takes `site:manage` and
 * publishes in the cooperative's name, this one takes `news:comment` and belongs
 * to whoever lives in the house.
 */
export function NewsReaderRoute(): ReactElement {
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
          {t("newsReader.loadFailed")}
        </Notice>
      ) : viewer === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("newsReader.loading")}
        </p>
      ) : (
        <NewsScreen viewer={viewer} />
      )}
    </AppShell>
  );
}
