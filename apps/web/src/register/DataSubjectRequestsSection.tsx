import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  closeDataSubjectRequest,
  decideDataSubjectRequest,
  recordDataSubjectRequest,
  type DataSubjectRequestKind,
  type DataSubjectRequestView,
  type ErasureException,
  type ErasureGround,
} from "../api/data-protection";
import { localDayNow } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { CAUTION_BUTTON, FIELD, LABEL } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";

export interface DataSubjectRequestsSectionProps {
  personId: string;
  requests: DataSubjectRequestView[];
  onChanged: () => void;
}

/**
 * Why each refusal reads as a sentence.
 *
 * Most of these are not the board being overruled. They are the platform
 * declining to record a grant the purge could not carry out - which would leave
 * a person told their data was erased and a row saying so, with the data still
 * there. A board that meets one needs to know which, and what to do instead.
 */
const REASON: Record<string, TranslationKey> = {
  "person-not-found": "register.person.requests.reasons.personNotFound",
  "issue-not-found": "register.person.requests.reasons.issueNotFound",
  "request-not-found": "register.person.requests.reasons.requestNotFound",
  "erasure-ground-required":
    "register.person.requests.reasons.erasureGroundRequired",
  "ground-not-applicable":
    "register.person.requests.reasons.groundNotApplicable",
  "issue-kind-inconsistent":
    "register.person.requests.reasons.issueKindInconsistent",
  "erasure-exception-required":
    "register.person.requests.reasons.erasureExceptionRequired",
  "exception-inconsistent":
    "register.person.requests.reasons.exceptionInconsistent",
  "exception-not-applicable":
    "register.person.requests.reasons.exceptionNotApplicable",
  "decision-ground-required":
    "register.person.requests.reasons.decisionGroundRequired",
  "already-open": "register.person.requests.reasons.alreadyOpen",
  "already-decided": "register.person.requests.reasons.alreadyDecided",
  "already-closed": "register.person.requests.reasons.alreadyClosed",
  "currently-resident": "register.person.requests.reasons.currentlyResident",
  "on-legal-hold": "register.person.requests.reasons.onLegalHold",
  "board-position-current":
    "register.person.requests.reasons.boardPositionCurrent",
  "system-role-current": "register.person.requests.reasons.systemRoleCurrent",
  "processing-restricted":
    "register.person.requests.reasons.processingRestricted",
};

const STATE_LABEL: Record<DataSubjectRequestView["state"], TranslationKey> = {
  open: "register.person.requests.state.open",
  overdue: "register.person.requests.state.overdue",
  granted: "register.person.requests.state.granted",
  refused: "register.person.requests.state.refused",
  executed: "register.person.requests.state.executed",
  closed: "register.person.requests.state.closed",
};

/**
 * What this person has asked about their own data (GDPR art. 17, 18 and 21).
 *
 * On the person's page rather than on the data protection screen, because
 * deciding it is an act about one named person - a register decision of the
 * same weight as entering a move-out - while the data protection screen holds
 * the association's account of itself.
 *
 * Beside the legal hold for the same reason the hold sits beside the purge
 * date: the three are one answer to "what happens to this person's data, and
 * when", and a board reading one without the others would be reading a promise
 * the instance is not keeping.
 */
export function DataSubjectRequestsSection({
  personId,
  requests,
  onChanged,
}: DataSubjectRequestsSectionProps): ReactElement {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-title">{t("register.person.requests.title")}</h3>
      <p className="text-small text-ink-muted">
        {t("register.person.requests.explained")}
      </p>

      {requests.length === 0 ? (
        <p className="text-small text-ink-muted">
          {t("register.person.requests.none")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.map((request) => (
            <RequestRow
              key={request.requestId}
              request={request}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}

      <div>
        <button
          type="button"
          className={CAUTION_BUTTON}
          onClick={() => {
            setRecording(!recording);
          }}
        >
          {t("register.person.requests.record")}
        </button>
      </div>

      {recording ? (
        <RecordForm
          personId={personId}
          onRecorded={() => {
            setRecording(false);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function RequestRow({
  request,
  onChanged,
}: {
  request: DataSubjectRequestView;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [deciding, setDeciding] = useState(false);
  const close = useSaveAction(closeDataSubjectRequest, onChanged);

  return (
    <li className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-body font-semibold">
          {t(`register.person.requests.kind.${request.kind}`)}
        </span>
        <span className="text-small font-semibold">
          {t(STATE_LABEL[request.state])}
        </span>
        {request.dueOn === null ? null : (
          <span className="text-small text-ink-muted">
            {t("register.person.requests.dueOn", { date: request.dueOn })}
          </span>
        )}
      </div>

      <p className="text-small text-ink-muted">{request.ground}</p>

      {request.erasureGround === null ? null : (
        <p className="text-small text-ink-muted">
          {t(`register.person.requests.erasureGround.${request.erasureGround}`)}
        </p>
      )}

      {request.issueId === null ? null : (
        <p className="text-small text-ink-muted">
          {t("register.person.requests.issueNote")}
        </p>
      )}

      {request.decisionGround === null ? null : (
        <p className="text-small text-ink-muted">{request.decisionGround}</p>
      )}

      {request.closeReason === null ? null : (
        <p className="text-small text-ink-muted">
          {request.closeReason === "purged"
            ? t("register.person.requests.closeReason.purged")
            : request.closeReason === "moved-in"
              ? t("register.person.requests.closeReason.movedIn")
              : request.closeReason}
        </p>
      )}

      {request.decision === null ? (
        <>
          <div className="flex gap-2">
            <button
              type="button"
              className={CAUTION_BUTTON}
              onClick={() => {
                setDeciding(!deciding);
              }}
            >
              {t("register.person.requests.decide")}
            </button>
            <button
              type="button"
              className={CAUTION_BUTTON}
              onClick={() => {
                void close.submit(request.requestId, {});
              }}
            >
              {t("register.person.requests.close")}
            </button>
          </div>
          {deciding ? (
            <DecideForm
              request={request}
              onDecided={() => {
                setDeciding(false);
                onChanged();
              }}
            />
          ) : null}
        </>
      ) : null}

      {close.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            REASON[close.state.failure.reason ?? ""] ??
              "register.person.requests.reasons.unknown",
          )}
        </Notice>
      ) : null}
    </li>
  );
}

function RecordForm({
  personId,
  onRecorded,
}: {
  personId: string;
  onRecorded: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<DataSubjectRequestKind>("ERASURE");
  /*
   * The association's calendar day, not the browser's UTC one. `requestedOn`
   * is the recorded fact about when the person asked and the art. 12(3) month
   * is derived from it, and between local midnight and the UTC date change
   * `toISOString` answers yesterday - which would date the request a day early
   * and take a day off the deadline. The same Stockholm calendar the API
   * validates the date against.
   */
  const [requestedOn, setRequestedOn] = useState(() => localDayNow());
  const [ground, setGround] = useState("");
  const [erasureGround, setErasureGround] = useState<ErasureGround>(
    "NO_LONGER_NECESSARY",
  );
  const [issueId, setIssueId] = useState("");

  const save = useSaveAction(recordDataSubjectRequest, onRecorded);

  return (
    <form
      className="flex flex-col gap-3 border-l border-line pl-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save.submit(personId, {
          kind,
          requestedOn,
          ground,
          // The art. 17(1) ground belongs to an erasure alone; sending one on
          // the other two kinds is refused rather than ignored.
          ...(kind === "ERASURE" ? { erasureGround } : {}),
          ...(kind === "ERASURE" && issueId !== "" ? { issueId } : {}),
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL}>{t("register.person.requests.kindLabel")}</span>
        <select
          className={FIELD}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as DataSubjectRequestKind);
          }}
        >
          <option value="ERASURE">
            {t("register.person.requests.kind.ERASURE")}
          </option>
          <option value="OBJECTION">
            {t("register.person.requests.kind.OBJECTION")}
          </option>
          <option value="RESTRICTION">
            {t("register.person.requests.kind.RESTRICTION")}
          </option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>
          {t("register.person.requests.requestedOn")}
        </span>
        <input
          className={FIELD}
          type="date"
          value={requestedOn}
          onChange={(event) => {
            setRequestedOn(event.target.value);
          }}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>
          {t("register.person.requests.groundLabel")}
        </span>
        <textarea
          className={FIELD}
          rows={2}
          value={ground}
          onChange={(event) => {
            setGround(event.target.value);
          }}
        />
      </label>

      {kind === "ERASURE" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>
              {t("register.person.requests.erasureGroundLabel")}
            </span>
            <select
              className={FIELD}
              value={erasureGround}
              onChange={(event) => {
                setErasureGround(event.target.value as ErasureGround);
              }}
            >
              {(
                [
                  "NO_LONGER_NECESSARY",
                  "CONSENT_WITHDRAWN",
                  "OBJECTION_UPHELD",
                  "UNLAWFUL_PROCESSING",
                  "LEGAL_OBLIGATION_TO_ERASE",
                ] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {t(`register.person.requests.erasureGround.${value}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>
              {t("register.person.requests.issueLabel")}
            </span>
            <input
              className={FIELD}
              value={issueId}
              onChange={(event) => {
                setIssueId(event.target.value);
              }}
            />
          </label>
        </>
      ) : null}

      <div>
        <button type="submit" className={CAUTION_BUTTON}>
          {save.state.kind === "saving"
            ? t("register.person.requests.saving")
            : t("register.person.requests.save")}
        </button>
      </div>

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            REASON[save.state.failure.reason ?? ""] ??
              "register.person.requests.reasons.unknown",
          )}
        </Notice>
      ) : null}
    </form>
  );
}

function DecideForm({
  request,
  onDecided,
}: {
  request: DataSubjectRequestView;
  onDecided: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<"GRANTED" | "REFUSED">("GRANTED");
  const [ground, setGround] = useState("");
  const [exception, setException] = useState<ErasureException>("NONE");

  const save = useSaveAction(decideDataSubjectRequest, onDecided);

  return (
    <form
      className="flex flex-col gap-3 border-l border-line pl-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save.submit(request.requestId, {
          decision,
          ground,
          // The art. 17(3) assessment is recorded with every decision on an
          // erasure, and belongs to no other kind.
          ...(request.kind === "ERASURE"
            ? { erasureException: exception }
            : {}),
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL}>
          {t("register.person.requests.decisionLabel")}
        </span>
        <select
          className={FIELD}
          value={decision}
          onChange={(event) => {
            setDecision(event.target.value as "GRANTED" | "REFUSED");
          }}
        >
          <option value="GRANTED">
            {t("register.person.requests.decision.GRANTED")}
          </option>
          <option value="REFUSED">
            {t("register.person.requests.decision.REFUSED")}
          </option>
        </select>
      </label>

      {request.kind === "ERASURE" ? (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("register.person.requests.exceptionLabel")}
          </span>
          <select
            className={FIELD}
            value={exception}
            onChange={(event) => {
              setException(event.target.value as ErasureException);
            }}
          >
            {(
              ["NONE", "LEGAL_OBLIGATION_TO_KEEP", "LEGAL_CLAIMS"] as const
            ).map((value) => (
              <option key={value} value={value}>
                {t(`register.person.requests.erasureException.${value}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className={LABEL}>
          {t("register.person.requests.decisionGroundLabel")}
        </span>
        <textarea
          className={FIELD}
          rows={2}
          value={ground}
          onChange={(event) => {
            setGround(event.target.value);
          }}
        />
      </label>

      <div>
        <button type="submit" className={CAUTION_BUTTON}>
          {save.state.kind === "saving"
            ? t("register.person.requests.saving")
            : t("register.person.requests.save")}
        </button>
      </div>

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            REASON[save.state.failure.reason ?? ""] ??
              "register.person.requests.reasons.unknown",
          )}
        </Notice>
      ) : null}
    </form>
  );
}
