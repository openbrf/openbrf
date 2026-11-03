import type { IssueSignature } from "@openbrf/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { KnownFault } from "../api/issues";
import { localDayOfInstant } from "../bookings/booking-calendar";
import { HINT } from "../ui/controls";
import { ISSUE_SIGNATURE_LABEL } from "./issue-labels";

/**
 * One known fault (känt fel, decision 22): the handler's notice about a fault
 * the house already knows of, signed with a role and never a person
 * (decision 19), and the day it was published.
 *
 * The same card on the report form and on the post its issue was reported
 * from. It carries nothing of the report itself: that stays its reporter's and
 * its handlers'. Never rendered on the public website, which reads none.
 */
export function KnownFaultNotice({
  fault,
}: {
  fault: {
    body: string;
    signature: IssueSignature;
    publishedAt: string;
    typeName?: string;
  };
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 rounded-control border-l-4 border-info bg-info-soft px-3 py-2 text-ink">
      <p className="flex flex-wrap items-baseline gap-x-2 text-small">
        <span className="font-semibold">{t("issues.knownFault.label")}</span>
        {fault.typeName === undefined ? null : <span>{fault.typeName}</span>}
      </p>
      <p className="text-small whitespace-pre-line">{fault.body}</p>
      <p className={HINT}>
        {t(ISSUE_SIGNATURE_LABEL[fault.signature])}{" "}
        <span className="font-data text-data">
          {localDayOfInstant(fault.publishedAt)}
        </span>
      </p>
    </div>
  );
}

/**
 * The known faults on the report form: what the house already knows of, so a
 * resident about to report the same thing need not. Shown before the form,
 * because that is when it saves somebody the writing.
 */
export function KnownFaultsList({
  faults,
}: {
  faults: readonly KnownFault[];
}): ReactElement | null {
  const { t } = useTranslation();
  if (faults.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="known-faults-title"
      className="flex flex-col gap-2"
    >
      <h3
        id="known-faults-title"
        className="text-label text-ink-muted uppercase"
      >
        {t("issues.knownFault.listTitle")}
      </h3>
      <p className={HINT}>{t("issues.knownFault.listHint")}</p>
      <ul className="flex flex-col gap-2">
        {faults.map((fault) => (
          <li key={`${fault.publishedAt}-${fault.typeName}-${fault.body}`}>
            <KnownFaultNotice fault={fault} />
          </li>
        ))}
      </ul>
    </section>
  );
}
