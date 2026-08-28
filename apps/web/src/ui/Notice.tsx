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
 * Every tone carries three signals at once: the colour, a written word naming
 * the state, and a left rule whose weight differs from the panel's own border. A
 * board member who cannot distinguish the green from the red reads the word
 * instead, which is the rule DESIGN.md states and the reason the label is not
 * optional.
 *
 * The words are the message's own rather than the register legend's. The legend
 * names what a colour means in the register - warn there is "protected person or
 * caution" - and putting that on an unconfigured SMTP server would read as if
 * somebody's protected personal data were involved. The colour keeps its
 * meaning; the word says what this particular message is.
 */
const TONE: Readonly<
  Record<NoticeTone, { classes: string; labelKey: TranslationKey }>
> = {
  ok: {
    classes: "border-l-4 border-ok bg-ok-soft text-ink",
    labelKey: "settings.notice.ok",
  },
  warn: {
    classes: "border-l-4 border-warn bg-warn-soft text-ink",
    labelKey: "settings.notice.warn",
  },
  danger: {
    classes: "border-l-4 border-danger bg-danger-soft text-ink",
    labelKey: "settings.notice.danger",
  },
  info: {
    classes: "border-l-4 border-info bg-info-soft text-ink",
    labelKey: "settings.notice.info",
  },
};

/**
 * How a live notice announces itself.
 *
 * A notice is mounted together with its message, and a screen reader announces
 * changes to a live region it has already registered - a `role="status"` region
 * inserted with its content can therefore stay silent. `role="alert"` is the
 * documented exception: assistive technology announces alert content on
 * insertion, which is why it is the standard role for an error that appears in
 * response to an action. So a live danger notice is an alert, and the outcomes
 * that are not failures stay polite: a confirmation has no business
 * interrupting whatever the reader is in the middle of.
 */
function liveAttributes(
  tone: NoticeTone,
  live: boolean | undefined,
): { role?: "alert" | "status"; "aria-live"?: "assertive" | "polite" } {
  if (live !== true) {
    return {};
  }
  return tone === "danger"
    ? { role: "alert", "aria-live": "assertive" }
    : { role: "status", "aria-live": "polite" };
}

export function Notice({ tone, children, live }: NoticeProps): ReactElement {
  const { t } = useTranslation();
  const { classes, labelKey } = TONE[tone];

  return (
    <div
      {...liveAttributes(tone, live)}
      className={`flex flex-col gap-1 rounded-control px-3 py-2.5 ${classes}`}
    >
      <span className="text-chip uppercase">{t(labelKey)}</span>
      <span className="text-small">{children}</span>
    </div>
  );
}
