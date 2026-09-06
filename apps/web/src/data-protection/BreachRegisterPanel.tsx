import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  decideBreach,
  type BreachRisk,
  type BreachView,
} from "../api/data-protection";
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
                {breach.state === "awaitingDecision" ||
                breach.state === "overdue"
                  ? t("dataProtection.breaches.hoursLeft", {
                      hours: Math.round(breach.hoursLeft),
                    })
                  : t("dataProtection.breaches.discoveredOn", {
                      date: breach.discoveredAt.slice(0, 10),
                    })}
              </p>

              <p className={HINT}>{breach.dataDescription}</p>

              {breach.state === "awaitingDecision" ||
              breach.state === "overdue" ? (
                <>
                  <div>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => {
                        setOpen(
                          open === breach.breachId ? null : breach.breachId,
                        );
                      }}
                    >
                      {t("dataProtection.breaches.decide")}
                    </button>
                  </div>
                  {open === breach.breachId ? (
                    <DecideForm
                      breach={breach}
                      onDecided={() => {
                        setOpen(null);
                        onDecided();
                      }}
                    />
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

  /*
   * A notification later than the bound carries the reasons for the delay
   * (art. 33(1)). Asked for on the screen the moment the date makes it needed,
   * rather than only refused by the server afterwards.
   */
  const late =
    imyNotifiedAt !== "" &&
    new Date(imyNotifiedAt).getTime() > new Date(breach.imyNotifyBy).getTime();

  return (
    <form
      className="flex flex-col gap-3 border-l border-line pl-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save.submit(breach.breachId, {
          risk,
          imyNotificationRequired: imyRequired,
          imyDecisionGround: imyGround,
          imyNotifiedAt: imyNotifiedAt === "" ? null : imyNotifiedAt,
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
