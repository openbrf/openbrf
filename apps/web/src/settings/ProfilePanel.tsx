import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { exportOwnData, saveOwnProfile } from "../api/instance";
import { ThemeModeToggle } from "../theme/ThemeModeToggle";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface ProfilePanelProps {
  viewer: Viewer;
}

/**
 * The signed-in person's own settings.
 *
 * The one settings panel every account reaches, including a resident's. The
 * locale is not cosmetic: it decides the language of every email this instance
 * sends that person and of the register extracts produced for them, which is
 * why the label says so instead of calling it "language".
 */
export function ProfilePanel({ viewer }: ProfilePanelProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [preferredLocale, setPreferredLocale] = useState(
    viewer.preferredLocale,
  );

  // Applied here rather than left to the next page load. The stored locale
  // decides the language of every email and register extract this instance
  // produces for this person, so a screen that keeps speaking the old language
  // after saving reads as if the change had not taken.
  const save = useSaveAction(saveOwnProfile, (saved) => {
    void i18n.changeLanguage(saved.preferredLocale);
  });

  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * Writes the person's own data to a file their browser saves.
   *
   * Built in the browser from what the route answers rather than streamed as a
   * download, because the request is a POST: it writes an audit entry, and a
   * link the browser followed could not carry the session the guard needs.
   */
  const download = async (): Promise<void> => {
    setDownloading(true);
    setFailed(false);

    const result = await exportOwnData();
    if (!result.ok) {
      setFailed(true);
      setDownloading(false);
      return;
    }

    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result.value, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `mina-uppgifter-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setDownloading(false);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save.submit({ preferredLocale });
  };

  return (
    <Panel
      title={t("settings.profile.title")}
      description={t("settings.profile.description")}
      notice={
        save.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                save.state.failure,
                {},
                "settings.errors.unknown",
              ),
            )}
          </Notice>
        ) : save.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("settings.saved")}
          </Notice>
        ) : null
      }
    >
      <div className="flex flex-col gap-1">
        <span className="text-label text-ink-muted uppercase">
          {t("settings.profile.name")}
        </span>
        <span className="text-body">
          {`${viewer.firstName} ${viewer.lastName}`}
        </span>
      </div>

      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className={LABEL}>
          {t("settings.profile.preferredLocale")}
          <select
            name="preferredLocale"
            value={preferredLocale}
            onChange={(event) => {
              setPreferredLocale(event.target.value);
            }}
            className={FIELD}
          >
            <option value="sv">
              {t("settings.housingCooperative.locale.sv")}
            </option>
            <option value="en">
              {t("settings.housingCooperative.locale.en")}
            </option>
          </select>
        </label>

        <div>
          <button
            type="submit"
            disabled={save.state.kind === "saving"}
            className={PRIMARY_BUTTON}
          >
            {save.state.kind === "saving"
              ? t("settings.saving")
              : t("settings.save")}
          </button>
        </div>
      </form>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-label text-ink-muted uppercase">
          {t("settings.profile.appearance")}
        </h3>
        <ThemeModeToggle />
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-label text-ink-muted uppercase">
          {t("settings.profile.portability.heading")}
        </h3>
        <p className={HINT}>{t("settings.profile.portability.description")}</p>
        <div>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={downloading}
            onClick={() => {
              void download();
            }}
          >
            {downloading
              ? t("settings.profile.portability.working")
              : t("settings.profile.portability.action")}
          </button>
        </div>
        {failed ? (
          <Notice tone="danger" live>
            {t("settings.profile.portability.failed")}
          </Notice>
        ) : null}
      </div>
    </Panel>
  );
}
