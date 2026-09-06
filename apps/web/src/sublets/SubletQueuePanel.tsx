import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  decideSubletApplication,
  type QueuedSubletApplication,
  recordSubletTribunalPermission,
  type SubletApplicant,
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
import { NotRecorded } from "../ui/NotRecorded";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { scannedSubletParts, subletFailureKey } from "./sublet-failures";
import { SubletStatusChip } from "./SubletStatusChip";

export interface SubletQueuePanelProps {
  applications: readonly QueuedSubletApplication[];
  onChanged: () => void;
}

/**
 * The queue the board works: what the members have asked consent for.
 *
 * Open applications first and oldest first within a status, which is the order
 * the server returns them in - the queue is worked from the top and the request
 * that has been waiting longest is the one to look at.
 *
 * ## The two acts, and why only one of them is a decision
 *
 * Consenting or refusing is the board's own act under BRL 7 kap. 10 §, and it is
 * offered once: a member who arranged a letting on the strength of a consent
 * must not find it taken back on a screen, so the control is gone the moment the
 * application closes and the row states what was answered instead.
 *
 * Recording what the rent tribunal decided is not a decision at all. 11 § lets
 * the member let anyway where the board refused, and the platform cannot know
 * what the hyresnamnden said unless somebody writes it down - so the control is
 * offered on a refused row only, it changes no status, and the row goes on
 * saying the association refused. That is the difference the panel has to make
 * visible: the association did not consent; the tribunal permitted.
 */
export function SubletQueuePanel({
  applications,
  onChanged,
}: SubletQueuePanelProps): ReactElement {
  const { t } = useTranslation();
  const [actingOn, setActingOn] = useState<string | null>(null);
  /** The note the board is writing with its answer, per row. */
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** Which refused row has its tribunal form open, and the dates in it. */
  const [tribunal, setTribunal] = useState<{
    id: string;
    permittedOn: string;
    permittedUntil: string;
  } | null>(null);

  const decide = useSaveAction(decideSubletApplication, () => {
    setActingOn(null);
    onChanged();
  });
  const record = useSaveAction(recordSubletTribunalPermission, () => {
    setActingOn(null);
    setTribunal(null);
    onChanged();
  });

  const failure =
    decide.state.kind === "failed"
      ? decide.state.failure
      : record.state.kind === "failed"
        ? record.state.failure
        : null;
  const scanned = failure === null ? [] : scannedSubletParts(failure);

  const answer = (application: QueuedSubletApplication, consent: boolean) => {
    // The other act's state is cleared first, so a refusal it met does not sit
    // over this one's outcome: the notice above shows whichever failure is
    // newest, and a stale one would outlive the act that caused it.
    record.reset();
    setActingOn(application.id);
    // An empty box is no note rather than an empty one: the server's schema
    // takes a non-empty string or null, and a field nobody typed in is null.
    const written = (notes[application.id] ?? "").trim();
    void decide.submit({
      applicationId: application.id,
      consent,
      note: written === "" ? null : written,
    });
  };

  return (
    <Panel
      title={t("sublets.queue.title")}
      description={t("sublets.queue.description")}
      notice={
        failure === null ? (
          <Notice tone="info">{t("sublets.queue.statute")}</Notice>
        ) : (
          <Notice tone="danger" live>
            {t(subletFailureKey(failure))}
            {scanned.length === 0 ? null : ` ${t("sublets.queue.noteField")}`}
          </Notice>
        )
      }
    >
      {applications.length === 0 ? (
        <p className="text-body text-ink-muted">{t("sublets.queue.empty")}</p>
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

              <p className="text-small text-ink-muted">
                {t("sublets.queue.appliedBy")}{" "}
                <Applicant of={application.applicant} />
              </p>

              <p className="text-small whitespace-pre-line">
                {application.reason}
              </p>

              {application.decisionNote === null ? null : (
                <p className="text-small whitespace-pre-line text-ink-muted">
                  {t("sublets.queue.answered", {
                    note: application.decisionNote,
                  })}
                </p>
              )}

              {application.status === "SUBMITTED" ? (
                <div className="flex flex-col gap-3 border-t border-line pt-3">
                  <label className={LABEL}>
                    {t("sublets.queue.noteField")}
                    <textarea
                      className={`${FIELD} min-h-20 py-2`}
                      value={notes[application.id] ?? ""}
                      maxLength={2000}
                      onChange={(event) => {
                        setNotes({
                          ...notes,
                          [application.id]: event.target.value,
                        });
                      }}
                    />
                  </label>
                  {/* Never the only carrier of the reason it matters: BRL 7 kap.
                      11 § gives the rent tribunal permission where the
                      association has no befogad anledning to refuse, so a
                      refusal whose ground is nowhere written down leaves the
                      association with nothing to point at. */}
                  <p className={HINT}>{t("sublets.queue.noteHint")}</p>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      aria-label={t("sublets.queue.consentNamed", {
                        from: application.periodFrom,
                        to: application.periodTo,
                      })}
                      disabled={
                        actingOn === application.id &&
                        decide.state.kind === "saving"
                      }
                      onClick={() => {
                        answer(application, true);
                      }}
                    >
                      {t("sublets.queue.consent")}
                    </button>
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      aria-label={t("sublets.queue.refuseNamed", {
                        from: application.periodFrom,
                        to: application.periodTo,
                      })}
                      disabled={
                        actingOn === application.id &&
                        decide.state.kind === "saving"
                      }
                      onClick={() => {
                        answer(application, false);
                      }}
                    >
                      {t("sublets.queue.refuse")}
                    </button>
                  </div>
                </div>
              ) : null}

              {application.status === "REFUSED" ? (
                <TribunalRecord
                  application={application}
                  open={tribunal?.id === application.id}
                  draft={tribunal}
                  busy={
                    actingOn === application.id &&
                    record.state.kind === "saving"
                  }
                  onOpen={() => {
                    decide.reset();
                    record.reset();
                    setTribunal({
                      id: application.id,
                      permittedOn:
                        application.tribunalPermission?.permittedOn ?? "",
                      permittedUntil:
                        application.tribunalPermission?.permittedUntil ?? "",
                    });
                  }}
                  onChange={setTribunal}
                  onCancel={() => {
                    record.reset();
                    setTribunal(null);
                  }}
                  onSave={(permission) => {
                    decide.reset();
                    setActingOn(application.id);
                    void record.submit({
                      applicationId: application.id,
                      permission,
                    });
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * What the rent tribunal decided, as the board writes it down.
 *
 * Offered on a refused application only, because that is the state BRL 7 kap.
 * 11 § opens the route from and the server refuses it anywhere else. It is a
 * record and not a decision: nothing here changes the status, and the row goes
 * on saying the association refused - which is the honest answer, since the
 * association did refuse and somebody else permitted.
 *
 * The end date is optional although 11 § forsta stycket requires the permission
 * to be limited in time, because what is recorded is what the decision said
 * rather than what it ought to have said. A board holding a decision with no end
 * date must still be able to enter it.
 */
function TribunalRecord({
  application,
  open,
  draft,
  busy,
  onOpen,
  onChange,
  onCancel,
  onSave,
}: {
  application: QueuedSubletApplication;
  open: boolean;
  draft: { id: string; permittedOn: string; permittedUntil: string } | null;
  busy: boolean;
  onOpen: () => void;
  onChange: (
    draft: { id: string; permittedOn: string; permittedUntil: string } | null,
  ) => void;
  onCancel: () => void;
  onSave: (
    permission: { permittedOn: string; permittedUntil: string | null } | null,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const recorded = application.tribunalPermission;

  if (!open || draft === null) {
    return (
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <p className={HINT}>
          {recorded === null
            ? t("sublets.queue.tribunalNone")
            : t(
                recorded.permittedUntil === null
                  ? "sublets.queue.tribunalRecordedOpenEnded"
                  : "sublets.queue.tribunalRecorded",
                {
                  on: recorded.permittedOn,
                  until: recorded.permittedUntil ?? "",
                },
              )}
        </p>
        <div>
          <button
            type="button"
            className={QUIET_BUTTON}
            aria-label={t("sublets.queue.tribunalRecordNamed", {
              from: application.periodFrom,
              to: application.periodTo,
            })}
            onClick={onOpen}
          >
            {t("sublets.queue.tribunalRecord")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 border-t border-line pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          permittedOn: draft.permittedOn,
          permittedUntil:
            draft.permittedUntil === "" ? null : draft.permittedUntil,
        });
      }}
    >
      <div className="flex flex-wrap gap-4">
        <label className={`${LABEL} max-w-48`}>
          {t("sublets.queue.tribunalOnField")}
          <input
            type="date"
            className={FIELD_DATA}
            value={draft.permittedOn}
            required
            onChange={(event) => {
              onChange({ ...draft, permittedOn: event.target.value });
            }}
          />
        </label>
        <label className={`${LABEL} max-w-48`}>
          {t("sublets.queue.tribunalUntilField")}
          <input
            type="date"
            className={FIELD_DATA}
            value={draft.permittedUntil}
            onChange={(event) => {
              onChange({ ...draft, permittedUntil: event.target.value });
            }}
          />
        </label>
      </div>
      <p className={HINT}>{t("sublets.queue.tribunalHint")}</p>
      <div className="flex flex-wrap gap-3">
        <button type="submit" className={SECONDARY_BUTTON} disabled={busy}>
          {busy ? t("sublets.mine.saving") : t("sublets.mine.save")}
        </button>
        {recorded === null ? null : (
          <button
            type="button"
            className={QUIET_BUTTON}
            disabled={busy}
            onClick={() => {
              onSave(null);
            }}
          >
            {t("sublets.queue.tribunalClear")}
          </button>
        )}
        <button type="button" className={QUIET_BUTTON} onClick={onCancel}>
          {t("sublets.mine.cancelEdit")}
        </button>
      </div>
    </form>
  );
}

/**
 * Who applied, as the board is told.
 *
 * A member with protected personal data is not named here even though the
 * board's own address book prints them: that register has a statutory reason to
 * and a queue has none. A board member who has to reach them goes through the
 * register.
 */
function Applicant({ of }: { of: SubletApplicant }): ReactElement {
  const { t } = useTranslation();

  if (of.kind === "member") {
    return <span>{of.name}</span>;
  }
  if (of.kind === "protected") {
    return <NotRecorded meaning={t("sublets.queue.applicantProtected")} />;
  }
  return <NotRecorded meaning={t("sublets.queue.applicantUnknown")} />;
}
