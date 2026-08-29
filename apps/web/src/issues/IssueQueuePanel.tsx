import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type IssueReporter,
  type IssueStatus,
  type QueuedIssue,
  setIssueStatus,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import { QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { NotRecorded } from "../ui/NotRecorded";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { IssueStatusChip } from "./IssueStatusChip";

const QUEUE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.queue.errors.issueNotFound",
  "invalid-body": "issues.queue.errors.unknown",
};

const AUDIENCE_LABEL: Readonly<
  Record<QueuedIssue["audience"], TranslationKey>
> = {
  NON_MEMBER: "issues.audience.NON_MEMBER",
  MEMBER: "issues.audience.MEMBER",
  BOARD: "issues.audience.BOARD",
};

export interface IssueQueuePanelProps {
  issues: readonly QueuedIssue[];
  /** Called after a status change, so the caller can reload the queue. */
  onChanged: () => void;
}

/**
 * The triage queue, for whoever handles issues.
 *
 * The three states are three buttons rather than a picker: the queue is worked
 * one row at a time and the next state is nearly always the obvious one, so
 * naming the act ("take it on", "mark as done") says more than a dropdown of
 * nouns would.
 *
 * A reporter with protected personal data is rendered without their name. The
 * board's own address book prints it because a statutory register has to; this
 * queue is read by an external property manager and has no such reason, and the
 * server does not send it either.
 */
export function IssueQueuePanel({
  issues,
  onChanged,
}: IssueQueuePanelProps): ReactElement {
  const { t } = useTranslation();
  const move = useSaveAction(setIssueStatus, onChanged);

  const next = (status: IssueStatus): IssueStatus =>
    status === "DONE" ? "NEW" : status === "NEW" ? "IN_PROGRESS" : "DONE";

  const actionKey = (status: IssueStatus): TranslationKey =>
    status === "DONE"
      ? "issues.queue.reopen"
      : status === "NEW"
        ? "issues.queue.setInProgress"
        : "issues.queue.setDone";

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
        ) : null
      }
    >
      {issues.length === 0 ? (
        <p className="text-body text-ink-muted">{t("issues.queue.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {issues.map((issue) => (
            <li
              key={issue.id}
              className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-body font-semibold">
                  {issue.typeName}
                </span>
                <IssueStatusChip status={issue.status} />
                <span className="text-chip text-ink-muted uppercase">
                  {t(AUDIENCE_LABEL[issue.audience])}
                </span>
                <span className="ml-auto font-data text-data text-ink-muted">
                  {issue.createdAt.slice(0, 10)}
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
                  {issue.apartment === null ? (
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

              {issue.photos.length === 0 ? null : (
                <ul className="flex flex-wrap gap-2">
                  {issue.photos.map((photo) => (
                    <li key={photo.id}>
                      <img
                        src={photo.url}
                        alt=""
                        role="presentation"
                        className="size-20 rounded-control border border-line object-cover"
                      />
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={move.state.kind === "saving"}
                  onClick={() => {
                    void move.submit({
                      issueId: issue.id,
                      status: next(issue.status),
                    });
                  }}
                  className={
                    issue.status === "DONE" ? QUIET_BUTTON : SECONDARY_BUTTON
                  }
                >
                  {move.state.kind === "saving"
                    ? t("issues.queue.saving")
                    : t(actionKey(issue.status))}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
