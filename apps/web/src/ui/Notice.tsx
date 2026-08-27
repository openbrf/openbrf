import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import type { TranslationKey } from "../i18n/translation-key";

/** What a notice means. Each tone carries exactly one meaning, everywhere. */
export type NoticeTone = "ok" | "warn" | "danger" | "info";

export interface NoticeProps {
  tone: NoticeTone;
  children: ReactNode;
  /**
   * Whether a screen reader should be told as it changes. Use for the outcome
   * of an action; leave off for a standing notice that was there on load.
   */
  live?: boolean;
}

/**
 * Colour, and never only colour.
 *
 * Every tone here carries three signals at once: the colour, a written word
 * naming the state, and a left rule whose weight differs from the panel's own
 * border. A board member who cannot distinguish the green from the red reads
 * the word instead, which is the rule DESIGN.md states and the reason the label
 * is not optional.
 */
const TONE: Readonly<
  Record<NoticeTone, { classes: string; labelKey: TranslationKey }>
> = {
  ok: {
    classes: "border-l-4 border-ok bg-ok-soft text-ink",
    labelKey: "legend.ok",
  },
  warn: {
    classes: "border-l-4 border-warn bg-warn-soft text-ink",
    labelKey: "legend.warn",
  },
  danger: {
    classes: "border-l-4 border-danger bg-danger-soft text-ink",
    labelKey: "legend.danger",
  },
  info: {
    classes: "border-l-4 border-info bg-info-soft text-ink",
    labelKey: "legend.info",
  },
};

export function Notice({ tone, children, live }: NoticeProps): ReactElement {
  const { t } = useTranslation();
  const { classes, labelKey } = TONE[tone];

  return (
    <div
      role={live === true ? "status" : undefined}
      aria-live={live === true ? "polite" : undefined}
      className={`flex flex-col gap-1 rounded-control px-3 py-2.5 ${classes}`}
    >
      <span className="text-chip uppercase">{t(labelKey)}</span>
      <span className="text-small">{children}</span>
    </div>
  );
}
