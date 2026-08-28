import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { useOptionalThemeRuntime } from "../theme/theme-runtime-context";
import { SECONDARY_BUTTON } from "../ui/controls";
import { Panel } from "../ui/Panel";

/**
 * The way into the theme screen, from settings.
 *
 * Themes are not in the main navigation on purpose: the navigation is the same
 * for everybody, and installing a theme is an administrator's job. It sits in
 * settings, where the rest of the instance's configuration already lives, and
 * the screen it links to checks the capability again.
 */
export function ThemesPanel(): ReactElement {
  const { t } = useTranslation();
  const runtime = useOptionalThemeRuntime();
  const applied = runtime?.previewing ?? runtime?.active ?? null;

  return (
    <Panel
      title={t("themeCatalog.panel.title")}
      description={t("themeCatalog.panel.description")}
    >
      {applied === null ? null : (
        <p className="text-body">
          {t("themeCatalog.panel.active", { theme: applied.name })}
        </p>
      )}

      {runtime?.previewing == null ? null : (
        <p className="text-small text-warn">
          {t("themeCatalog.panel.previewing")}
        </p>
      )}

      <div>
        <Link to="/admin/themes" className={SECONDARY_BUTTON}>
          {t("themeCatalog.panel.open")}
        </Link>
      </div>
    </Panel>
  );
}
