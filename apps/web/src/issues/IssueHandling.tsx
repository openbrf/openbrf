import {
  ISSUE_COST_RESPONSIBILITIES,
  ISSUE_PRIORITIES,
  type IssueCostResponsibility,
  type IssuePriority,
  type IssueRedactionTarget,
} from "@openbrf/shared";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import {
  assignIssue,
  fetchHandlerResponsibilityGuide,
  fetchIssueHandlers,
  fetchIssueTimeline,
  type IssueHandler,
  type IssueTimelineStep,
  type IssueTypeView,
  type QueuedIssue,
  type ResponsibilityGuide,
  setIssueBoardOnly,
  setIssueCostResponsibility,
  setIssuePriority,
  setIssueTargetDate,
} from "../api/issues";
import { type ChargeRow, fetchIssueCharges } from "../charges/charges-api";
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
import { usePoll } from "../ui/use-poll";
import {
  ISSUE_COST_RESPONSIBILITY_LABEL,
  ISSUE_MEANING_LABEL,
  ISSUE_OUTCOME_LABEL,
  ISSUE_PRIORITY_LABEL,
  ISSUE_WAITING_REASON_LABEL,
} from "./issue-labels";
import { IssueFitHandling } from "./IssueFitHandling";
import { IssueHandlerName, issueHandlerName } from "./IssueHandlerName";
import { ResponsibilityGuideTable } from "./ResponsibilityGuideTable";

/** How often the timeline is read again while a work order's mail is on its way. */
const WORK_ORDER_POLL_MS = 4000;

const HANDLING_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.handling.errors.issueNotFound",
  "assignee-not-a-handler": "issues.handling.errors.assigneeNotAHandler",
  "date-invalid": "issues.handling.errors.targetDateInvalid",
  // An issue marked as a finding keeps a target date, and a lift's within a
  // month of its inspection; this form is where a handler clears or moves it.
  "finding-needs-target-date": "issues.fit.errors.findingNeedsTargetDate",
  "finding-target-date-too-late": "issues.fit.errors.findingTargetDateTooLate",
  "invalid-body": "issues.handling.errors.unknown",
};

/** The refusals that mean the issue on screen is out of date. */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-not-found",
  "assignee-not-a-handler",
]);

/** One act on an issue's handling, so the five share one save in flight. */
type HandlingAct =
  | { kind: "assignee"; assigneePersonId: string | null }
  | { kind: "priority"; priority: IssuePriority }
  | { kind: "targetDate"; targetDate: string | null }
  | { kind: "access"; boardOnly: boolean }
  | {
      kind: "costResponsibility";
      costResponsibility: IssueCostResponsibility | null;
    };

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
    case "costResponsibility":
      return setIssueCostResponsibility({
        issueId,
        costResponsibility: act.costResponsibility,
      });
  }
}

/** The handler's identifier, or "" for nobody and for a purged handler. */
function personIdOf(handler: IssueHandler | null): string {
  return handler === null || handler.kind === "unknown" ? "" : handler.personId;
}

/**
 * Handling one issue (ADR 0054): who it is given to, how urgent it is, the day
 * it is meant to be done by, who pays, and whether it is closed to all but the
 * board - with its timeline under them.
 *
 * Who pays sits beside the association's responsibility guide, which is what
 * a handler decides it from (decision 27), and beside the charges made from
 * the issue for a reader who may read charges (decision 26). That reader is
 * the only one shown an amount: the issue itself carries none, and the
 * charges are read from the charges module under its own capability, which
 * the property manager does not hold - so the panel does not ask.
 *
 * Mounted only while a handler has the issue open, because it reads two things
 * of its own: the people the issue may be assigned to, a names-only read that
 * is not the address book, and the timeline. One save in flight for the whole
 * panel, as the queue has one for status moves; every save reads the queue
 * again, and with it this panel's drafts, which are keyed to the issue's
 * values so a draft never offers to save what the queue already holds.
 *
 * A work order's step says how its mail stands, which the mail worker changes
 * after the handler sent it. So the timeline is read again whenever a work
 * order is sent from the issue beside it (`workOrdersSent`), and every few
 * seconds while a step still says the mail is on its way, the way the work
 * orders' own record is.
 */
export function IssueHandling({
  issue,
  type,
  workOrdersSent,
  canManageCharges = false,
  filesRevision = 0,
  onChanged,
}: {
  issue: QueuedIssue;
  /** The issue's type, for the board's names of the statuses on the timeline. */
  type: IssueTypeView | undefined;
  /** How many work orders were sent from this issue while the queue was open. */
  workOrdersSent: number;
  /**
   * Whether the reader holds `memberCharges:manage`, which decides whether the
   * charges made from the issue are read at all. Courtesy only: the API
   * refuses the read without it.
   */
  canManageCharges?: boolean;
  /**
   * Changes when a file is added to or removed from the issue beside this
   * panel, which the finding's protocol list reads again on.
   */
  filesRevision?: number;
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

  /*
   * Counts the main read's starts and finishes. A timeline poll notes the count
   * when it asks and drops its answer if the count has moved, so an answer asked
   * before the main read began or finished never lands over what that read
   * showed: a read that began is newer than the poll, and one that finished has
   * already shown steps the poll's answer may predate. A start also covers a
   * save, a newer revision or a sending, each of which starts a read.
   */
  const mainReadEpoch = useRef(0);

  useEffect(() => {
    let active = true;
    mainReadEpoch.current += 1;
    void Promise.all([
      fetchIssueHandlers(issue.id),
      fetchIssueTimeline(issue.id),
    ]).then(([handlerRead, timelineRead]) => {
      if (!active) {
        return;
      }
      mainReadEpoch.current += 1;
      setHandlers(handlerRead.ok ? handlerRead.value : null);
      setTimeline(timelineRead.ok ? timelineRead.value : null);
      setReadFailed(!handlerRead.ok || !timelineRead.ok);
    });
    return () => {
      active = false;
    };
  }, [issue.id, revision, reads, workOrdersSent]);

  /*
   * The timeline alone, and only while a work order's mail is on its way. Each
   * answer is matched to the main read's count when it was asked, so one that a
   * read has since started or finished is dropped; a failed attempt keeps what
   * is shown, and the next attempt asks again.
   */
  const mailPending =
    timeline?.some(
      (step) => step.kind === "workOrder" && step.delivery === "pending",
    ) ?? false;
  usePoll(
    async (stillWanted) => {
      const askedUnder = mainReadEpoch.current;
      const timelineRead = await fetchIssueTimeline(issue.id);
      if (
        stillWanted() &&
        timelineRead.ok &&
        askedUnder === mainReadEpoch.current
      ) {
        setTimeline(timelineRead.value);
      }
    },
    { intervalMs: WORK_ORDER_POLL_MS, enabled: mailPending },
  );

  const guide = useHandlerGuide(issue);

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

      {/* A save there writes a timeline step too, and taking a finding off
        moves neither the revision nor the status: the timeline is read
        again here, as after a save of this panel's own. */}
      <IssueFitHandling
        issue={issue}
        filesRevision={filesRevision}
        onChanged={() => {
          setReads((count) => count + 1);
          onChanged();
        }}
      />

      <section className="flex flex-col gap-2">
        <ChoiceForm
          key={`cost:${issue.costResponsibility ?? ""}`}
          label={t("issues.handling.costResponsibility")}
          ariaLabel={t("issues.handling.costResponsibilityNamed", named)}
          initial={issue.costResponsibility ?? ""}
          disabled={busy}
          saving={busy}
          onDraftChanged={onDraftChanged}
          options={[
            { value: "", label: t("issues.handling.costResponsibilityUnset") },
            ...ISSUE_COST_RESPONSIBILITIES.map((value) => ({
              value,
              label: t(ISSUE_COST_RESPONSIBILITY_LABEL[value]),
            })),
          ]}
          onSave={(value) => {
            void save.submit({
              kind: "costResponsibility",
              costResponsibility:
                value === "" ? null : (value as IssueCostResponsibility),
            });
          }}
        />
        {/*
          At the formal step and not before it: once a handler says the cost
          is the tenant-owner's, the next thing the board may want is for them
          to put it right, and a reply here is not how BRL 7 kap. 12 a § asks
          for that. It stays on an issue closed with that outcome, because the
          reply field stays with it.
        */}
        {issue.costResponsibility === "TENANT_OWNER" ||
        issue.outcome === "TENANT_OWNER_RESPONSIBILITY" ? (
          <Notice tone="info">{t("issues.handling.notANoticeToRemedy")}</Notice>
        ) : null}
        <details className="flex flex-col gap-2">
          <summary className="min-h-11 cursor-pointer py-2 text-small font-semibold">
            {t("issues.guide.title")}
          </summary>
          {guide === "failed" ? (
            <p className={HINT}>{t("issues.guide.loadFailed")}</p>
          ) : guide === null ? null : (
            <ResponsibilityGuideTable
              guide={guide}
              caption={t("issues.guide.title")}
            />
          )}
        </details>
      </section>

      {canManageCharges ? <IssueCharges issue={issue} /> : null}

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

/**
 * The responsibility guide as a handler reads it, adopted or not.
 *
 * Read again whenever the queue brings the issue again - `issue` is a new
 * object with every read of the queue and the same one between them - so a
 * guide the board has changed since the panel opened reaches a handler who
 * keeps it open, and a handler does not choose who pays from superseded
 * guidance. The last guide stays on screen while the next is read; a read
 * that fails replaces it with the failure, because the guide on screen can no
 * longer be said to be the board's current one.
 */
function useHandlerGuide(
  issue: QueuedIssue,
): ResponsibilityGuide | "failed" | null {
  const [guide, setGuide] = useState<ResponsibilityGuide | "failed" | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    void fetchHandlerResponsibilityGuide().then((read) => {
      if (!active) {
        return;
      }
      setGuide(read.ok ? read.value : "failed");
    });
    return () => {
      active = false;
    };
  }, [issue]);
  return guide;
}

/**
 * The charges made from the issue, with their amounts, and the way to make
 * another ("Skapa debitering", decision 26).
 *
 * Mounted only for a reader who may read charges. Read again whenever the
 * queue is read - `issue` is a new object with every read of the queue and the
 * same one between them - so a charge made in another tab shows, and charges
 * withheld because the reporter has become protected stop being shown, without
 * closing the panel; an answer for an earlier read is dropped. Making one
 * opens the charges screen with the form filled in from the issue, where the
 * amount is entered and where it lives.
 */
function IssueCharges({ issue }: { issue: QueuedIssue }): ReactElement {
  const { t } = useTranslation();
  /** The last answer, with the issue it answered for. */
  const [read, setRead] = useState<{
    issueId: string;
    /** Null where the API withholds them: the reporter is protected. */
    charges: ChargeRow[] | null | "failed";
  } | null>(null);

  useEffect(() => {
    let active = true;
    void fetchIssueCharges(issue.id).then((answer) => {
      if (active) {
        setRead({
          issueId: issue.id,
          charges: answer.ok ? answer.value.charges : "failed",
        });
      }
    });
    return () => {
      active = false;
    };
  }, [issue]);

  /*
   * Another issue's answer is never shown under this one. The same issue's
   * last answer stays while a newer revision is read, rather than flashing
   * back to "reading".
   */
  const charges = read?.issueId === issue.id ? read.charges : "reading";

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.charges.title")}
      </h3>
      {charges === "reading" ? (
        <p role="status" className={HINT}>
          {t("issues.charges.loading")}
        </p>
      ) : charges === "failed" ? (
        <p className={HINT}>{t("issues.charges.loadFailed")}</p>
      ) : charges === null ? (
        <p className={HINT}>{t("issues.charges.withheld")}</p>
      ) : charges.length === 0 ? (
        <p className={HINT}>{t("issues.charges.none")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {charges.map((charge) => (
            <li
              key={charge.chargeId}
              className="flex flex-wrap gap-x-3 text-small"
            >
              <span className="font-data text-data text-ink-muted">
                {charge.chargedOn}
              </span>
              <span>{charge.reason}</span>
              <span>
                <Trans
                  i18nKey="issues.charges.amount"
                  values={{ amount: charge.amount }}
                  components={DATA_TAGS}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={HINT}>{t("issues.charges.hint")}</p>
      <div>
        <Link
          to="/board/charges"
          search={{ issue: issue.id }}
          aria-label={t("issues.charges.createNamed", { type: issue.typeName })}
          className={`${SECONDARY_BUTTON} inline-flex items-center`}
        >
          {t("issues.charges.create")}
        </Link>
      </div>
    </section>
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

/** What a work order's step says, by how its mail stands. */
const WORK_ORDER_STEP_LABELS = {
  written: "issues.timeline.workOrder.written",
  pending: "issues.timeline.workOrder.pending",
  sent: "issues.timeline.workOrder.sent",
  failed: "issues.timeline.workOrder.failed",
  unconfirmed: "issues.timeline.workOrder.unconfirmed",
} as const;

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
          {step.byReporter ? ` ${t("issues.timeline.byReporterReply")}` : null}
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
    case "knownFault":
      return (
        <>
          {step.published
            ? t("issues.timeline.knownFaultPublished")
            : t("issues.timeline.knownFaultWithdrawn")}
        </>
      );
    case "place":
      return (
        <>
          {step.placeId === null
            ? t("issues.timeline.placeRemoved")
            : t("issues.timeline.placeSet")}
        </>
      );
    case "entry":
      return (
        <>
          {step.answer === null
            ? t("issues.timeline.entryWithdrawn")
            : step.byReporter
              ? t("issues.timeline.entryAnsweredByResident", {
                  answer: t(
                    step.answer === "YES"
                      ? "issues.entry.answerYes"
                      : "issues.entry.answerNo",
                  ),
                })
              : t("issues.timeline.entryRecorded", {
                  answer: t(
                    step.answer === "YES"
                      ? "issues.entry.answerYes"
                      : "issues.entry.answerNo",
                  ),
                })}
        </>
      );
    case "finding":
      return (
        <>
          {step.findingKind === null
            ? t("issues.timeline.findingRemoved")
            : t("issues.timeline.findingMarked", {
                kind: t(`issues.fit.finding.kinds.${step.findingKind}`),
              })}
        </>
      );
    case "workOrder":
      return <>{t(WORK_ORDER_STEP_LABELS[step.delivery ?? "written"])}</>;
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
    case "costResponsibility":
      return (
        <>
          {step.to === null
            ? t("issues.timeline.costResponsibilityRemoved")
            : t("issues.timeline.costResponsibility", {
                who: t(ISSUE_COST_RESPONSIBILITY_LABEL[step.to]),
              })}
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
  workOrder: "issues.timeline.redacted.workOrder",
};
