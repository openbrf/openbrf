import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  decideBreach,
  updateBreach,
  type BreachRisk,
  type BreachView,
} from "../api/data-protection";
import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, HINT, LABEL, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";

export interface BreachRegisterPanelProps {
  breaches: BreachView[];
  onDecided: () => void;
}

const STATE_LABEL: Record<BreachView["state"], TranslationKey> = {
  awaitingDecision: "dataProtection.breaches.state.awaitingDecision",
  notificationOwed: "dataProtection.breaches.state.notificationOwed",
  overdue: "dataProtection.breaches.state.overdue",
  decided: "dataProtection.breaches.state.decided",
  closed: "dataProtection.breaches.state.closed",
};

const REASON: Record<string, TranslationKey> = {
  "risk-inconsistent": "dataProtection.breaches.errors.riskInconsistent",
  "subjects-ground-required":
    "dataProtection.breaches.errors.subjectsGroundRequired",
  "delay-reasons-required":
    "dataProtection.breaches.errors.delayReasonsRequired",
  "already-decided": "dataProtection.breaches.errors.alreadyDecided",
  "already-subject": "dataProtection.breaches.errors.alreadySubject",
  "personal-identity-number":
    "dataProtection.breaches.errors.personalIdentityNumber",
};

/**
 * The register of personal data breaches, and the two decisions each needs.
 *
 * The clock is stated as GDPR art. 33(1) states it - without undue delay and,
 * where feasible, within 72 hours - rather than as a countdown alone. A board
 * shown only "48 hours left" would reasonably conclude it had 48 hours, and the
 * article does not say that.
 *
 * An overdue breach stays actionable rather than turning red and final: the
 * notification is still owed, and it carries the reasons for the delay.
 *
 * Deciding that IMY is to be notified does not stop the clock. The row keeps
 * its hours and offers to record the notification until one is recorded, which
 * is the act art. 33(1) actually asks for.
 */
export function BreachRegisterPanel({
  breaches,
  onDecided,
}: BreachRegisterPanelProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Panel
      title={t("dataProtection.breaches.title")}
      description={t("dataProtection.breaches.description")}
    >
      <p className={HINT}>{t("dataProtection.breaches.deadlineNote")}</p>

      {breaches.length === 0 ? (
        <p className={HINT}>{t("dataProtection.breaches.none")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {breaches.map((breach) => (
            <li
              key={breach.breachId}
              className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-body font-semibold">{breach.title}</span>
                <span className="text-small font-semibold">
                  {t(STATE_LABEL[breach.state])}
                </span>
              </div>

              <p className={HINT}>
                {clockRunning(breach)
                  ? t("dataProtection.breaches.hoursLeft", {
                      hours: Math.round(breach.hoursLeft),
                    })
                  : t("dataProtection.breaches.discoveredOn", {
                      /*
                       * The association's day and not the UTC one. This is the
                       * date the art. 33 seventy-two hours are counted from, so
                       * a breach discovered just after midnight here would
                       * otherwise be shown to the board as discovered the day
                       * before - and the deadline it has to meet misstated by a
                       * day. The clock itself is the API's and is right: it
                       * counts hours on the instant, deliberately.
                       */
                      date: localDayOfInstant(breach.discoveredAt),
                    })}
              </p>

              <p className={HINT}>{breach.dataDescription}</p>

              {clockRunning(breach) ? (
                <>
                  <div>
                    {breach.decidedAt === null ? (
                      <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        // Names the breach, because every row offers the same
                        // act and a screen reader hears one button per row
                        // otherwise.
                        aria-label={t("dataProtection.breaches.decideNamed", {
                          title: breach.title,
                        })}
                        onClick={() => {
                          setOpen(
                            open === breach.breachId ? null : breach.breachId,
                          );
                        }}
                      >
                        {t("dataProtection.breaches.decide")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        aria-label={t(
                          "dataProtection.breaches.recordNotificationNamed",
                          { title: breach.title },
                        )}
                        onClick={() => {
                          setOpen(
                            open === breach.breachId ? null : breach.breachId,
                          );
                        }}
                      >
                        {t("dataProtection.breaches.recordNotification")}
                      </button>
                    )}
                  </div>
                  {open === breach.breachId ? (
                    breach.decidedAt === null ? (
                      <DecideForm
                        breach={breach}
                        onDecided={() => {
                          setOpen(null);
                          onDecided();
                        }}
                      />
                    ) : (
                      <NotificationForm
                        breach={breach}
                        onRecorded={() => {
                          setOpen(null);
                          onDecided();
                        }}
                      />
                    )
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Whether the art. 33(1) clock is still running on a breach: the decision or
 * the notification the decision said would be made is still owed.
 */
function clockRunning(breach: BreachView): boolean {
  return (
    breach.state === "awaitingDecision" ||
    breach.state === "notificationOwed" ||
    breach.state === "overdue"
  );
}

/**
 * A datetime-local control holds "2026-09-06T13:00" - the reader's own wall
 * clock, with no seconds and no zone - and the API takes an instant. Parsed
 * here rather than sent as written: the string means one moment to the board
 * member reading it and nothing at all to a server in another zone, and this
 * is the one place that knows which of the two is meant.
 */
function toInstant(wallClock: string): string | null {
  return wallClock === "" ? null : new Date(wallClock).toISOString();
}

/**
 * A notification later than the bound carries the reasons for the delay
 * (art. 33(1)). Asked for on the screen the moment the date makes it needed,
 * rather than only refused by the server afterwards.
 */
function isLate(breach: BreachView, wallClock: string): boolean {
  return (
    wallClock !== "" &&
    new Date(wallClock).getTime() > new Date(breach.imyNotifyBy).getTime()
  );
}

function DecideForm({
  breach,
  onDecided,
}: {
  breach: BreachView;
  onDecided: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [risk, setRisk] = useState<BreachRisk>("LIKELY");
  const [imyRequired, setImyRequired] = useState(true);
  const [imyGround, setImyGround] = useState("");
  const [imyNotifiedAt, setImyNotifiedAt] = useState("");
  const [delayReasons, setDelayReasons] = useState("");
  const [subjectsRequired, setSubjectsRequired] = useState(false);
  const [subjectsGround, setSubjectsGround] = useState("");

  const save = useSaveAction(decideBreach, () => {
    onDecided();
  });

  const late = isLate(breach, imyNotifiedAt);
  const notifiedAtInstant = toInstant(imyNotifiedAt);

  return (
    <form
      className="flex flex-col gap-3 border-l border-line pl-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save.submit(breach.breachId, {
          risk,
          imyNotificationRequired: imyRequired,
          imyDecisionGround: imyGround,
          imyNotifiedAt: notifiedAtInstant,
          delayReasons: delayReasons === "" ? null : delayReasons,
          subjectsInformationRequired: subjectsRequired,
          subjectsDecisionGround: subjectsGround === "" ? null : subjectsGround,
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL}>{t("dataProtection.breaches.riskLabel")}</span>
        <select
          className={FIELD}
          value={risk}
          onChange={(event) => {
            setRisk(event.target.value as BreachRisk);
          }}
        >
          <option value="UNLIKELY">
            {t("dataProtection.breaches.risk.UNLIKELY")}
          </option>
          <option value="LIKELY">
            {t("dataProtection.breaches.risk.LIKELY")}
          </option>
          <option value="HIGH">{t("dataProtection.breaches.risk.HIGH")}</option>
        </select>
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={imyRequired}
          onChange={(event) => {
            setImyRequired(event.target.checked);
          }}
        />
        <span className="text-small">
          {t("dataProtection.breaches.imyRequired")}
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>{t("dataProtection.breaches.imyGround")}</span>
        <textarea
          className={FIELD}
          rows={2}
          value={imyGround}
          onChange={(event) => {
            setImyGround(event.target.value);
          }}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>
          {t("dataProtection.breaches.imyNotifiedAt")}
        </span>
        <input
          className={FIELD}
          type="datetime-local"
          value={imyNotifiedAt}
          onChange={(event) => {
            setImyNotifiedAt(event.target.value);
          }}
        />
      </label>

      {late ? (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("dataProtection.breaches.delayReasons")}
          </span>
          <textarea
            className={FIELD}
            rows={2}
            value={delayReasons}
            onChange={(event) => {
              setDelayReasons(event.target.value);
            }}
          />
        </label>
      ) : null}

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={subjectsRequired}
          onChange={(event) => {
            setSubjectsRequired(event.target.checked);
          }}
        />
        <span className="text-small">
          {t("dataProtection.breaches.subjectsRequired")}
        </span>
      </label>

      {!subjectsRequired && risk === "HIGH" ? (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("dataProtection.breaches.subjectsGround")}
          </span>
          <textarea
            className={FIELD}
            rows={2}
            value={subjectsGround}
            onChange={(event) => {
              setSubjectsGround(event.target.value);
            }}
          />
        </label>
      ) : null}

      <div>
        <button type="submit" className={SECONDARY_BUTTON}>
          {save.state.kind === "saving"
            ? t("dataProtection.breaches.saving")
            : t("dataProtection.breaches.save")}
        </button>
      </div>

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            REASON[save.state.failure.reason ?? ""] ??
              "dataProtection.breaches.errors.unknown",
          )}
        </Notice>
      ) : null}
    </form>
  );
}

/**
 * Records the notification made to IMY after the board decided to make one.
 *
 * The notification itself is made in IMY's own e-service; what this records is
 * when, and IMY's reference if one was given, which is what stops the clock.
 */
function NotificationForm({
  breach,
  onRecorded,
}: {
  breach: BreachView;
  onRecorded: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [imyNotifiedAt, setImyNotifiedAt] = useState("");
  const [imyReference, setImyReference] = useState("");
  const [delayReasons, setDelayReasons] = useState(breach.delayReasons ?? "");

  const save = useSaveAction(updateBreach, () => {
    onRecorded();
  });

  const late = isLate(breach, imyNotifiedAt);

  return (
    <form
      className="flex flex-col gap-3 border-l border-line pl-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save.submit(breach.breachId, {
          imyNotifiedAt: toInstant(imyNotifiedAt),
          imyReference: imyReference === "" ? null : imyReference,
          // Only when the date asks for them: omitted, the reasons the record
          // already holds stay as they are.
          ...(late
            ? { delayReasons: delayReasons === "" ? null : delayReasons }
            : {}),
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL}>
          {t("dataProtection.breaches.imyNotifiedAt")}
        </span>
        <input
          className={FIELD}
          type="datetime-local"
          required
          value={imyNotifiedAt}
          onChange={(event) => {
            setImyNotifiedAt(event.target.value);
          }}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>
          {t("dataProtection.breaches.imyReference")}
        </span>
        <input
          className={FIELD}
          type="text"
          maxLength={100}
          value={imyReference}
          onChange={(event) => {
            setImyReference(event.target.value);
          }}
        />
      </label>

      {late ? (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("dataProtection.breaches.delayReasons")}
          </span>
          <textarea
            className={FIELD}
            rows={2}
            value={delayReasons}
            onChange={(event) => {
              setDelayReasons(event.target.value);
            }}
          />
        </label>
      ) : null}

      <div>
        <button type="submit" className={SECONDARY_BUTTON}>
          {save.state.kind === "saving"
            ? t("dataProtection.breaches.saving")
            : t("dataProtection.breaches.saveNotification")}
        </button>
      </div>

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            REASON[save.state.failure.reason ?? ""] ??
              "dataProtection.breaches.errors.unknownNotification",
          )}
        </Notice>
      ) : null}
    </form>
  );
}
