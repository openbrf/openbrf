import type { ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import { DATA_TAGS, literal } from "../ui/data-tags";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";

export interface SupportBannerProps {
  supporter: string;
  /** When the session stops working, as an ISO instant. */
  endsAt: string;
}

/**
 * What every screen says while a support session is looking at it (ADR 0028):
 * who the supporter is, that nothing can be changed, and when it ends.
 *
 * A standing notice rather than a live one: it is there from the first render
 * of every screen, and announcing it on each would bury what the screen says.
 */
export function SupportBanner({
  supporter,
  endsAt,
}: SupportBannerProps): ReactElement {
  const { t, i18n } = useTranslation();
  return (
    <div className="mb-5">
      <Notice tone="info">
        <Trans
          t={t}
          i18nKey="support.banner"
          values={{ endsAt: formatMoment(endsAt, i18n.language) }}
          components={{ ...DATA_TAGS, supporter: literal(supporter) }}
        />
      </Notice>
    </div>
  );
}
