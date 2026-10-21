import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { PostReportView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { dismissReport, fetchReports, strikeReport } from "../api/feed";
import { HINT, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { audienceName } from "./AudiencePanel";
import { authorLabel, writtenAt } from "./Author";
import { feedFailureKey } from "./feed-failures";
import { PostImages } from "./PostCard";

/**
 * What the board has been asked to look at, oldest first, a page at a time.
 *
 * ## Alla, and the board's whole way into a group
 *
 * A report comes from Alla or out of a group, and carries one post or one
 * comment. From Alla it is a neighbour asking the board to look at something
 * it reads anyway, and the report links to the post. From a group it is the
 * only way in: a group is invisible to anybody who is not in it, so there is no
 * list of groups on this screen or on any other, no count of them, and no way
 * to open one. What is here is what somebody inside a group chose to carry
 * out, one post or one comment at a time, with the group's name so the board
 * knows where it was said - and for a comment, not the post it answers.
 *
 * A board that has had no report reads an empty queue, which is also the whole
 * of what it can learn about whether this cooperative has any groups at all.
 *
 * ## Paged forwards
 *
 * The queue is read fifty at a time from the oldest, and "Visa fler" reads the
 * page after the last one held, from the cursor the server answered with. A
 * report answered on screen leaves it without moving the next page: the cursor
 * names where the last page ended, not a position in a list that is getting
 * shorter.
 *
 * ## Two answers and no third
 *
 * Struck through, or left standing. Striking withholds the text from the rest of
 * the audience and from nobody else - it stays where it is, its author still
 * reads it, and the retention clock is unchanged - and there is deliberately no
 * control that clears it. Leaving it standing closes the report and changes
 * nothing.
 *
 * Both answers close every open report about the same post or comment, so the
 * board decides one thing once.
 */
export function ReportQueue(): ReactElement {
  const { t, i18n } = useTranslation();

  const [reports, setReports] = useState<readonly PostReportView[] | null>(
    null,
  );
  /** Where the page after the held ones starts, or null at the end. */
  const [next, setNext] = useState<string | null>(null);
  /** Whether this account may answer a report, which a capability cannot say. */
  const [mayModerate, setMayModerate] = useState(true);
  const [failed, setFailed] = useState(false);
  const [readingMore, setReadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  /** Which report is being answered, so one row can say so while it happens. */
  const [answering, setAnswering] = useState<string | null>(null);

  /*
   * What the board has answered on this screen, by what was reported. A page
   * read while an answer was on its way may still carry a sibling the server
   * has since closed; it is left out rather than shown as a row that answers
   * `report-resolved` when pressed.
   */
  const answeredSubjects = useRef(new Set<string>());
  /** Whether this screen is still the one that asked. */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // This read's own, so a read a remount superseded never lands.
    let abandoned = false;

    void (async () => {
      const result = await fetchReports({ after: null });
      if (abandoned) {
        return;
      }
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setReports(result.value.reports);
      setNext(result.value.next);
      setMayModerate(result.value.mayModerate);
    })();

    return () => {
      abandoned = true;
      mounted.current = false;
    };
  }, []);

  /*
   * The page after the held ones, appended. One read at a time: the button is
   * disabled while one is on its way, so two presses cannot ask for the same
   * page twice.
   */
  const readMore = async (after: string): Promise<void> => {
    setReadingMore(true);
    setMoreFailed(false);
    const result = await fetchReports({ after });
    if (!mounted.current) {
      return;
    }
    setReadingMore(false);
    if (!result.ok) {
      setMoreFailed(true);
      return;
    }
    setReports((held) => {
      const seen = new Set((held ?? []).map((each) => each.reportId));
      return [
        ...(held ?? []),
        ...result.value.reports.filter(
          (each) =>
            !seen.has(each.reportId) &&
            !answeredSubjects.current.has(subjectOf(each)),
        ),
      ];
    });
    setNext(result.value.next);
  };

  /*
   * An answered report leaves the queue, and so does every other report about
   * the same post or comment: the board decides about what was reported rather
   * than about one person's report of it, and the server closes them together.
   * A sibling left on the screen would be a row that answers `report-resolved`
   * when pressed.
   *
   * Taken out of the held queue rather than re-fetched, because the queue is
   * what is open and a row that stayed with a decision on it would be a queue
   * that never empties.
   */
  const answered = (report: PostReportView): void => {
    const subject = subjectOf(report);
    answeredSubjects.current.add(subject);
    setReports(
      (held) => held?.filter((each) => subjectOf(each) !== subject) ?? null,
    );
  };

  /*
   * An answer to a report somebody else settled first - another board member,
   * or this one striking the post from its card in the feed above - is refused,
   * and the row leaves the queue as an answered one does: it is no longer
   * open, and keeping it would offer a press that can only be refused again.
   * The refusal still says what happened.
   */
  const settling =
    (act: typeof strikeReport) =>
    async (report: PostReportView): ReturnType<typeof strikeReport> => {
      const result = await act({ reportId: report.reportId });
      if (
        !result.ok &&
        (result.failure.reason === "report-resolved" ||
          result.failure.reason === "report-not-found")
      ) {
        answered(report);
      }
      return result;
    };

  const strike = useSaveAction(settling(strikeReport), answered);
  const dismiss = useSaveAction(settling(dismissReport), answered);
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
      ) : reports.length === 0 && next === null ? (
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
                  {report.audienceKind === "GROUP" && report.groupName === null
                    ? t("feed.reports.unnamedGroup")
                    : audienceName(
                        { kind: report.audienceKind, name: report.groupName },
                        t,
                      )}
                </span>
                <span className="text-small text-ink-muted">
                  {report.commentId === null
                    ? t("feed.reports.aPost")
                    : t("feed.reports.aComment")}
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
                  <time
                    dateTime={report.writtenAt}
                    className="font-data text-data"
                  >
                    {writtenAt(report.writtenAt, i18n.language)}
                  </time>
                </p>
              </blockquote>

              {/*
               * The post in the feed, where the board reads it anyway: in Alla
               * only. Out of a group the report carries no address, and a
               * link would be one the board cannot open.
               */}
              {report.audienceKind === "ALL" && report.postId !== null ? (
                <Link
                  to="/feed/$postId"
                  params={{ postId: report.postId }}
                  className="inline-flex min-h-11 items-center self-start text-small underline"
                >
                  {t("feed.reports.openPost")}
                </Link>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={QUIET_BUTTON}
                  disabled={busy}
                  onClick={() => {
                    setAnswering(report.reportId);
                    void strike.submit(report).finally(() => {
                      setAnswering(null);
                    });
                  }}
                >
                  {busy && answering === report.reportId
                    ? t("feed.reports.striking")
                    : report.commentId === null
                      ? t("feed.reports.strike")
                      : t("feed.reports.strikeComment")}
                </button>
                <button
                  type="button"
                  className={QUIET_BUTTON}
                  disabled={busy}
                  onClick={() => {
                    setAnswering(report.reportId);
                    void dismiss.submit(report).finally(() => {
                      setAnswering(null);
                    });
                  }}
                >
                  {report.commentId === null
                    ? t("feed.reports.dismiss")
                    : t("feed.reports.dismissComment")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {moreFailed ? (
        <Notice tone="danger" live>
          {t("feed.reports.moreFailed")}
        </Notice>
      ) : null}
      {next === null ? null : (
        <button
          type="button"
          className={`${QUIET_BUTTON} self-start`}
          disabled={readingMore}
          onClick={() => {
            void readMore(next);
          }}
        >
          {readingMore ? t("feed.reports.readingMore") : t("feed.reports.more")}
        </button>
      )}

      <p className={HINT}>{t("feed.reports.hint")}</p>
    </Panel>
  );
}

/** What a report is about: its comment, or its post. */
function subjectOf(report: PostReportView): string {
  return report.commentId === null
    ? `post:${report.postId ?? ""}`
    : `comment:${report.commentId}`;
}
