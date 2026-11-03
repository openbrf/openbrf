import {
  ISSUE_PRIORITIES,
  type IssuePriority,
  type IssueRedactionTarget,
} from "@openbrf/shared";
import { useEffect, useState, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import {
  assignIssue,
  fetchIssueHandlers,
  fetchIssueTimeline,
  type IssueHandler,
  type IssueTimelineStep,
  type IssueTypeView,
  type QueuedIssue,
  setIssueBoardOnly,
  setIssuePriority,
  setIssueTargetDate,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { DATA_TAGS } from "../ui/data-tags";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import {
  ISSUE_MEANING_LABEL,
  ISSUE_OUTCOME_LABEL,
  ISSUE_PRIORITY_LABEL,
  ISSUE_WAITING_REASON_LABEL,
} from "./issue-labels";
import { IssueHandlerName, issueHandlerName } from "./IssueHandlerName";

const HANDLING_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.handling.errors.issueNotFound",
  "assignee-not-a-handler": "issues.handling.errors.assigneeNotAHandler",
  "target-date-invalid": "issues.handling.errors.targetDateInvalid",
  "invalid-body": "issues.handling.errors.unknown",
};

/** The refusals that mean the issue on screen is out of date. */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-not-found",
  "assignee-not-a-handler",
]);

/** One act on an issue's handling, so the four share one save in flight. */
type HandlingAct =
  | { kind: "assignee"; assigneePersonId: string | null }
  | { kind: "priority"; priority: IssuePriority }
  | { kind: "targetDate"; targetDate: string | null }
  | { kind: "access"; boardOnly: boolean };

function perform(
  issueId: string,
  act: HandlingAct,
): Promise<ApiResult<QueuedIssue>> {
  switch (act.kind) {
    case "assignee":
      return assignIssue({ issueId, assigneePersonId: act.assigneePersonId });
    case "priority":
      return setIssuePriority({ issueId, priority: act.priority });
    case "targetDate":
      return setIssueTargetDate({ issueId, targetDate: act.targetDate });
    case "access":
      return setIssueBoardOnly({ issueId, boardOnly: act.boardOnly });
  }
}

/** The handler's identifier, or "" for nobody and for a purged handler. */
function personIdOf(handler: IssueHandler | null): string {
  return handler === null || handler.kind === "unknown" ? "" : handler.personId;
}

/**
 * Handling one issue (ADR 0054): who it is given to, how urgent it is, the day
 * it is meant to be done by, and whether it is closed to all but the board -
 * with its timeline under them.
 *
 * Mounted only while a handler has the issue open, because it reads two things
 * of its own: the people the issue may be assigned to, a names-only read that
 * is not the address book, and the timeline. One save in flight for the whole
 * panel, as the queue has one for status moves; every save reads the queue
 * again, and with it this panel's drafts, which are keyed to the issue's
 * values so a draft never offers to save what the queue already holds.
 */
export function IssueHandling({
  issue,
  type,
  onChanged,
}: {
  issue: QueuedIssue;
  /** The issue's type, for the board's names of the statuses on the timeline. */
  type: IssueTypeView | undefined;
  onChanged: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [handlers, setHandlers] = useState<IssueHandler[] | null>(null);
  const [timeline, setTimeline] = useState<IssueTimelineStep[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  /** Bumped after every save here, which re-reads the timeline. */
  const [reads, setReads] = useState(0);
  /*
   * The issue's own revision, read again whenever the queue brings a newer one.
   * A status moved in the form beside this panel saves and reloads the queue
   * without remounting the open panel and without a save of its own here, so
   * neither the issue's id nor `reads` changes - and the timeline would leave
   * out the step just written until it was closed and opened again. Each read
   * still answers only the issue and revision that asked for it: the cleanup
   * below drops a superseded one.
   */
  const revision = `${issue.updatedAt}:${issue.status.id}`;

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetchIssueHandlers(issue.id),
      fetchIssueTimeline(issue.id),
    ]).then(([handlerRead, timelineRead]) => {
      if (!active) {
        return;
      }
      setHandlers(handlerRead.ok ? handlerRead.value : null);
      setTimeline(timelineRead.ok ? timelineRead.value : null);
      setReadFailed(!handlerRead.ok || !timelineRead.ok);
    });
    return () => {
      active = false;
    };
  }, [issue.id, revision, reads]);

  const save = useSaveAction(
    (act: HandlingAct) => perform(issue.id, act),
    () => {
      setReads((count) => count + 1);
      onChanged();
    },
    (failure) => {
      if (STALE_REASONS.has(failure.reason)) {
        onChanged();
        setReads((count) => count + 1);
      }
    },
  );
  const busy = save.state.kind === "saving";
  const named = { type: issue.typeName };
  /** A refusal is about the draft that was sent; a new draft clears it. */
  const onDraftChanged = (): void => {
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  /*
   * The assignee as it stands, offered even when the list no longer holds them
   * - somebody who stopped handling since, or a list that did not load - so
   * the select never shows another person than the one the issue is given to.
   */
  const current = issue.assignee;
  const listed = handlers ?? [];
  const options =
    current !== null &&
    current.kind !== "unknown" &&
    !listed.some(
      (handler) =>
        handler.kind !== "unknown" && handler.personId === current.personId,
    )
      ? [current, ...listed]
      : listed;

  return (
    <div className="flex flex-col gap-4">
      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              save.state.failure,
              HANDLING_FAILURES,
              "issues.handling.errors.unknown",
            ),
          )}
        </Notice>
      ) : readFailed ? (
        <Notice tone="danger" live>
          {t("issues.handling.readFailed")}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-end gap-4">
        <ChoiceForm
          key={`assignee:${personIdOf(current)}`}
          label={t("issues.handling.assignee")}
          ariaLabel={t("issues.handling.assigneeNamed", named)}
          initial={personIdOf(current)}
          disabled={busy || handlers === null}
          saving={busy}
          onDraftChanged={onDraftChanged}
          options={[
            { value: "", label: t("issues.handling.unassigned") },
            ...options
              .filter((handler) => handler.kind !== "unknown")
              .map((handler) => ({
                value: personIdOf(handler),
                label: issueHandlerName(handler, t),
              })),
          ]}
          onSave={(value) => {
            void save.submit({
              kind: "assignee",
              assigneePersonId: value === "" ? null : value,
            });
          }}
        />

        <ChoiceForm
          key={`priority:${issue.priority}`}
          label={t("issues.handling.priority")}
          ariaLabel={t("issues.handling.priorityNamed", named)}
          initial={issue.priority}
          disabled={busy}
          saving={busy}
          onDraftChanged={onDraftChanged}
          options={ISSUE_PRIORITIES.map((priority) => ({
            value: priority,
            label: t(ISSUE_PRIORITY_LABEL[priority]),
          }))}
          onSave={(value) => {
            void save.submit({
              kind: "priority",
              priority: value as IssuePriority,
            });
          }}
        />

        <TargetDateForm
          key={`target:${issue.targetDate ?? ""}`}
          issue={issue}
          disabled={busy}
          saving={busy}
          onDraftChanged={onDraftChanged}
          onSave={(targetDate) => {
            void save.submit({ kind: "targetDate", targetDate });
          }}
        />
      </div>

      <AccessForm
        issue={issue}
        disabled={busy}
        onSave={(boardOnly) => {
          void save.submit({ kind: "access", boardOnly });
        }}
      />

      <section className="flex flex-col gap-2">
        <h3 className="text-label text-ink-muted uppercase">
          {t("issues.timeline.title")}
        </h3>
        {timeline === null ? (
          readFailed ? null : (
            <p role="status" className={HINT}>
              {t("issues.timeline.loading")}
            </p>
          )
        ) : (
          <ol className="flex flex-col gap-1">
            {timeline.map((step, index) => (
              <li
                // The steps carry no identifier of their own, and the list
                // only ever grows at its end.
                key={`${String(index)}:${step.at}`}
                className="flex flex-wrap gap-x-3 text-small"
              >
                <span className="font-data text-data text-ink-muted">
                  {formatMoment(step.at, i18n.language)}
                </span>
                <span>
                  <TimelineSentence step={step} type={type} />
                </span>
                {step.actor === null ? null : (
                  <span className="text-ink-muted">
                    {t("issues.timeline.by")}{" "}
                    <IssueHandlerName handler={step.actor} />
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** One select and its save, offered only for a real change. */
function ChoiceForm({
  label,
  ariaLabel,
  initial,
  options,
  disabled,
  saving,
  onDraftChanged,
  onSave,
}: {
  label: string;
  ariaLabel: string;
  initial: string;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  saving: boolean;
  onDraftChanged: () => void;
  onSave: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== initial) {
          onSave(value);
        }
      }}
    >
      <label className={`${LABEL} min-w-44`}>
        {label}
        <select
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.value);
            onDraftChanged();
          }}
          className={FIELD}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={disabled || value === initial}
        className={SECONDARY_BUTTON}
      >
        {saving ? t("issues.handling.saving") : t("issues.handling.save")}
      </button>
    </form>
  );
}

/** The target date, a calendar day or none. */
function TargetDateForm({
  issue,
  disabled,
  saving,
  onDraftChanged,
  onSave,
}: {
  issue: QueuedIssue;
  disabled: boolean;
  saving: boolean;
  onDraftChanged: () => void;
  onSave: (targetDate: string | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const initial = issue.targetDate ?? "";
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== initial) {
          onSave(value === "" ? null : value);
        }
      }}
    >
      <label className={`${LABEL} min-w-44`}>
        {t("issues.handling.targetDate")}
        <input
          type="date"
          aria-label={t("issues.handling.targetDateNamed", {
            type: issue.typeName,
          })}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.value);
            onDraftChanged();
          }}
          className={FIELD_DATA}
        />
      </label>
      <button
        type="submit"
        disabled={disabled || value === initial}
        className={SECONDARY_BUTTON}
      >
        {saving ? t("issues.handling.saving") : t("issues.handling.save")}
      </button>
    </form>
  );
}

/**
 * Whether the issue is closed to all but the board (decision 13).
 *
 * Offered only where it changes something: an issue whose type is the board's
 * alone is closed to everybody else already, and opening it again is not this
 * issue's to do. A handler who is not on the board sees only the tightening,
 * and is told that it closes the issue to them too.
 */
function AccessForm({
  issue,
  disabled,
  onSave,
}: {
  issue: QueuedIssue;
  disabled: boolean;
  onSave: (boardOnly: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  if (issue.typeHandledBy === "BOARD") {
    return <p className={HINT}>{t("issues.handling.typeBoardOnly")}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-11 items-center gap-2 text-small">
        <input
          type="checkbox"
          aria-label={t("issues.handling.boardOnlyNamed", {
            type: issue.typeName,
          })}
          checked={issue.boardOnly}
          disabled={disabled}
          onChange={(event) => {
            onSave(event.target.checked);
          }}
          className="size-4"
        />
        {t("issues.handling.boardOnly")}
      </label>
      <p className={HINT}>{t("issues.handling.boardOnlyHint")}</p>
    </div>
  );
}

/** What one step of the timeline says happened. */
function TimelineSentence({
  step,
  type,
}: {
  step: IssueTimelineStep;
  type: IssueTypeView | undefined;
}): ReactElement {
  const { t } = useTranslation();
  switch (step.kind) {
    case "reported":
      return <>{t("issues.timeline.reported")}</>;
    case "opened":
      return (
        <>
          {step.internal
            ? t("issues.timeline.openedInternal")
            : t("issues.timeline.openedForResident")}
        </>
      );
    case "status": {
      const label =
        type?.statuses.find((status) => status.id === step.toStatusId)?.label ??
        (step.toMeaning === null
          ? null
          : t(ISSUE_MEANING_LABEL[step.toMeaning]));
      return (
        <>
          {label === null
            ? t("issues.timeline.statusChanged")
            : t("issues.timeline.movedTo", { status: label })}
          {step.waitingReason === null
            ? null
            : ` ${t("issues.queue.waitingOn", {
                reason: t(ISSUE_WAITING_REASON_LABEL[step.waitingReason]),
              })}`}
          {step.outcome === null
            ? null
            : ` ${t("issues.queue.closedAs", {
                outcome: t(ISSUE_OUTCOME_LABEL[step.outcome]),
              })}`}
        </>
      );
    }
    case "assigned":
      return step.assignee === null ? (
        <>{t("issues.timeline.unassigned")}</>
      ) : (
        <>
          {step.byTypeDefault
            ? t("issues.timeline.assignedByDefault")
            : t("issues.timeline.assigned")}{" "}
          <IssueHandlerName handler={step.assignee} />
        </>
      );
    case "priority":
      return (
        <>
          {step.to === null
            ? t("issues.timeline.priorityChanged")
            : t("issues.timeline.priority", {
                priority: t(ISSUE_PRIORITY_LABEL[step.to]),
              })}
        </>
      );
    case "targetDate":
      return (
        <>
          {step.to === null ? (
            t("issues.timeline.targetDateRemoved")
          ) : (
            <Trans
              i18nKey="issues.timeline.targetDate"
              values={{ date: step.to }}
              components={DATA_TAGS}
            />
          )}
        </>
      );
    case "access":
      return (
        <>
          {step.boardOnly
            ? t("issues.timeline.boardOnly")
            : t("issues.timeline.everyHandler")}
        </>
      );
    case "redacted":
      return (
        <>
          {t(
            step.target === null
              ? "issues.timeline.redacted.unknown"
              : REDACTED_STEP[step.target],
          )}
        </>
      );
    case "legalHold":
      return (
        <>
          {step.held
            ? t("issues.timeline.legalHoldPlaced")
            : t("issues.timeline.legalHoldReleased")}
        </>
      );
  }
}

/** What a removal on the timeline reached. */
const REDACTED_STEP: Readonly<Record<IssueRedactionTarget, TranslationKey>> = {
  description: "issues.timeline.redacted.description",
  location: "issues.timeline.redacted.location",
  message: "issues.timeline.redacted.message",
  note: "issues.timeline.redacted.note",
  photo: "issues.timeline.redacted.photo",
  attachment: "issues.timeline.redacted.attachment",
};
