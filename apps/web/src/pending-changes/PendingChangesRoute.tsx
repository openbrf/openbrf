import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { PendingChangesScreen } from "./PendingChangesScreen";

/**
 * The person's pending changes, inside the application frame.
 *
 * Served at /pending-changes and at /pending-changes/$id, the address a
 * plugin's view links to after proposing (`host.actions.propose` answers with
 * it). The viewer is loaded only for the band and the navigation; the list is
 * the screen's own read, and the API decides what is in it.
 *
 * No entry in the navigation. Nothing proposes a change until a plugin does,
 * and a link to a screen that is always empty is a defect by the navigation's
 * own rule; the plugin that proposes links here, and the module that makes
 * proposals common is the one that decides where the entry belongs.
 */
export function PendingChangesRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params: { id?: string } = useParams({ strict: false });
  const [viewer, setViewer] = useState<Viewer | null>(null);

  useEffect(() => {
    // An answer after the screen is gone is dropped, for the accent override's
    // sake: see ConnectedAppsRoute.
    let active = true;
    void fetchViewer().then((result) => {
      if (!active || !result.ok) {
        return;
      }
      setViewer(result.value);
      applyAccentOverride(
        result.value.housingCooperative?.primaryColor ?? null,
      );
    });
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
      <PendingChangesScreen focusId={params.id} />
    </AppShell>
  );
}
