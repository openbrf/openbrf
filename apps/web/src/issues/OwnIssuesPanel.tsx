import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { OwnIssue } from "../api/issues";
import { localDayOfInstant } from "../bookings/booking-calendar";
import { NotRecorded } from "../ui/NotRecorded";
import { Panel } from "../ui/Panel";
import { IssueDescription, IssueLocation } from "./IssueFreeText";
import { IssueStatusChip } from "./IssueStatusChip";
import { OwnIssueConversation } from "./OwnIssueConversation";

export interface OwnIssuesPanelProps {
  issues: readonly OwnIssue[];
  /**
   * Told when a report changed under the reader - it turned out to be closed,
   * or a reply reopened it - so the list is read again.
   */
  onChanged: () => void;
  /** Told when the reporter asks for a new report following up a closed one. */
  onFollowUp: (issue: OwnIssue, refusedReply: string) => void;
}

/**
 * What this account has reported.
 *
 * A reporter follows their report and talks with whoever handles it in its
 * conversation, and moving it between states is the job of whoever handles
 * issues. Without that separation the queue would be a list of what residents
 * thought was done rather than of what was.
 */
export function OwnIssuesPanel({
  issues,
  onChanged,
  onFollowUp,
}: OwnIssuesPanelProps): ReactElement {
  const { t } = useTranslation();

  return (
    <Panel
      title={t("issues.mine.title")}
      description={t("issues.mine.description")}
    >
      {issues.length === 0 ? (
        <p className="text-body text-ink-muted">{t("issues.mine.empty")}</p>
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
                <IssueStatusChip meaning={issue.meaning} />
                <span className="ml-auto font-data text-data text-ink-muted">
                  {localDayOfInstant(issue.createdAt)}
                </span>
              </div>

              {/* A duplicate's reporter follows the issue it was merged
                  into, by where it stands and nothing else of it. */}
              {issue.mergedIntoMeaning === null ? null : (
                <p className="flex flex-wrap items-center gap-2 text-small">
                  <span>{t("issues.mine.merged")}</span>
                  <IssueStatusChip meaning={issue.mergedIntoMeaning} />
                </p>
              )}

              <IssueDescription issue={issue} />

              <p className="flex flex-wrap gap-4 text-small text-ink-muted">
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
                  {t("issues.mine.place")} <IssueLocation issue={issue} />
                </span>
                {/* Told that a handler entered it, never which one: who
                    works an issue is internal (ADR 0054). */}
                {issue.enteredByHandler ? (
                  <span>{t("issues.mine.enteredByHandler")}</span>
                ) : null}
              </p>

              {issue.photos.length === 0 ? null : (
                <ul className="flex flex-wrap gap-2">
                  {issue.photos.map((photo) => (
                    <li key={photo.id}>
                      {/* Content, not decoration: the reporter has to be able
                          to tell which photographs their report carries. */}
                      <img
                        src={photo.url}
                        alt={t("issues.photos.alt", { name: photo.fileName })}
                        className="size-20 rounded-control border border-line object-cover"
                      />
                    </li>
                  ))}
                </ul>
              )}

              <OwnIssueConversation
                issue={issue}
                onChanged={onChanged}
                onFollowUp={(refusedReply) => {
                  onFollowUp(issue, refusedReply);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
