import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

/**
 * The colour-as-law legend.
 *
 * Register views are required to show this, because each semantic colour
 * encodes exactly one rule and a reader has to be able to look it up. Note that
 * every entry pairs the swatch with a written label: colour is never the only
 * signal, so this legend stays meaningful for a viewer who cannot distinguish
 * the hues.
 */
const ENTRIES = [
  { key: "trust", swatch: "bg-trust-register" },
  { key: "ok", swatch: "bg-ok" },
  { key: "warn", swatch: "bg-warn-register" },
  { key: "danger", swatch: "bg-danger" },
  { key: "info", swatch: "bg-info" },
] as const;

export function ColourLegend(): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-label uppercase">
      <span className="font-bold text-register-ink-muted">
        {t("legend.title")}
      </span>
      {ENTRIES.map((entry) => (
        <span key={entry.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block size-2 rounded-full ${entry.swatch}`}
          />
          <span className="text-register-ink-muted">
            {t(`legend.${entry.key}`)}
          </span>
        </span>
      ))}
    </div>
  );
}
