import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { OwnIssue } from "../api/issues";
import { NotRecorded } from "../ui/NotRecorded";
import { Panel } from "../ui/Panel";
import { IssueStatusChip } from "./IssueStatusChip";

export interface OwnIssuesPanelProps {
  issues: readonly OwnIssue[];
}

/**
 * What this account has reported.
 *
 * Read-only: a reporter follows their report, and moving it between states is
 * the job of whoever handles issues. Without that separation the queue would be
 * a list of what residents thought was done rather than of what was.
 */
export function OwnIssuesPanel({ issues }: OwnIssuesPanelProps): ReactElement {
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
                <IssueStatusChip status={issue.status} />
                <span className="ml-auto font-data text-data text-ink-muted">
                  {issue.createdAt.slice(0, 10)}
                </span>
              </div>

              <p className="text-small whitespace-pre-line">
                {issue.description}
              </p>

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
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
