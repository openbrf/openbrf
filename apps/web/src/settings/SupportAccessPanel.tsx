import {
  SUPPORT_ACCESS_HOURS,
  SUPPORT_REASON_MAX_LENGTH,
  type SupportAccessHours,
} from "@openbrf/shared";
import { useState, type FormEvent, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  closeSupportAccess,
  fetchSupportAccess,
  openSupportAccess,
  type SupportAccessState,
  type SupportAccessView,
  type SupportSessionView,
} from "../api/support";
import type { TranslationKey } from "../i18n/translation-key";
import { useRead } from "../overview/use-read";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { DATA_TAGS } from "../ui/data-tags";
import { LoadFailure } from "../ui/LoadFailure";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface SupportAccessPanelProps {
  /** Whether this viewer may open and close support access. */
  editable: boolean;
}

const HOURS_LABEL: Readonly<Record<SupportAccessHours, TranslationKey>> = {
  1: "settings.supportAccess.hours.1",
  8: "settings.supportAccess.hours.8",
  24: "settings.supportAccess.hours.24",
  72: "settings.supportAccess.hours.72",
  168: "settings.supportAccess.hours.168",
};

const STATE_LABEL: Readonly<Record<SupportAccessState, TranslationKey>> = {
  open: "settings.supportAccess.state.open",
  closed: "settings.supportAccess.state.closed",
  ended: "settings.supportAccess.state.ended",
  lapsed: "settings.supportAccess.state.lapsed",
};

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  "support-access-open": "settings.supportAccess.errors.alreadyOpen",
  "support-access-closed": "settings.supportAccess.errors.alreadyClosed",
  "invalid-body": "settings.supportAccess.errors.reason",
};

/**
 * Support access (ADR 0028): the administrator's instruction to whoever hosts
 * the instance that a supporter may look at it, read only, for a stated time.
 *
 * Opened here with the hours and a reason, and closed here by any
 * administrator. The board reads it without changing it, so it can see whether
 * somebody from the host may be looking and who has. The reason is kept only
 * in the audit log, and kept for good, which the form says before it is sent.
 *
 * What a supporter can and cannot see is said on the panel rather than left
 * to the ADR: the administrator is the one deciding to let somebody in.
 */
export function SupportAccessPanel({
  editable,
}: SupportAccessPanelProps): ReactElement {
  const { t, i18n } = useTranslation();
  const { state, retry } = useRead(fetchSupportAccess);
  const [hours, setHours] = useState<SupportAccessHours>(8);
  const [reason, setReason] = useState("");

  const opening = useSaveAction(openSupportAccess, () => {
    setReason("");
    retry();
  });
  const closing = useSaveAction(closeSupportAccess, retry);

  const moment = (iso: string): string => formatMoment(iso, i18n.language);
  const failed =
    opening.state.kind === "failed"
      ? opening.state.failure
      : closing.state.kind === "failed"
        ? closing.state.failure
        : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (reason.trim() === "") {
      return;
    }
    closing.reset();
    void opening.submit({ hours, reason: reason.trim() });
  };

  const open = state.kind === "loaded" ? state.value.open : null;
  const earlier =
    state.kind === "loaded"
      ? state.value.accesses.filter((access) => access.id !== open?.id)
      : [];

  return (
    <Panel
      title={t("settings.supportAccess.title")}
      description={t("settings.supportAccess.description")}
      notice={
        <>
          <Notice tone="info">{t("settings.supportAccess.whatIsSeen")}</Notice>
          {failed === null ? null : (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(failed, FAILURES, "settings.errors.unknown"),
              )}
            </Notice>
          )}
        </>
      }
    >
      {state.kind === "loading" ? (
        <p role="status" className="text-body text-ink-muted">
          {t("settings.loading")}
        </p>
      ) : null}

      {state.kind === "failed" ? (
        <LoadFailure
          messageKey="settings.supportAccess.errors.loadFailed"
          onRetry={retry}
        />
      ) : null}

      {state.kind === "loaded" && open !== null ? (
        <div className="flex flex-col gap-3">
          <p className="text-body">
            <Trans
              t={t}
              i18nKey="settings.supportAccess.openUntil"
              values={{
                endsAt: moment(open.endsAt),
                name:
                  open.openedBy.name ??
                  t("settings.supportAccess.unknownPerson"),
                openedAt: moment(open.openedAt),
              }}
              components={DATA_TAGS}
            />
          </p>
          <Sessions sessions={open.sessions} moment={moment} />
          {editable ? (
            <div>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={closing.pending}
                onClick={() => {
                  opening.reset();
                  void closing.submit(open.id);
                }}
              >
                {closing.pending
                  ? t("settings.supportAccess.closing")
                  : t("settings.supportAccess.close")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {state.kind === "loaded" && open === null ? (
        editable ? (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <label className={LABEL}>
              {t("settings.supportAccess.hoursLabel")}
              <select
                className={`${FIELD} w-auto`}
                value={hours}
                onChange={(event) => {
                  setHours(Number(event.target.value) as SupportAccessHours);
                }}
              >
                {SUPPORT_ACCESS_HOURS.map((choice) => (
                  <option key={choice} value={choice}>
                    {t(HOURS_LABEL[choice])}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              {t("settings.supportAccess.reasonLabel")}
              <textarea
                className={FIELD_MULTILINE}
                rows={3}
                required
                maxLength={SUPPORT_REASON_MAX_LENGTH}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
              <span className={HINT}>
                {t("settings.supportAccess.reasonHint")}
              </span>
            </label>
            <div>
              <button
                type="submit"
                className={PRIMARY_BUTTON}
                disabled={opening.pending || reason.trim() === ""}
              >
                {opening.pending
                  ? t("settings.supportAccess.opening")
                  : t("settings.supportAccess.open")}
              </button>
            </div>
          </form>
        ) : (
          <p className="text-body text-ink-muted">
            {t("settings.supportAccess.noneOpen")}
          </p>
        )
      ) : null}

      {earlier.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-line pt-4">
          <h3 className="text-label">{t("settings.supportAccess.earlier")}</h3>
          <ul className="flex flex-col gap-4">
            {earlier.map((access) => (
              <EarlierAccess key={access.id} access={access} moment={moment} />
            ))}
          </ul>
        </section>
      ) : null}
    </Panel>
  );
}

/** One access that is no longer open: why, by whom, and who signed in. */
function EarlierAccess({
  access,
  moment,
}: {
  access: SupportAccessView;
  moment: (iso: string) => string;
}): ReactElement {
  const { t } = useTranslation();
  const unknown = t("settings.supportAccess.unknownPerson");
  return (
    <li className="flex flex-col gap-1">
      <p className="text-body">
        <span className="font-semibold">{t(STATE_LABEL[access.state])}</span>
        {" · "}
        <Trans
          t={t}
          i18nKey="settings.supportAccess.openedBy"
          values={{
            name: access.openedBy.name ?? unknown,
            openedAt: moment(access.openedAt),
          }}
          components={DATA_TAGS}
        />
      </p>
      <p className="text-small text-ink-muted">
        {access.closedAt !== null ? (
          <Trans
            t={t}
            i18nKey="settings.supportAccess.closedBy"
            values={{
              name: access.closedBy?.name ?? unknown,
              closedAt: moment(access.closedAt),
            }}
            components={DATA_TAGS}
          />
        ) : (
          <Trans
            t={t}
            i18nKey={
              access.state === "lapsed"
                ? "settings.supportAccess.lapsedNote"
                : "settings.supportAccess.endedAt"
            }
            values={{ endsAt: moment(access.endsAt) }}
            components={DATA_TAGS}
          />
        )}
      </p>
      <Sessions sessions={access.sessions} moment={moment} />
    </li>
  );
}

/** The supporters the host sent under one access, and when they were in. */
function Sessions({
  sessions,
  moment,
}: {
  sessions: readonly SupportSessionView[];
  moment: (iso: string) => string;
}): ReactElement {
  const { t } = useTranslation();
  if (sessions.length === 0) {
    return (
      <p className="text-small text-ink-muted">
        {t("settings.supportAccess.noSessions")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {sessions.map((session) => (
        <li key={session.id} className="text-small">
          <span className="font-semibold">{session.supporter}</span>
          {" · "}
          {session.startedAt === null ? (
            <Trans
              t={t}
              i18nKey="settings.supportAccess.session.notUsed"
              values={{ issuedAt: moment(session.issuedAt) }}
              components={DATA_TAGS}
            />
          ) : session.endedAt === null ? (
            <Trans
              t={t}
              i18nKey="settings.supportAccess.session.signedIn"
              values={{ startedAt: moment(session.startedAt) }}
              components={DATA_TAGS}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="settings.supportAccess.session.signedOut"
              values={{
                startedAt: moment(session.startedAt),
                endedAt: moment(session.endedAt),
              }}
              components={DATA_TAGS}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
