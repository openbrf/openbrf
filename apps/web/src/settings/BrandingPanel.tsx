import {
  deriveAccentFamily,
  normalizeColor,
  PORTTAVLAN_DARK,
  PORTTAVLAN_LIGHT,
  type AccentFamily,
} from "@openbrf/tokens";
import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { BrandingSettings, ContrastFailure } from "../api/instance";
import { saveBranding } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { ThemeModeToggle } from "../theme/ThemeModeToggle";
import {
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface BrandingPanelProps {
  value: BrandingSettings;
  onSaved?: (value: BrandingSettings) => void;
  submitLabel?: string;
  editable?: boolean;
}

const BRANDING_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "colour-unreadable": "settings.branding.errors.unreadable",
  "colour-fails-contrast": "settings.branding.errors.failsContrast",
};

/**
 * Appearance: one colour, and the light or dark mode.
 *
 * The preview is the honest part. The board picks one value and the platform
 * derives five from it, differently for each mode, so a swatch of what they
 * typed would show something the interface never renders. These swatches are
 * computed with the same function the API measures against, which is why the
 * derivation lives in the token package rather than in either side.
 *
 * The API still decides. A colour that fails the contrast matrix is refused
 * there and the refusal names the pair and the measured ratio, because the
 * register pairs are statutory: an association has to be able to read the
 * register the law requires it to keep.
 */
export function BrandingPanel({
  value,
  onSaved,
  submitLabel,
  editable = true,
}: BrandingPanelProps): ReactElement {
  const { t } = useTranslation();
  const [primaryColor, setPrimaryColor] = useState(value.primaryColor ?? "");

  const save = useSaveAction(saveBranding, onSaved);

  const normalized = normalizeColor(primaryColor.trim());
  const preview =
    normalized === null
      ? null
      : {
          light: derived(normalized, PORTTAVLAN_LIGHT),
          dark: derived(normalized, PORTTAVLAN_DARK),
        };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save.submit({
      primaryColor: primaryColor.trim() === "" ? null : primaryColor.trim(),
    });
  };

  const failures =
    save.state.kind === "failed"
      ? ((save.state.failure.detail ?? []) as ContrastFailure[])
      : [];

  return (
    <Panel
      title={t("settings.branding.title")}
      description={t("settings.branding.description")}
      notice={
        save.state.kind === "failed" ? (
          <Notice tone="danger" live>
            <span className="flex flex-col gap-1">
              <span>
                {t(
                  failureMessageKey(
                    save.state.failure,
                    BRANDING_FAILURES,
                    "settings.errors.unknown",
                  ),
                )}
              </span>
              {failures.slice(0, 3).map((finding) => (
                <span
                  key={`${finding.foreground}-${finding.background}`}
                  className="font-data text-data"
                >
                  {t("settings.branding.errors.pair", {
                    foreground: finding.foreground,
                    background: finding.background,
                    ratio:
                      finding.ratio === null ? "?" : finding.ratio.toFixed(2),
                    required: finding.required.toFixed(1),
                  })}
                  {finding.statutory
                    ? ` ${t("settings.branding.errors.statutoryPair")}`
                    : ""}
                </span>
              ))}
            </span>
          </Notice>
        ) : save.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("settings.saved")}
          </Notice>
        ) : null
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className={LABEL}>
          {t("settings.branding.primaryColor")}
          <input
            type="text"
            name="primaryColor"
            autoComplete="off"
            spellCheck={false}
            disabled={!editable}
            placeholder="#7D5F23"
            value={primaryColor}
            onChange={(event) => {
              setPrimaryColor(event.target.value);
            }}
            className={FIELD_DATA}
          />
          <span className={HINT}>
            {t("settings.branding.primaryColorHint")}
          </span>
        </label>

        {preview === null ? null : (
          <section className="flex flex-col gap-3">
            <h3 className="text-label text-ink-muted uppercase">
              {t("settings.branding.preview")}
            </h3>
            <p className={HINT}>{t("settings.branding.adjustedNotice")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <AccentPreview
                modeLabel={t("settings.branding.previewLight")}
                family={preview.light}
                tokens={PORTTAVLAN_LIGHT}
              />
              <AccentPreview
                modeLabel={t("settings.branding.previewDark")}
                family={preview.dark}
                tokens={PORTTAVLAN_DARK}
              />
            </div>
          </section>
        )}

        {editable ? (
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={save.state.kind === "saving"}
              className={PRIMARY_BUTTON}
            >
              {save.state.kind === "saving"
                ? t("settings.saving")
                : (submitLabel ?? t("settings.save"))}
            </button>

            <button
              type="button"
              disabled={save.state.kind === "saving"}
              onClick={() => {
                setPrimaryColor("");
                void save.submit({ primaryColor: null });
              }}
              className={SECONDARY_BUTTON}
            >
              {t("settings.branding.clear")}
            </button>
          </div>
        ) : null}
      </form>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-label text-ink-muted uppercase">
          {t("settings.branding.appearance")}
        </h3>
        <ThemeModeToggle />
      </div>
    </Panel>
  );
}

/** Null when the colour cannot be made legible in that mode. */
function derived(
  colour: string,
  tokens: typeof PORTTAVLAN_LIGHT,
): AccentFamily | null {
  const result = deriveAccentFamily(colour, tokens);
  return result.ok ? result.family : null;
}

/**
 * One mode's swatches, painted with literal derived values.
 *
 * The one place in the interface where inline colours are correct rather than a
 * defect: this preview exists to show what the values ARE, so reading them from
 * the running theme would show the current accent instead of the candidate.
 */
function AccentPreview({
  modeLabel,
  family,
  tokens,
}: {
  modeLabel: string;
  family: AccentFamily | null;
  tokens: typeof PORTTAVLAN_LIGHT;
}): ReactElement {
  const { t } = useTranslation();

  if (family === null) {
    return (
      <div className="rounded-control border border-line p-3">
        <span className="text-chip text-ink-muted uppercase">{modeLabel}</span>
        <p className="text-small text-danger">
          {t("settings.branding.errors.failsContrast")}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-control border border-line p-3"
      style={{ backgroundColor: tokens["surface-page"] }}
    >
      <span
        className="text-chip uppercase"
        style={{ color: tokens["text-secondary"] }}
      >
        {modeLabel}
      </span>

      <span
        className="text-body font-semibold underline"
        style={{ color: family["accent-trust"] }}
      >
        {t("settings.branding.previewRoom")}
      </span>

      <span
        className="rounded-control px-2 py-1 text-small font-semibold"
        style={{
          backgroundColor: family["accent-trust"],
          color: family["on-accent-trust"],
        }}
      >
        {t("legend.trust")}
      </span>

      <span
        className="flex flex-col gap-1 rounded-control p-2"
        style={{ backgroundColor: tokens["surface-register"] }}
      >
        <span
          className="font-data text-data"
          style={{ color: family["accent-trust-register"] }}
        >
          {t("settings.branding.previewRegister")}
        </span>
      </span>
    </div>
  );
}
