import { ACTIVITY_FIELDS, type ActivityField } from "@openbrf/shared";
import type { TFunction } from "i18next";
import { useId, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  adoptProductText,
  type ProcessingActivityView,
} from "../api/data-protection";
import { HINT, LABEL, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface ProductTextDifferenceProps {
  activity: ProcessingActivityView;
  /** Called after an adoption, and after one refused because the row moved. */
  onAdopted: () => void;
}

/**
 * Where the product's statement for a row the board has edited now says
 * something else, field by field, with the board's text beside the product's.
 *
 * The seed never overwrites a row the board has edited, because the board is
 * answerable for its own wording (GDPR art. 5(2)). That also means a correction
 * to the product's wording never reaches the row, and the board would not know
 * there was one. So the screen says so, and adopting the product's text is the
 * board's own act, one field at a time. The row stays the board's afterwards:
 * the next time the product's wording moves on, this shows again. Where the
 * server could not compare the row this read, it says that instead of nothing.
 *
 * One adoption at a time per row: the buttons are disabled while one is in
 * flight, because each is sent with the revision this read saw and the second
 * would be refused as built on a replaced copy. For the same reason they stay
 * disabled after an adoption that wrote, until the screen's read brings the
 * row at the revision that adoption left it at.
 */
export function ProductTextDifference({
  activity,
  onAdopted,
}: ProductTextDifferenceProps): ReactElement | null {
  const { t } = useTranslation();
  const id = useId();
  // Which field's button was pressed, so only that one says it is saving.
  const [adopting, setAdopting] = useState<ActivityField | null>(null);
  /*
   * The revision the last adoption left the row at. Until the screen's read
   * has brought that row, `activity.revision` is the one the adoption replaced,
   * and a second adoption sent with it would be refused. An adoption with
   * nothing left to write leaves the revision where it was, so it holds
   * nothing back.
   */
  const [adoptedRevision, setAdoptedRevision] = useState<number | null>(null);
  const adopt = useSaveAction(
    adoptProductText,
    (adopted) => {
      setAdoptedRevision(adopted.revision);
      onAdopted();
    },
    (failure) => {
      // The row moved under the screen: read it again, so what is shown is
      // what the refusal was about.
      if (
        failure.reason === "activity-changed" ||
        failure.reason === "no-product-text"
      ) {
        onAdopted();
      }
    },
  );
  const awaitingRead =
    adoptedRevision !== null && activity.revision < adoptedRevision;

  /*
   * The server could not compare the row with the product's statement just
   * now. Saying nothing would read as "the texts agree", which is exactly what
   * is not known, so the row says that instead.
   */
  if (activity.productTextUnavailable) {
    return (
      <p className={HINT}>
        {t("dataProtection.processing.productText.unavailable")}
      </p>
    );
  }

  const fields = ACTIVITY_FIELDS.filter(
    (field) => field in activity.productText,
  );
  if (!activity.productDiffers || fields.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 border-l border-line-strong pl-3">
      {/*
       * A sentence and not a colour: the marker has to be read by somebody
       * who cannot tell the warn tone from the ink.
       */}
      <p className="text-small font-semibold">
        {t("dataProtection.processing.productText.marker")}
      </p>
      <p className={HINT}>
        {t("dataProtection.processing.productText.explanation")}
      </p>

      <ul className="flex flex-col gap-3">
        {fields.map((field) => (
          <li key={field} className="flex flex-col gap-2">
            <span id={`${id}-${field}`} className={LABEL}>
              {t(`dataProtection.processing.productText.fields.${field}`)}
            </span>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <dt className="text-small font-semibold">
                  {t("dataProtection.processing.productText.board")}
                </dt>
                <dd className="text-small whitespace-pre-line">
                  {statement(t, field, activity[field])}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-small font-semibold">
                  {t("dataProtection.processing.productText.product")}
                </dt>
                <dd className="text-small whitespace-pre-line">
                  {statement(t, field, activity.productText[field])}
                </dd>
              </div>
            </dl>
            <div>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={adopt.pending || awaitingRead}
                aria-describedby={`${id}-${field}`}
                onClick={() => {
                  setAdopting(field);
                  void adopt.submit(activity.activityId, {
                    fields: [field],
                    expectedRevision: activity.revision,
                  });
                }}
              >
                {adopt.state.kind === "saving" && adopting === field
                  ? t("dataProtection.processing.productText.adopting")
                  : t("dataProtection.processing.productText.adopt")}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {adopt.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              adopt.state.failure,
              {
                "activity-changed":
                  "dataProtection.processing.productText.errors.changed",
                "no-product-text":
                  "dataProtection.processing.productText.errors.noProductText",
              },
              "dataProtection.processing.productText.errors.unknown",
            ),
          )}
        </Notice>
      ) : null}
    </div>
  );
}

/** One field's value as the record says it, in the board's words. */
function statement(
  t: TFunction,
  field: ActivityField,
  value: ProcessingActivityView[ActivityField] | undefined,
): string {
  const empty = t("dataProtection.processing.productText.empty");
  switch (field) {
    case "legalBasis":
      return typeof value === "string"
        ? t(
            `dataProtection.processing.legalBasis.${value as ProcessingActivityView["legalBasis"]}`,
          )
        : empty;
    case "dataSubjectCategories":
      return Array.isArray(value) && value.length > 0
        ? (value as ProcessingActivityView["dataSubjectCategories"])
            .map((category) =>
              t(`dataProtection.categories.dataSubject.${category}`),
            )
            .join(", ")
        : empty;
    case "personalDataCategories":
      return Array.isArray(value) && value.length > 0
        ? (value as ProcessingActivityView["personalDataCategories"])
            .map((category) =>
              t(`dataProtection.categories.personalData.${category}`),
            )
            .join(", ")
        : empty;
    case "thirdCountryTransfer":
      return value === true
        ? t("dataProtection.processing.productText.yes")
        : t("dataProtection.processing.productText.no");
    default:
      return typeof value === "string" && value.trim() !== "" ? value : empty;
  }
}
