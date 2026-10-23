import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { PageEditorScreen } from "../site-admin/PageEditorScreen";
import { SiteAdminScreen } from "../site-admin/SiteAdminScreen";
import { applyAccentOverride } from "../theme/accent-override";
import { Notice } from "../ui/Notice";

/**
 * The association's own website inside the application frame.
 *
 * The viewer is loaded here rather than in the screen so the band carries the
 * housing cooperative's real name and its accent colour, both of which arrive
 * with the same request that says what this person may do. Whether the screen
 * has anything to offer is decided inside it, from site:manage, and enforced by
 * the API regardless.
 */
export function SiteAdminRoute(): ReactElement {
  return (
    <SiteAdminFrame>
      {(viewer) => <SiteAdminScreen viewer={viewer} />}
    </SiteAdminFrame>
  );
}

/**
 * One page of the website, in its editor, inside the same frame.
 *
 * The identifier is handed to the screen as it arrived; whether it names a
 * page is the API's answer, and the screen says so for one that does not.
 */
export function SitePageRoute(): ReactElement {
  const { pageId } = useParams({ from: "/board/site/pages/$pageId" });
  return (
    <SiteAdminFrame>
      {(viewer) => <PageEditorScreen viewer={viewer} pageId={pageId} />}
    </SiteAdminFrame>
  );
}

function SiteAdminFrame({
  children,
}: {
  children: (viewer: Viewer) => ReactNode;
}): ReactElement {
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
          {t("siteAdmin.errors.loadFailed")}
        </Notice>
      ) : viewer === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("siteAdmin.loading")}
        </p>
      ) : (
        children(viewer)
      )}
    </AppShell>
  );
}
