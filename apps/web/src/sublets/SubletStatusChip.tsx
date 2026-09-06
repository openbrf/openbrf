import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { SubletApplicationStatus } from "../api/sublets";
import type { TranslationKey } from "../i18n/translation-key";

const LABEL: Readonly<Record<SubletApplicationStatus, TranslationKey>> = {
  SUBMITTED: "sublets.status.SUBMITTED",
  CONSENTED: "sublets.status.CONSENTED",
  REFUSED: "sublets.status.REFUSED",
  WITHDRAWN: "sublets.status.WITHDRAWN",
};

/**
 * Where an application stands, as a sign.
 *
 * Colour is never the only signal: each state carries its own word as well as
 * its own border weight, so a reader who cannot tell the tones apart still reads
 * which state this is.
 *
 * A submitted application is the one that wants attention, which is why it takes
 * the warn tone rather than the neutral one: it is a request with the board that
 * nobody has answered, and somebody is waiting on it to arrange a letting.
 *
 * A refusal takes the danger tone and a withdrawal the quiet one, because they
 * are not the same kind of ending. The board said no to the first, which is the
 * state BRL 7 kap. 11 § lets the member take to the rent tribunal; the member
 * simply stopped asking in the second.
 */
const TONE: Readonly<Record<SubletApplicationStatus, string>> = {
  SUBMITTED: "border-warn bg-warn-soft",
  CONSENTED: "border-ok bg-ok-soft",
  REFUSED: "border-danger bg-danger-soft",
  WITHDRAWN: "border-line bg-sunken",
};

export function SubletStatusChip({
  status,
}: {
  status: SubletApplicationStatus;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <span
      className={`inline-flex items-center rounded-control border-l-4 px-2 py-1 text-chip text-ink uppercase ${TONE[status]}`}
    >
      {t(LABEL[status])}
    </span>
  );
}
