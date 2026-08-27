import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { THEME_MODES, type ThemeMode } from "./theme-mode";
import { useThemeMode } from "./theme-mode-context";

/**
 * Appearance control: system, light or dark.
 *
 * Built on native radio inputs rather than styled buttons. A group of
 * `role="radio"` buttons looks equivalent but is not: ARIA then obliges us to
 * implement arrow-key selection, Home and End, and a roving tabindex so the
 * group is one tab stop rather than three. The browser already does all of that
 * for named radio inputs, and does it consistently with whatever assistive
 * technology the reader uses. The input is visually hidden and the adjacent
 * span carries the styling, which keeps the platform behaviour and the design.
 *
 * A radio group rather than a two-state switch, because "follow the system" is
 * a distinct choice from either fixed mode, and the default. A toggle would
 * make it unreachable once the viewer touched it.
 */
export function ThemeModeToggle(): ReactElement {
  const { t } = useTranslation();
  const { mode, setMode } = useThemeMode();

  return (
    <fieldset className="rounded-panel border border-line-strong p-3">
      <legend className="px-1 text-label text-ink-muted uppercase">
        {t("theme.mode.label")}
      </legend>
      <div className="flex gap-1">
        {THEME_MODES.map((candidate: ThemeMode) => (
          <label key={candidate} className="cursor-pointer">
            <input
              type="radio"
              // The shared name is what makes the browser treat these as one
              // group, and is where the keyboard behaviour comes from.
              name="theme-mode"
              value={candidate}
              checked={candidate === mode}
              onChange={() => {
                setMode(candidate);
              }}
              className="peer sr-only"
            />
            <span
              className={[
                "flex min-h-11 items-center rounded-control px-3",
                "text-small font-semibold transition-colors duration-150 ease-out",
                "border border-line-strong bg-raised text-ink",
                "peer-checked:border-trust peer-checked:bg-trust peer-checked:text-on-trust",
                // The input is visually hidden, so the focus ring has to be
                // drawn on the part the viewer can actually see.
                "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
                "peer-focus-visible:outline-trust",
              ].join(" ")}
            >
              {t(`theme.mode.${candidate}`)}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
