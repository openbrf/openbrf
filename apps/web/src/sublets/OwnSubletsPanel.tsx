import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type OwnSubletApplication,
  reviseSubletApplication,
  withdrawSubletApplication,
} from "../api/sublets";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { scannedSubletParts, subletFailureKey } from "./sublet-failures";
import { SubletStatusChip } from "./SubletStatusChip";

export interface OwnSubletsPanelProps {
  applications: readonly OwnSubletApplication[];
  onChanged: () => void;
}

/**
 * What this member has asked the board's consent for.
 *
 * Changing and withdrawing are offered only while the application is still open,
 * because that is the only state the API accepts either in: once the board has
 * answered, a member who arranged a letting on the strength of a consent must not
 * find it edited from under them, and a button that always failed would be a
 * worse way to say so than no button.
 *
 * A refused or withdrawn application stays on the list with its date. The record
 * that the member asked is theirs, and nothing here deletes a row - the purge
 * does, two years after the later of the answer and the end of the period.
 *
 * ## What a refusal is not the end of
 *
 * BRL 7 kap. 11 § lets the member let anyway if the rent tribunal
 * (hyresnamnden) permits, and a member told only "refused" has been told the
 * smaller half. So a refused row says so, and where somebody has recorded a
 * permission the row states that too - beside the refusal rather than instead of
 * it, because the association did not consent and the platform must not say it
 * did.
 */
export function OwnSubletsPanel({
  applications,
  onChanged,
}: OwnSubletsPanelProps): ReactElement {
  const { t } = useTranslation();
  /** Which row is mid-request, so only that row reads as busy. */
  const [actingOn, setActingOn] = useState<string | null>(null);
  /** Which row is open for editing, and the draft in it. */
  const [editing, setEditing] = useState<{
    id: string;
    periodFrom: string;
    periodTo: string;
    reason: string;
  } | null>(null);

  const withdraw = useSaveAction(withdrawSubletApplication, () => {
    setActingOn(null);
    onChanged();
  });
  const revise = useSaveAction(reviseSubletApplication, () => {
    setActingOn(null);
    setEditing(null);
    onChanged();
  });

  const failure =
    withdraw.state.kind === "failed"
      ? withdraw.state.failure
      : revise.state.kind === "failed"
        ? revise.state.failure
        : null;
  const scanned = failure === null ? [] : scannedSubletParts(failure);

  return (
    <Panel
      title={t("sublets.mine.title")}
      description={t("sublets.mine.description")}
      notice={
        failure === null ? null : (
          <Notice tone="danger" live>
            {t(subletFailureKey(failure))}
            {scanned.length === 0 ? null : ` ${t("sublets.apply.reasonField")}`}
          </Notice>
        )
      }
    >
      {applications.length === 0 ? (
        <p className="text-body text-ink-muted">{t("sublets.mine.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {applications.map((application) => (
            <li
              key={application.id}
              className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-data text-data font-semibold">
                  {application.apartment === null
                    ? t("sublets.mine.apartmentGone")
                    : `${application.apartment.address} ${application.apartment.number}`}
                </span>
                <SubletStatusChip status={application.status} />
                <span className="ml-auto font-data text-data text-ink-muted">
                  {`${application.periodFrom} - ${application.periodTo}`}
                </span>
              </div>

              <p className="text-small whitespace-pre-line">
                {application.reason}
              </p>

              {application.decisionNote === null ? null : (
                <p className="text-small whitespace-pre-line text-ink-muted">
                  {t("sublets.mine.boardSaid", {
                    note: application.decisionNote,
                  })}
                </p>
              )}

              {application.status === "REFUSED" ? (
                <p className={HINT}>
                  {application.tribunalPermission === null
                    ? t("sublets.mine.tribunalAvailable")
                    : t(
                        application.tribunalPermission.permittedUntil === null
                          ? "sublets.mine.tribunalPermittedOpenEnded"
                          : "sublets.mine.tribunalPermitted",
                        {
                          on: application.tribunalPermission.permittedOn,
                          until:
                            application.tribunalPermission.permittedUntil ?? "",
                        },
                      )}
                </p>
              ) : null}

              {application.status === "SUBMITTED" ? (
                editing?.id === application.id ? (
                  <form
                    className="flex flex-col gap-3 border-t border-line pt-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setActingOn(application.id);
                      void revise.submit({
                        applicationId: application.id,
                        periodFrom: editing.periodFrom,
                        periodTo: editing.periodTo,
                        reason: editing.reason,
                      });
                    }}
                  >
                    <div className="flex flex-wrap gap-4">
                      <label className={`${LABEL} max-w-48`}>
                        {t("sublets.apply.fromField")}
                        <input
                          type="date"
                          className={FIELD_DATA}
                          value={editing.periodFrom}
                          required
                          onChange={(event) => {
                            setEditing({
                              ...editing,
                              periodFrom: event.target.value,
                            });
                          }}
                        />
                      </label>
                      <label className={`${LABEL} max-w-48`}>
                        {t("sublets.apply.toField")}
                        <input
                          type="date"
                          className={FIELD_DATA}
                          value={editing.periodTo}
                          required
                          onChange={(event) => {
                            setEditing({
                              ...editing,
                              periodTo: event.target.value,
                            });
                          }}
                        />
                      </label>
                    </div>
                    <label className={LABEL}>
                      {t("sublets.apply.reasonField")}
                      <textarea
                        className={`${FIELD} min-h-24 py-2`}
                        value={editing.reason}
                        maxLength={4000}
                        required
                        onChange={(event) => {
                          setEditing({
                            ...editing,
                            reason: event.target.value,
                          });
                        }}
                      />
                    </label>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="submit"
                        className={SECONDARY_BUTTON}
                        disabled={
                          actingOn === application.id &&
                          revise.state.kind === "saving"
                        }
                      >
                        {actingOn === application.id &&
                        revise.state.kind === "saving"
                          ? t("sublets.mine.saving")
                          : t("sublets.mine.save")}
                      </button>
                      <button
                        type="button"
                        className={QUIET_BUTTON}
                        onClick={() => {
                          revise.reset();
                          setEditing(null);
                        }}
                      >
                        {t("sublets.mine.cancelEdit")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      // Names the application, because every row offers the same
                      // act and a screen reader hears one button per row
                      // otherwise.
                      aria-label={t("sublets.mine.editNamed", {
                        from: application.periodFrom,
                        to: application.periodTo,
                      })}
                      onClick={() => {
                        withdraw.reset();
                        revise.reset();
                        setEditing({
                          id: application.id,
                          periodFrom: application.periodFrom,
                          periodTo: application.periodTo,
                          reason: application.reason,
                        });
                      }}
                    >
                      {t("sublets.mine.edit")}
                    </button>
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      aria-label={t("sublets.mine.withdrawNamed", {
                        from: application.periodFrom,
                        to: application.periodTo,
                      })}
                      disabled={
                        actingOn === application.id &&
                        withdraw.state.kind === "saving"
                      }
                      onClick={() => {
                        // The other act's state is cleared first, so a refusal
                        // it met does not sit over this one's outcome.
                        revise.reset();
                        setActingOn(application.id);
                        void withdraw.submit({
                          applicationId: application.id,
                        });
                      }}
                    >
                      {actingOn === application.id &&
                      withdraw.state.kind === "saving"
                        ? t("sublets.mine.withdrawing")
                        : t("sublets.mine.withdraw")}
                    </button>
                  </div>
                )
              ) : (
                <p className="text-small text-ink-muted">
                  {t("sublets.mine.closedOn", {
                    date: application.closedAt?.slice(0, 10) ?? "",
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
