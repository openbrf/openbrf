import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import {
  fetchPluginViews,
  type PluginViewDescriptor,
} from "../plugins/plugin-api";
import { loadPluginTranslations } from "../plugins/plugin-i18n";
import { PluginView } from "../plugins/PluginView";
import { usePluginTranslation } from "../plugins/use-plugin-translation";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { Notice } from "../ui/Notice";

/**
 * A plugin's own screen.
 *
 * Reachable by any signed-in account, because a plugin view can be meant for
 * residents. Which views exist is asked of the API rather than derived from
 * the plugin list: reading that list needs the ability to see how the instance
 * is configured, and a resident opening a plugin's page needs neither.
 */
export function PluginViewRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pluginId } = useParams({ from: "/plugin/$pluginId" });

  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [view, setView] = useState<PluginViewDescriptor | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;

    const load = async (): Promise<void> => {
      const [viewerResult, viewsResult] = await Promise.all([
        fetchViewer(),
        fetchPluginViews(),
      ]);
      if (!active) {
        return;
      }
      if (viewerResult.ok) {
        setViewer(viewerResult.value);
        applyAccentOverride(
          viewerResult.value.housingCooperative?.primaryColor ?? null,
        );
      }
      if (viewsResult.ok) {
        const found =
          viewsResult.value.views.find(
            (candidate) => candidate.id === pluginId,
          ) ?? null;
        setView(found);
        if (found !== null) {
          await loadPluginTranslations(found.id);
        }
      }
      setReady(true);
    };

    void load();
    return () => {
      active = false;
    };
  }, [pluginId]);

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
      {!ready ? (
        <p role="status" className="text-body text-ink-muted">
          {t("plugins.view.loading")}
        </p>
      ) : view === null ? (
        <Notice tone="warn" live>
          {t("plugins.view.notFound", { plugin: pluginId })}
        </Notice>
      ) : (
        <PluginScreen view={view} />
      )}
    </AppShell>
  );
}

/**
 * The plugin's heading and its view.
 *
 * The heading is the plugin's own string in its own namespace, which is why it
 * is here and not in the route above: the translator has to be bound to the
 * plugin before the title can be read.
 */
function PluginScreen({ view }: { view: PluginViewDescriptor }): ReactElement {
  const translatePlugin = usePluginTranslation(view.id);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{translatePlugin(view.titleKey)}</h1>
      </header>
      <PluginView view={view} />
    </div>
  );
}
