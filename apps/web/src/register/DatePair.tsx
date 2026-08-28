import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";

/**
 * A pair of register dates, each behind its own label.
 *
 * Never two bare values joined by a space. When only the later date exists the
 * output is a single date indistinguishable from the earlier one, so a reader
 * cannot tell a move-in from a move-out - and a move-out date is what the purge
 * date is computed from, which puts the ambiguity on retention rather than on
 * presentation. Both values stay in the register face so their digits line up
 * with the rows they came from.
 */
export function DatePair({
  from,
  to,
  fromLabelKey,
  toLabelKey,
}: {
  from: string | null;
  to: string | null;
  fromLabelKey: TranslationKey;
  toLabelKey: TranslationKey;
}): ReactElement | null {
  if (from === null && to === null) {
    return null;
  }

  return (
    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <LabelledDate labelKey={fromLabelKey} value={from} />
      <LabelledDate labelKey={toLabelKey} value={to} />
    </span>
  );
}

function LabelledDate({
  labelKey,
  value,
}: {
  labelKey: TranslationKey;
  value: string | null;
}): ReactElement | null {
  const { t } = useTranslation();

  if (value === null) {
    return null;
  }

  return (
    <span className="flex items-baseline gap-1">
      <span className="text-label text-ink-muted uppercase">{t(labelKey)}</span>
      <span className="font-data text-data text-ink">{value}</span>
    </span>
  );
}
