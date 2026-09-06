import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ProcessingRecord } from "../api/data-protection";
import { HINT } from "../ui/controls";
import { Panel } from "../ui/Panel";

export interface ProcessingActivitiesPanelProps {
  record: ProcessingRecord;
}

/**
 * The record of processing activities (registerforteckning), GDPR art. 30.
 *
 * The controller block is at the head because art. 30(1)(a) puts it there: a
 * record that lists processings without saying whose they are is not the
 * document the article describes.
 *
 * A seeded row the board has not edited says so. That matters because such a
 * row still follows the instance's settings - change the storage driver and the
 * recipients change with it - and a board that has edited one has taken it over
 * and will not see that happen again.
 */
export function ProcessingActivitiesPanel({
  record,
}: ProcessingActivitiesPanelProps): ReactElement {
  const { t } = useTranslation();

  return (
    <Panel
      title={t("dataProtection.processing.title")}
      description={t("dataProtection.processing.description")}
    >
      <dl className="flex flex-col gap-1 border-b border-line pb-3">
        <div className="flex gap-2">
          <dt className={LABEL_INLINE}>
            {t("dataProtection.processing.controller.name")}
          </dt>
          <dd className="text-small">
            {record.controller.name}
            {record.controller.organizationNumber === null
              ? ""
              : ` (${record.controller.organizationNumber})`}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className={LABEL_INLINE}>
            {t("dataProtection.processing.controller.contact")}
          </dt>
          <dd className="text-small">
            {[record.controller.postalAddress, record.controller.contactEmail]
              .filter((part): part is string => part !== null)
              .join(", ") ||
              t("dataProtection.processing.controller.noContact")}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className={LABEL_INLINE}>
            {t("dataProtection.processing.controller.officer")}
          </dt>
          <dd className="text-small">
            {record.controller.officer === null
              ? t("dataProtection.processing.controller.noOfficer")
              : [
                  record.controller.officer.name,
                  record.controller.officer.email,
                ]
                  .filter((part): part is string => part !== null)
                  .join(", ")}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className={LABEL_INLINE}>
            {t("dataProtection.processing.controller.jointController")}
          </dt>
          <dd className="text-small">
            {record.controller.jointController === null
              ? t("dataProtection.processing.controller.jointControllerNone")
              : `${record.controller.jointController.name}, ${record.controller.jointController.contact}`}
          </dd>
        </div>
      </dl>

      <ul className="flex flex-col gap-3">
        {record.activities.map((activity) => (
          <li
            key={activity.activityId}
            className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-body font-semibold">{activity.name}</span>
              <span className={HINT}>
                {t(
                  `dataProtection.processing.legalBasis.${activity.legalBasis}`,
                )}
              </span>
              {activity.endedAt === null ? null : (
                <span className="text-small font-semibold">
                  {t("dataProtection.processing.ended")}
                </span>
              )}
            </div>
            <p className={HINT}>{activity.purpose}</p>
            {/*
             * The two the article names, in the record the article asks for.
             * art. 30(1)(c) has the record state the categories of data
             * subjects and the categories of personal data, so a screen that
             * shows the purpose and the legal basis without them shows a record
             * the board cannot check against the article.
             */}
            <p className={HINT}>
              {t("dataProtection.processing.dataSubjectsPrefix")}{" "}
              {activity.dataSubjectCategories
                .map((category) =>
                  t(`dataProtection.categories.dataSubject.${category}`),
                )
                .join(", ")}
            </p>
            <p className={HINT}>
              {t("dataProtection.processing.personalDataPrefix")}{" "}
              {activity.personalDataCategories
                .map((category) =>
                  t(`dataProtection.categories.personalData.${category}`),
                )
                .join(", ")}
            </p>
            <p className={HINT}>
              {t("dataProtection.processing.retentionPrefix")}{" "}
              {activity.retention}
            </p>
            {activity.recipients === null ? null : (
              <p className={HINT}>
                {t("dataProtection.processing.recipientsPrefix")}{" "}
                {activity.recipients}
              </p>
            )}
            {activity.thirdCountryTransfer ? (
              <p className={HINT}>
                {t("dataProtection.processing.thirdCountry")}
              </p>
            ) : null}
            {activity.seeded ? (
              <p className={HINT}>{t("dataProtection.processing.seeded")}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** A label beside its value rather than above it, in a definition list. */
const LABEL_INLINE = "text-small text-ink-muted min-w-40";
