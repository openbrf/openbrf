import {
  Component as ReactComponent,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Notice } from "../ui/Notice";
import type { PluginViewDescriptor } from "./plugin-api";
import { loadPluginTranslations } from "./plugin-i18n";
import { loadPluginView } from "./plugin-remotes";

export interface PluginViewProps {
  view: PluginViewDescriptor;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; Component: ComponentType }
  | { kind: "failed" };

/**
 * Catches what a plugin's component throws while rendering.
 *
 * A class because React offers no other way to catch a render error. Without
 * it the error would reach the router, which replaces the whole route - the
 * frame and the navigation included - with its own error screen.
 */
class PluginViewBoundary extends ReactComponent<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Renders one plugin's view.
 *
 * The component is fetched over the network from the plugin's own bundle on
 * the data volume, so it can be absent, stale or broken in ways a bundled
 * component cannot. A failure shows a notice and nothing else: the same rule
 * the server-side loader follows, that a broken plugin must not be able to
 * take the screen it is only a part of offline.
 *
 * The plugin's translations are loaded before its component, so its labels are
 * words on first paint rather than keys that flick into words a moment later.
 */
export function PluginView({ view }: PluginViewProps): ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let active = true;

    const load = async (): Promise<void> => {
      await loadPluginTranslations(view.id);
      const Component = await loadPluginView(view);
      if (!active) {
        return;
      }
      setState(
        Component === null ? { kind: "failed" } : { kind: "ready", Component },
      );
    };

    void load();
    return () => {
      active = false;
    };
  }, [view]);

  const failed = (
    <Notice tone="danger" live>
      {t("plugins.view.loadFailed", { plugin: view.id })}
    </Notice>
  );

  if (state.kind === "failed") {
    return failed;
  }

  if (state.kind === "loading") {
    return (
      <p role="status" className="text-body text-ink-muted">
        {t("plugins.view.loading")}
      </p>
    );
  }

  const { Component } = state;

  // Keyed by the view, so moving to another plugin starts without the error.
  return (
    <PluginViewBoundary key={view.id} fallback={failed}>
      <Suspense
        fallback={
          <p role="status" className="text-body text-ink-muted">
            {t("plugins.view.loading")}
          </p>
        }
      >
        <Component />
      </Suspense>
    </PluginViewBoundary>
  );
}
