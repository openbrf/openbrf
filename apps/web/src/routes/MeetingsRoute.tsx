import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { MeetingsScreen } from "../meetings/MeetingsScreen";
import { AppShell } from "../shell/AppShell";
import { isOffered, navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { BoardPageRefused } from "../ui/BoardPage";
import { Notice } from "../ui/Notice";

/**
 * The general meeting, the board's page, inside the application frame.
 *
 * The viewer is loaded here rather than in the screen so the band can carry the
 * housing cooperative's real name and its accent colour, and so the navigation
 * is the one this account is actually offered.
 *
 * The capability is checked here as well as by the API, and only as courtesy:
 * the route guard requires a session and nothing more, so an account the band
 * does not offer the page reaches this component and is told plainly, in the
 * sentence every refused board page says (ADR 0049), rather than shown a
 * signed heading over a screen with nothing on it for them.
 */
export function MeetingsRoute(): ReactElement {
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
          {t("meetings.loadFailed")}
        </Notice>
      ) : viewer === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("meetings.loading")}
        </p>
      ) : isOffered(viewer.capabilities, "/board/meetings") ? (
        <MeetingsScreen viewer={viewer} />
      ) : (
        <BoardPageRefused />
      )}
    </AppShell>
  );
}
