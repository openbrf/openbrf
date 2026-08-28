import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { usePanelHeadingFocus } from "../register/use-panel-heading-focus";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessage } from "./move-errors";
import { moveOut, type MoveOutResult } from "./moves-api";
import { PersonSearch, type PersonOption } from "./PersonSearch";

/**
 * Moving someone out.
 *
 * What the panel reports afterwards is the point of it. A move-out is three
 * things at once, and only the first is reversible: the residency ends, the
 * service data gets an erasure date derived from the retention policy, and -
 * when this was the person's last tenant-ownership - the membership is closed
 * in the statutory member register, which nobody can edit afterwards. The panel
 * says which of them happened rather than leaving a board member to find out
 * later.
 */

export interface MoveOutTarget {
  residencyId: string;
  personName: string;
  apartmentNumber: string;
}

export function MoveOutPanel({
  target,
  onClose,
  onMoved,
}: {
  target: MoveOutTarget;
  onClose: () => void;
  onMoved: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const heading = usePanelHeadingFocus();

  const [movedOutOn, setMovedOutOn] = useState("");
  const [recordTransfer, setRecordTransfer] = useState(false);
  const [transferredOn, setTransferredOn] = useState("");
  const [toPerson, setToPerson] = useState<PersonOption | null>(null);
  const [price, setPrice] = useState("");
  const [agreementReference, setAgreementReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  const [result, setResult] = useState<MoveOutResult | null>(null);

  const submit = async (): Promise<void> => {
    if (recordTransfer && toPerson === null) {
      // The person picker is not a native control, so `required` cannot reach
      // it and the browser will not refuse this for us. Returning in silence
      // would leave the button looking broken, with nothing said and no live
      // region updated.
      setFailure("moves.errors.transferPersonRequired");
      return;
    }
    setSubmitting(true);
    setFailure(null);

    const response = await moveOut({
      residencyId: target.residencyId,
      movedOutOn,
      transfer:
        recordTransfer && toPerson !== null
          ? {
              toPersonId: toPerson.personId,
              transferredOn,
              price: price.trim() === "" ? null : price.trim(),
              agreementReference:
                agreementReference.trim() === ""
                  ? null
                  : agreementReference.trim(),
            }
          : undefined,
    });

    setSubmitting(false);
    if (!response.ok) {
      setFailure(failureMessage(response.failure.reason));
      return;
    }
    setResult(response.value);
    onMoved();
  };

  return (
    <aside
      aria-label={t("moves.out.heading")}
      className="flex flex-col gap-5 rounded-panel border border-line bg-raised p-5 shadow-raised"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 ref={heading} tabIndex={-1} className="text-headline">
          {t("moves.out.heading")}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-control border border-line-strong px-3 text-small font-semibold text-ink"
        >
          {t("moves.cancel")}
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-label text-ink-muted uppercase">
          {t("moves.out.residency")}
        </span>
        <span className="text-body font-medium text-ink">
          {target.personName}
        </span>
        <span className="font-data text-data text-ink-muted">
          {target.apartmentNumber}
        </span>
      </div>

      {result === null ? (
        <>
          <p className="text-body text-ink-muted">
            {t("moves.out.description")}
          </p>

          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className={LABEL} htmlFor="move-out-date">
              {t("moves.out.movedOutOn")}
              <input
                id="move-out-date"
                type="date"
                required
                value={movedOutOn}
                onChange={(event) => {
                  setMovedOutOn(event.target.value);
                }}
                className={FIELD_DATA}
              />
            </label>

            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <label className="flex min-h-11 items-center gap-3 text-body text-ink">
                <input
                  type="checkbox"
                  checked={recordTransfer}
                  onChange={(event) => {
                    setRecordTransfer(event.target.checked);
                  }}
                  className="size-5 accent-trust"
                />
                {t("moves.transfer.record")}
              </label>
              <p className={HINT}>{t("moves.transfer.hint")}</p>
            </div>

            {recordTransfer ? (
              <>
                <PersonSearch
                  id="move-out-to-person"
                  label={t("moves.transfer.toPerson")}
                  selected={toPerson}
                  onSelect={setToPerson}
                />

                <label className={LABEL} htmlFor="move-out-transferred-on">
                  {t("moves.transfer.transferredOn")}
                  <input
                    id="move-out-transferred-on"
                    type="date"
                    required
                    value={transferredOn}
                    onChange={(event) => {
                      setTransferredOn(event.target.value);
                    }}
                    className={FIELD_DATA}
                  />
                </label>

                <label className={LABEL} htmlFor="move-out-price">
                  {t("moves.transfer.price")}
                  <input
                    id="move-out-price"
                    type="text"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => {
                      setPrice(event.target.value);
                    }}
                    className={FIELD_DATA}
                  />
                </label>

                <div className="flex flex-col gap-1">
                  <label className={LABEL} htmlFor="move-out-agreement">
                    {t("moves.transfer.agreementReference")}
                    <input
                      id="move-out-agreement"
                      type="text"
                      value={agreementReference}
                      onChange={(event) => {
                        setAgreementReference(event.target.value);
                      }}
                      className={FIELD}
                    />
                  </label>
                  <p className={HINT}>
                    {t("moves.transfer.agreementReferenceHint")}
                  </p>
                </div>
              </>
            ) : null}

            {failure === null ? null : (
              <Notice tone="danger" live>
                {t(failure)}
              </Notice>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={submitting}
                className={PRIMARY_BUTTON}
              >
                {submitting ? t("moves.out.working") : t("moves.out.submit")}
              </button>
              <button
                type="button"
                onClick={onClose}
                className={SECONDARY_BUTTON}
              >
                {t("moves.cancel")}
              </button>
            </div>
          </form>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <Notice tone="ok" live>
            {t("moves.out.done", { apartment: target.apartmentNumber })}
          </Notice>

          <p className="font-data text-data text-warn">
            {t("moves.out.purgeOn", { date: result.purgeOn })}
          </p>
          {result.memberRegisterExitRecorded ? (
            <p className="text-small text-ink-muted">
              {t("moves.out.registerExit")}
            </p>
          ) : null}
          <p className="text-small text-ink-muted">
            {t("moves.out.registerKept")}
          </p>
          {result.transferId === null ? null : (
            <p className="text-small text-ink-muted">
              {t("moves.transfer.recorded")}
            </p>
          )}
          <p className="text-small text-ink-muted">
            {t("moves.out.boardReminder", { date: result.boardReminderOn })}
          </p>

          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            {t("register.person.close")}
          </button>
        </div>
      )}
    </aside>
  );
}
