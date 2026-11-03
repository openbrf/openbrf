import {
  ISSUE_CLOSING_OUTCOMES,
  ISSUE_STATUS_MEANINGS,
  ISSUE_WAITING_REASONS,
  type IssueClosingOutcome,
  type IssueWaitingReason,
} from "@openbrf/shared";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type IssueReporter,
  type IssueStatusMoveInput,
  type IssueTypeView,
  type QueuedIssue,
  setIssueStatus,
} from "../api/issues";
import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, LABEL, SECONDARY_BUTTON } from "../ui/controls";
import { NotRecorded } from "../ui/NotRecorded";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import {
  ISSUE_MEANING_LABEL,
  ISSUE_OUTCOME_LABEL,
  ISSUE_WAITING_REASON_LABEL,
} from "./issue-labels";
import { IssueHandlerName } from "./IssueHandlerName";
import { IssueConversation } from "./IssueConversation";
import { IssueHandling } from "./IssueHandling";
import { IssuePriorityChip } from "./IssuePriorityChip";
import { IssueStatusChip } from "./IssueStatusChip";

const QUEUE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.queue.errors.issueNotFound",
  "status-not-found": "issues.queue.errors.statusNotFound",
  "waiting-reason-required": "issues.queue.errors.waitingReasonRequired",
  "outcome-required": "issues.queue.errors.outcomeRequired",
  "status-detail-not-applicable":
    "issues.queue.errors.statusDetailNotApplicable",
  "invalid-body": "issues.queue.errors.unknown",
};

/**
 * The refusals that mean the queue on screen is out of date: the issue is gone,
 * or the status was switched off since the types were read. The queue is read
 * again, as their messages say.
 */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-not-found",
  "status-not-found",
]);

export interface IssueQueuePanelProps {
  issues: readonly QueuedIssue[];
  /**
   * Every type with its statuses, which is what an issue is moved between, or
   * null when they could not be read. Without them no issue can be moved, and
   * the panel says so rather than offering a form that has nothing to offer.
   */
  types: readonly IssueTypeView[] | null;
  /** Called after a status change, so the caller can reload the queue. */
  onChanged: () => void;
  /**
   * Whether the reader holds `memberCharges:manage`, so an open issue shows
   * the charges made from it. Courtesy only: the API refuses the read without.
   */
  canManageCharges?: boolean;
}

/**
 * The triage queue, for whoever handles issues.
 *
 * Each row shows the status as the board named it, in the tone of its meaning,
 * and offers the type's statuses to move it to (ADR 0054). A status that means
 * waiting asks whom or what for, and closing asks how the issue ended: both are
 * required by the server, and the form asks for them before it lets the save
 * go rather than after a refusal.
 *
 * Each row says who the issue is given to, how urgent it is and the day it is
 * meant to be done by, and stands out once that day has passed (decision 10);
 * the handling itself, and the timeline, open under the row.
 *
 * A reporter with protected personal data is rendered without their name or
 * their apartment. The board's own address book prints both because a statutory
 * register has to; this queue is read by an external property manager and has
 * no such reason, and the server sends neither. The apartment says it is
 * withheld rather than not recorded, which would tell the handler something
 * false about the report.
 */
export function IssueQueuePanel({
  issues,
  types,
  onChanged,
  canManageCharges = false,
}: IssueQueuePanelProps): ReactElement {
  const { t } = useTranslation();
  const move = useSaveAction(setIssueStatus, onChanged, (failure) => {
    if (STALE_REASONS.has(failure.reason)) {
      onChanged();
    }
  });
  /*
   * Which row the save in flight belongs to.
   *
   * One action serves the whole panel, so without this every row reads the same
   * save state and one click puts "saving" on every button in the queue. The
   * forms stay disabled together on purpose: only one status change should be
   * in flight before the queue reloads.
   */
  const [actingOn, setActingOn] = useState<string | null>(null);
  const saving = move.state.kind === "saving";
  const typeById = new Map((types ?? []).map((type) => [type.id, type]));

  return (
    <Panel
      title={t("issues.queue.title")}
      description={t("issues.queue.description")}
      notice={
        move.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                move.state.failure,
                QUEUE_FAILURES,
                "issues.queue.errors.unknown",
              ),
            )}
          </Notice>
        ) : types === null ? (
          <Notice tone="danger" live>
            {t("issues.queue.statusesUnavailable")}
          </Notice>
        ) : null
      }
    >
      {issues.length === 0 ? (
        <p className="text-body text-ink-muted">{t("issues.queue.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {issues.map((issue) => {
            const type = typeById.get(issue.typeId);
            return (
              <li
                key={issue.id}
                className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-body font-semibold">
                    {issue.typeName}
                  </span>
                  <IssueStatusChip
                    meaning={issue.meaning}
                    label={issue.status.label}
                  />
                  <IssuePriorityChip priority={issue.priority} />
                  {issue.boardOnly || issue.typeHandledBy === "BOARD" ? (
                    <span className="text-small text-ink-muted">
                      {t("issues.queue.boardOnly")}
                    </span>
                  ) : null}
                  <StatusDetail issue={issue} />
                  <span className="ml-auto font-data text-data text-ink-muted">
                    {localDayOfInstant(issue.createdAt)}
                  </span>
                </div>

                <p className="text-small whitespace-pre-line">
                  {issue.description}
                </p>

                <p className="flex flex-wrap gap-4 text-small text-ink-muted">
                  <span>
                    {t("issues.queue.reporter")}{" "}
                    <Reporter reporter={issue.reporter} />
                  </span>
                  <span>
                    {t("issues.mine.apartment")}{" "}
                    {issue.reporter.kind === "protected" ? (
                      <span>{t("issues.queue.apartmentProtected")}</span>
                    ) : issue.apartment === null ? (
                      <NotRecorded meaning={t("issues.mine.noApartment")} />
                    ) : (
                      <span className="font-data text-data">
                        {issue.apartment.address} {issue.apartment.number}
                      </span>
                    )}
                  </span>
                  <span>
                    {t("issues.mine.place")}{" "}
                    {issue.location === null ? (
                      <NotRecorded meaning={t("issues.mine.noPlace")} />
                    ) : (
                      issue.location
                    )}
                  </span>
                </p>

                <p className="flex flex-wrap gap-4 text-small text-ink-muted">
                  <span>
                    {t("issues.queue.assignee")}{" "}
                    {issue.assignee === null ? (
                      <span className="text-ink">
                        {t("issues.handling.unassigned")}
                      </span>
                    ) : (
                      <span className="text-ink">
                        <IssueHandlerName handler={issue.assignee} />
                      </span>
                    )}
                  </span>
                  {issue.targetDate === null ? null : (
                    <span>
                      {t("issues.queue.targetDate")}{" "}
                      <span
                        className={`font-data text-data ${issue.overdue ? "font-semibold text-danger" : "text-ink"}`}
                      >
                        {issue.targetDate}
                      </span>
                      {issue.overdue ? (
                        <span className="font-semibold text-danger">
                          {" "}
                          {t("issues.queue.overdue")}
                        </span>
                      ) : null}
                    </span>
                  )}
                  {issue.enteredBy === null ? null : (
                    <span>
                      {t("issues.queue.enteredBy")}{" "}
                      <IssueHandlerName handler={issue.enteredBy} />
                    </span>
                  )}
                </p>

                {issue.photos.length === 0 ? null : (
                  <ul className="flex flex-wrap gap-2">
                    {issue.photos.map((photo) => (
                      <li key={photo.id}>
                        {/* Content, not decoration: the photograph is the
                            substance of the report, so a handler reading the
                            queue by ear is told one is attached and which. */}
                        <img
                          src={photo.url}
                          alt={t("issues.photos.alt", { name: photo.fileName })}
                          className="size-20 rounded-control border border-line object-cover"
                        />
                      </li>
                    ))}
                  </ul>
                )}

                {type === undefined ? null : (
                  <StatusForm
                    // A new draft whenever the issue moves, so a form never
                    // offers to save a change the queue has already made.
                    key={`${issue.status.id}:${issue.waitingReason ?? ""}`}
                    issue={issue}
                    type={type}
                    disabled={saving}
                    saving={saving && actingOn === issue.id}
                    onDraftChanged={() => {
                      if (move.state.kind === "failed") {
                        move.reset();
                      }
                    }}
                    onSave={(input) => {
                      setActingOn(issue.id);
                      void move.submit(input);
                    }}
                  />
                )}

                <HandlingDisclosure
                  issue={issue}
                  type={type}
                  canManageCharges={canManageCharges}
                  onChanged={onChanged}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The handling of one issue, its timeline and its conversation, under a
 * disclosure: read only while it is open, because each open issue reads its
 * handlers, its timeline, its messages, notes and files, and a queue of fifty
 * would otherwise read hundreds of times on load.
 */
function HandlingDisclosure({
  issue,
  type,
  canManageCharges,
  onChanged,
}: {
  issue: QueuedIssue;
  type: IssueTypeView | undefined;
  canManageCharges: boolean;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="flex flex-col gap-3"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-small font-semibold">
        {t("issues.handling.open", { type: issue.typeName })}
      </summary>
      {open ? (
        <div className="flex flex-col gap-6 pt-2">
          <IssueHandling
            issue={issue}
            type={type}
            canManageCharges={canManageCharges}
            onChanged={onChanged}
          />
          <IssueConversation issue={issue} onStale={onChanged} />
        </div>
      ) : null}
    </details>
  );
}

/** Whom an issue waits on, or how it ended, beside its status. */
function StatusDetail({ issue }: { issue: QueuedIssue }): ReactElement | null {
  const { t } = useTranslation();
  if (issue.meaning === "WAITING" && issue.waitingReason !== null) {
    return (
      <span className="text-small text-ink-muted">
        {t("issues.queue.waitingOn", {
          reason: t(ISSUE_WAITING_REASON_LABEL[issue.waitingReason]),
        })}
      </span>
    );
  }
  if (issue.meaning === "DONE") {
    return (
      <span className="text-small text-ink-muted">
        {issue.outcome === null
          ? t("issues.queue.noOutcome")
          : t("issues.queue.closedAs", {
              outcome: t(ISSUE_OUTCOME_LABEL[issue.outcome]),
            })}
      </span>
    );
  }
  return null;
}

/**
 * The move of one issue to another of its type's statuses.
 *
 * Offers the type's statuses that are switched on, and the one the issue
 * stands in even if the board has since switched it off, grouped by meaning.
 * Save is offered only for a real change that carries what its meaning
 * requires.
 */
function StatusForm({
  issue,
  type,
  disabled,
  saving,
  onDraftChanged,
  onSave,
}: {
  issue: QueuedIssue;
  type: IssueTypeView;
  disabled: boolean;
  saving: boolean;
  onDraftChanged: () => void;
  onSave: (input: IssueStatusMoveInput) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [statusId, setStatusId] = useState(issue.status.id);
  const [waitingReason, setWaitingReason] = useState<IssueWaitingReason | "">(
    issue.waitingReason ?? "",
  );
  const [outcome, setOutcome] = useState<IssueClosingOutcome | "">("");

  const offered = type.statuses.filter(
    (status) => status.active || status.id === issue.status.id,
  );
  const target = offered.find((status) => status.id === statusId);
  const meaning = target?.meaning ?? issue.meaning;
  const asksReason = meaning === "WAITING";
  const asksOutcome = meaning === "DONE" && issue.meaning !== "DONE";

  const changed =
    statusId !== issue.status.id ||
    (asksReason && waitingReason !== (issue.waitingReason ?? ""));
  const complete =
    target !== undefined &&
    (!asksReason || waitingReason !== "") &&
    (!asksOutcome || outcome !== "");

  const day = localDayOfInstant(issue.createdAt);
  const named = { type: issue.typeName, day };

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || !complete) {
          return;
        }
        onSave({
          issueId: issue.id,
          statusId,
          ...(asksReason && waitingReason !== "" ? { waitingReason } : {}),
          ...(asksOutcome && outcome !== "" ? { outcome } : {}),
        });
      }}
    >
      <label className={`${LABEL} min-w-48`}>
        {t("issues.queue.status")}
        <select
          aria-label={t("issues.queue.statusNamed", named)}
          value={statusId}
          disabled={disabled}
          onChange={(event) => {
            setStatusId(event.target.value);
            onDraftChanged();
          }}
          className={FIELD}
        >
          {ISSUE_STATUS_MEANINGS.map((group) => {
            const statuses = offered.filter(
              (status) => status.meaning === group,
            );
            return statuses.length === 0 ? null : (
              <optgroup key={group} label={t(ISSUE_MEANING_LABEL[group])}>
                {statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.label}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </label>

      {asksReason ? (
        <label className={`${LABEL} min-w-40`}>
          {t("issues.queue.waitingFor")}
          <select
            aria-label={t("issues.queue.waitingForNamed", named)}
            required
            value={waitingReason}
            disabled={disabled}
            onChange={(event) => {
              setWaitingReason(event.target.value as IssueWaitingReason | "");
              onDraftChanged();
            }}
            className={FIELD}
          >
            <option value="">{t("issues.queue.choose")}</option>
            {ISSUE_WAITING_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {t(ISSUE_WAITING_REASON_LABEL[reason])}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {asksOutcome ? (
        <label className={`${LABEL} min-w-48`}>
          {t("issues.queue.outcome")}
          <select
            aria-label={t("issues.queue.outcomeNamed", named)}
            required
            value={outcome}
            disabled={disabled}
            onChange={(event) => {
              setOutcome(event.target.value as IssueClosingOutcome | "");
              onDraftChanged();
            }}
            className={FIELD}
          >
            <option value="">{t("issues.queue.choose")}</option>
            {ISSUE_CLOSING_OUTCOMES.map((closing) => (
              <option key={closing} value={closing}>
                {t(ISSUE_OUTCOME_LABEL[closing])}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <button
        type="submit"
        disabled={disabled || !changed || !complete}
        className={SECONDARY_BUTTON}
      >
        {saving ? t("issues.queue.saving") : t("issues.queue.move")}
      </button>

      {/*
        Closing an issue as the tenant-owner's responsibility is the formal
        step decision 27 names: a reply on the issue after it is not how the
        association asks for something to be put right under BRL 7 kap. 12 a §.
      */}
      {asksOutcome && outcome === "TENANT_OWNER_RESPONSIBILITY" ? (
        <div className="basis-full">
          <Notice tone="info">{t("issues.handling.notANoticeToRemedy")}</Notice>
        </div>
      ) : null}
    </form>
  );
}

/** Who reported it, in the four shapes the server can answer with. */
function Reporter({ reporter }: { reporter: IssueReporter }): ReactElement {
  const { t } = useTranslation();

  if (reporter.kind === "resident") {
    return <span>{reporter.name}</span>;
  }
  if (reporter.kind === "protected") {
    return <span>{t("issues.queue.reporterProtected")}</span>;
  }
  if (reporter.kind === "external") {
    return (
      <span>
        {reporter.name ?? t("issues.queue.reporterExternal")}
        {reporter.email === null ? null : ` ${reporter.email}`}
      </span>
    );
  }
  return <span>{t("issues.queue.reporterUnknown")}</span>;
}
