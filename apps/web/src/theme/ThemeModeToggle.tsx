import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { THEME_MODES, type ThemeMode } from "./theme-mode";
import { useThemeMode } from "./theme-mode-context";

/**
 * Appearance control: system, light or dark.
 *
 * A radio group rather than a two-state switch, because "follow the system" is
 * a distinct choice from either fixed mode and the default. A toggle would make
 * it unreachable once the viewer touched it.
 */
export function ThemeModeToggle(): ReactElement {
  const { t } = useTranslation();
  const { mode, setMode } = useThemeMode();

  return (
    <fieldset className="rounded-panel border border-line-strong p-3">
      <legend className="px-1 text-[13px] font-semibold tracking-[0.12em] text-ink-muted uppercase">
        {t("theme.mode.label")}
      </legend>
      <div className="flex gap-1" role="radiogroup">
        {THEME_MODES.map((candidate: ThemeMode) => {
          const selected = candidate === mode;
          return (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setMode(candidate);
              }}
              className={[
                "min-h-11 rounded-control px-3 text-sm font-semibold",
                "transition-colors duration-150 ease-out",
                selected
                  ? "bg-trust text-on-trust"
                  : "border border-line-strong bg-raised text-ink",
              ].join(" ")}
            >
              {t(`theme.mode.${candidate}`)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
