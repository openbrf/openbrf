import { useCallback, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { BrandingSettings, LogoSlot, LogoView } from "../api/instance";
import { removeLogo, uploadLogo } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { HINT, QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

/**
 * What the file picker offers.
 *
 * A courtesy, not a control: the API identifies a file from its own bytes and
 * refuses anything else, because an accept attribute is a hint to a dialog and
 * a request can be made without one.
 */
const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp,image/gif";

const UPLOAD_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "unsupported-type": "media.upload.errors.unsupportedType",
  "too-large": "media.upload.errors.tooLarge",
  "empty-file": "media.upload.errors.empty",
  "no-file": "media.upload.errors.noFile",
};

export interface LogoFieldProps {
  slot: LogoSlot;
  /** The slot's name, used in the heading and in the control's own label. */
  label: string;
  hint: string;
  value: LogoView | null;
  /**
   * What the dark band falls back to when this slot is empty: the light mark,
   * which the preview then shows on a plate exactly as the band will.
   */
  fallback?: LogoView | null;
  editable?: boolean;
  onChanged: (branding: BrandingSettings) => void;
}

/**
 * One logo slot: what is stored, what it will look like where it is used, and
 * the two actions that change it.
 *
 * The preview is rendered on the surface the mark will actually appear on
 * rather than on the settings page's own background. That is the point of the
 * dark slot existing at all: a mark drawn in dark ink is invisible on the top
 * band, and a board that only ever saw it on white would have no way to know.
 */
export function LogoField({
  slot,
  label,
  hint,
  value,
  fallback = null,
  editable = true,
  onChanged,
}: LogoFieldProps): ReactElement {
  const { t } = useTranslation();

  const run = useCallback(
    (file: File | null) =>
      file === null ? removeLogo(slot) : uploadLogo(slot, file),
    [slot],
  );
  const save = useSaveAction(run, onChanged);

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file twice still fires a change event, which
    // is what happens after a failed upload the board wants to retry.
    event.target.value = "";
    if (file !== undefined) {
      void save.submit(file);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">{label}</h3>

      <div className="flex flex-col gap-3 rounded-control border border-line p-3 sm:flex-row sm:items-center">
        <LogoPreview slot={slot} value={value} fallback={fallback} />

        <div className="flex min-w-0 flex-col gap-2">
          {value === null ? (
            <p className={HINT}>{t("settings.branding.logo.none")}</p>
          ) : (
            <p className="flex min-w-0 flex-col">
              <span className="truncate text-small text-ink">
                {value.fileName}
              </span>
              {value.width === null || value.height === null ? null : (
                <span className="font-data text-chip text-ink-muted">
                  {t("media.upload.dimensions", {
                    width: value.width,
                    height: value.height,
                  })}
                </span>
              )}
            </p>
          )}

          {editable ? (
            <div className="flex flex-wrap gap-2">
              <label
                className={`${SECONDARY_BUTTON} cursor-pointer ${
                  save.state.kind === "saving" ? "opacity-60" : ""
                }`}
              >
                {save.state.kind === "saving"
                  ? t("media.upload.uploading")
                  : value === null
                    ? t("media.upload.choose")
                    : t("media.upload.replace")}
                <input
                  type="file"
                  accept={ACCEPTED_TYPES}
                  disabled={save.state.kind === "saving"}
                  // Named per slot, so the two pickers on this screen are told
                  // apart by anyone reading the page rather than looking at it.
                  aria-label={t("settings.branding.logo.chooseFor", {
                    slot: label,
                  })}
                  className="sr-only"
                  onChange={onPick}
                />
              </label>

              {value === null ? null : (
                <button
                  type="button"
                  disabled={save.state.kind === "saving"}
                  aria-label={t("settings.branding.logo.removeFor", {
                    slot: label,
                  })}
                  onClick={() => {
                    void save.submit(null);
                  }}
                  className={QUIET_BUTTON}
                >
                  {t("media.upload.remove")}
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <p className={HINT}>{hint}</p>

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              save.state.failure,
              UPLOAD_FAILURES,
              "media.upload.errors.unknown",
            ),
          )}
        </Notice>
      ) : null}
    </section>
  );
}

/**
 * The mark on the surface it will be used on.
 *
 * The dark slot's frame is the band's own surface, so what the board sees here
 * is what the band renders. When that slot is empty and a light mark exists,
 * this shows the light mark on the same plate the band falls back to, which
 * makes the fallback a visible choice rather than a surprise.
 */
function LogoPreview({
  slot,
  value,
  fallback,
}: {
  slot: LogoSlot;
  value: LogoView | null;
  fallback: LogoView | null;
}): ReactElement {
  const { t } = useTranslation();
  const shown = value ?? (slot === "dark" ? fallback : null);
  const onPlate = value === null && shown !== null;

  const frame =
    slot === "dark"
      ? "border-register-line bg-register"
      : "border-line bg-page";

  return (
    <div
      className={`flex w-full shrink-0 flex-col gap-2 rounded-control border p-3 sm:w-56 ${frame}`}
    >
      <span
        className={`text-chip uppercase ${
          slot === "dark" ? "text-register-ink-muted" : "text-ink-muted"
        }`}
      >
        {t(
          slot === "dark"
            ? "settings.branding.logo.onDarkBand"
            : "settings.branding.logo.onLight",
        )}
      </span>

      {shown === null ? (
        <span className="h-12" />
      ) : (
        <span
          className={
            onPlate
              ? "inline-flex w-fit items-center rounded-control bg-raised px-2 py-1"
              : "inline-flex w-fit items-center"
          }
        >
          {/*
           * Empty alt on purpose: the housing cooperative's name is already
           * on the screen as text, and repeating it here would have a screen
           * reader announce the same thing twice.
           */}
          <img src={shown.url} alt="" className="max-h-12 w-auto max-w-full" />
        </span>
      )}
    </div>
  );
}
