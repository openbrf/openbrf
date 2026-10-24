import { Navigate } from "@tanstack/react-router";
import { Fragment, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { useSession } from "../auth/auth-client";
import { isReadOnly } from "../support/read-only";
import { ProfilePanel } from "./ProfilePanel";
import { SecurityPanel } from "./SecurityPanel";
import {
  panelsIn,
  settingsAccessOf,
  type SettingsPanelId,
} from "./settings-sections";
import { useFocusAcrossReload } from "./use-focus-across-reload";

export interface AccountSettingsScreenProps {
  viewer: Viewer;
}

/**
 * The person's own settings: their profile and how they sign in, and nothing
 * about the association.
 *
 * Every account has these, whatever else it may do, so this is the whole of
 * /settings for everybody. How the association is run is the board's page
 * /board/settings (ADR 0049), and a board member reaches it from the board's
 * section rather than from here: one page, one audience.
 *
 * Each panel reads and saves for itself, so this screen asks the API for
 * nothing. A support session (ADR 0028) has no account of its own to show, and
 * is sent on to the association's settings, which are what it came to read.
 */
export function AccountSettingsScreen({
  viewer,
}: AccountSettingsScreenProps): ReactElement {
  const { t } = useTranslation();
  const { data: session } = useSession();

  /*
   * The language saved on the profile panel. The viewer is loaded once above
   * this screen and is not reloaded by a save, so without this the panel is
   * built again from the language the viewer had when the page opened.
   */
  const [savedLocale, setSavedLocale] = useState<string | null>(null);
  const currentViewer =
    savedLocale === null ? viewer : { ...viewer, preferredLocale: savedLocale };

  // A save that switches the language renames every label, the save button's
  // too, and would take the focus of whoever sent it with Enter along.
  const [profileSaves, setProfileSaves] = useState(0);
  const { rootRef, remember } = useFocusAcrossReload(profileSaves);

  const panels = panelsIn(
    "account",
    settingsAccessOf(viewer.capabilities, isReadOnly(viewer)),
  );
  if (panels.length === 0) {
    return <Navigate to="/board/settings" replace />;
  }

  const renderPanel = (id: SettingsPanelId): ReactNode => {
    switch (id) {
      case "profile":
        return (
          <ProfilePanel
            viewer={currentViewer}
            onSaved={(saved) => {
              // The save button is disabled until this answer, and has lost
              // focus by now. The count makes a save that stores the language
              // the viewer already has restore it too.
              remember();
              setSavedLocale(saved.preferredLocale);
              setProfileSaves((count) => count + 1);
            }}
          />
        );
      case "security":
        return (
          <SecurityPanel
            twoFactorEnabled={session?.user.twoFactorEnabled === true}
          />
        );
    }
    return null;
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("settings.title")}</h1>
        <p className="text-body text-ink-muted">{t("settings.intro")}</p>
      </header>

      <div ref={rootRef} className="contents">
        {panels.map((panel) => (
          <Fragment key={panel.id}>{renderPanel(panel.id)}</Fragment>
        ))}
      </div>
    </div>
  );
}
