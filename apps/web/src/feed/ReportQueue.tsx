import { useEffect, useState, type ReactElement } from "react";
import type { PostReportView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { dismissReport, fetchReports, strikeReport } from "../api/feed";
import { HINT, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { authorLabel, writtenAt } from "./Author";
import { feedFailureKey } from "./feed-failures";
import { PostImages } from "./PostCard";

/**
 * What the board has been asked to look at.
 *
 * ## This is the whole of the board's way into a group
 *
 * A group is invisible to anybody who is not in it. There is no list of groups
 * on this screen or on any other, no count of them, and no way to open one: what
 * is here is the posts somebody inside a group chose to carry out, one at a
 * time, and each one arrives with the group's name so the board knows where it
 * was said.
 *
 * A board that has had no report reads an empty queue, which is also the whole
 * of what it can learn about whether this cooperative has any groups at all.
 *
 * ## Two answers and no third
 *
 * Struck through, or left standing. Striking withholds the text from the other
 * people in the group and from nobody else - the post stays where it is, its
 * author still reads it, and the retention clock is unchanged - and there is
 * deliberately no control that clears it. Leaving it standing closes the report
 * and changes nothing about the post.
 *
 * Both answers close every open report about that post, so the board decides
 * one post once.
 */
export function ReportQueue(): ReactElement {
  const { t, i18n } = useTranslation();

  const [reports, setReports] = useState<readonly PostReportView[] | null>(
    null,
  );
  /** Whether this account may answer a report, which a capability cannot say. */
  const [mayModerate, setMayModerate] = useState(true);
  const [failed, setFailed] = useState(false);
  /** Which report is being answered, so one row can say so while it happens. */
  const [answering, setAnswering] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;

    void (async () => {
      const result = await fetchReports();
      if (abandoned) {
        return;
      }
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setReports(result.value.reports);
      setMayModerate(result.value.mayModerate);
    })();

    return () => {
      abandoned = true;
    };
  }, []);

  /*
   * An answered report leaves the queue, and so does every other report about
   * the same post: the board decides about the post rather than about one
   * person's report of it, and the server closes them together. A sibling left
   * on the screen would be a row that answers `report-resolved` when pressed.
   *
   * Read back into the queue rather than re-fetched, because the queue is what
   * is open and a row that stayed with a decision on it would be a queue that
   * never empties.
   */
  const answered = (report: PostReportView): void => {
    setReports(
      (held) => held?.filter((each) => each.postId !== report.postId) ?? null,
    );
  };

  const strike = useSaveAction(strikeReport, answered);
  const dismiss = useSaveAction(dismissReport, answered);
  const busy =
    strike.state.kind === "saving" || dismiss.state.kind === "saving";
  const failure =
    strike.state.kind === "failed"
      ? strike.state.failure
      : dismiss.state.kind === "failed"
        ? dismiss.state.failure
        : null;

  if (failed) {
    return (
      <Panel title={t("feed.reports.title")}>
        <Notice tone="danger" live>
          {t("feed.reports.loadFailed")}
        </Notice>
      </Panel>
    );
  }

  if (!mayModerate) {
    /*
     * The instance's administrator, and the sentence is the point. They hold
     * every capability and no board seat, so the queue is not theirs - and an
     * empty queue would tell them that nothing has been reported, which is a
     * fact about groups they may not be told exist.
     */
    return (
      <Panel title={t("feed.reports.title")}>
        <Notice tone="info">{t("feed.reports.notTheBoard")}</Notice>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("feed.reports.title")}
      description={t("feed.reports.intro")}
      notice={
        failure === null ? null : (
          <Notice tone="danger" live>
            {t(feedFailureKey(failure))}
          </Notice>
        )
      }
    >
      {reports === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("feed.reports.reading")}
        </p>
      ) : reports.length === 0 ? (
        <p className="text-body text-ink-muted">{t("feed.reports.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {reports.map((report) => (
            <li
              key={report.reportId}
              className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-body font-semibold">
                  {report.groupName ?? t("feed.reports.unnamedGroup")}
                </span>
                <span className="ml-auto font-data text-data text-ink-muted">
                  <time dateTime={report.reportedAt}>
                    {writtenAt(report.reportedAt, i18n.language)}
                  </time>
                </span>
              </div>

              <p className={HINT}>
                {t("feed.reports.reportedBy", {
                  reporter: authorLabel(report.reporter, t),
                  author: authorLabel(report.author, t),
                })}
              </p>

              {report.note === null ? null : (
                <p className="text-body whitespace-pre-line">{report.note}</p>
              )}

              <blockquote className="flex flex-col gap-2 border-l-4 border-line pl-3">
                <p className="text-body whitespace-pre-line">{report.body}</p>
                <PostImages images={report.images} />
                <p className={HINT}>
                  <time dateTime={report.writtenAt}>
                    {writtenAt(report.writtenAt, i18n.language)}
                  </time>
                </p>
              </blockquote>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={QUIET_BUTTON}
                  disabled={busy}
                  onClick={() => {
                    setAnswering(report.reportId);
                    void strike
                      .submit({ reportId: report.reportId })
                      .finally(() => {
                        setAnswering(null);
                      });
                  }}
                >
                  {busy && answering === report.reportId
                    ? t("feed.reports.striking")
                    : t("feed.reports.strike")}
                </button>
                <button
                  type="button"
                  className={QUIET_BUTTON}
                  disabled={busy}
                  onClick={() => {
                    setAnswering(report.reportId);
                    void dismiss
                      .submit({ reportId: report.reportId })
                      .finally(() => {
                        setAnswering(null);
                      });
                  }}
                >
                  {t("feed.reports.dismiss")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className={HINT}>{t("feed.reports.hint")}</p>
    </Panel>
  );
}
