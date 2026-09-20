import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  dismissChatReport,
  fetchChatReports,
  strikeChatReport,
  type ChatAuthor,
  type ChatReport,
} from "../api/chat";
import { ASSOCIATION_TIME_ZONE } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { HINT, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { chatFailureKey } from "./chat-failures";

/**
 * What the board has been asked to look at.
 *
 * ## This is the whole of the board's way into a group
 *
 * A group is invisible to anybody who is not in it. There is no list of groups
 * on this screen or on any other, no count of them, and no way to open one: what
 * is here is the messages somebody inside a room chose to carry out, one at a
 * time, and each one arrives with the room's name so the board knows where it
 * was said.
 *
 * A board that has had no report reads an empty queue, which is also the whole
 * of what it can learn about whether this cooperative has any groups at all.
 *
 * ## Two answers and no third
 *
 * Struck through, or left standing. Striking withholds the text from the other
 * people in the room and from nobody else - the message stays where it is, its
 * author still reads it, and the retention clock is unchanged - and there is
 * deliberately no control that clears it. Leaving it standing closes the report
 * and changes nothing about the message.
 *
 * Both answers close every open report about that message, so the board decides
 * one message once.
 */
export function ChatReportQueue(): ReactElement {
  const { t, i18n } = useTranslation();

  const [reports, setReports] = useState<readonly ChatReport[] | null>(null);
  /** Whether this account may answer a report, which a capability cannot say. */
  const [mayModerate, setMayModerate] = useState(true);
  const [failed, setFailed] = useState(false);
  /** Which report is being answered, so one row can say so while it happens. */
  const [answering, setAnswering] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;

    void (async () => {
      const result = await fetchChatReports();
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
   * the same message: the board decides about the message rather than about one
   * person's report of it, and the server closes them together. A sibling left
   * on the screen would be a row that answers `report-resolved` when pressed.
   *
   * Read back into the queue rather than re-fetched, because the queue is what
   * is open and a row that stayed with a decision on it would be a queue that
   * never empties.
   */
  const answered = (report: ChatReport): void => {
    setReports(
      (held) =>
        held?.filter((each) => each.messageId !== report.messageId) ?? null,
    );
  };

  const strike = useSaveAction(strikeChatReport, answered);
  const dismiss = useSaveAction(dismissChatReport, answered);
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
      <Panel title={t("chat.reports.title")}>
        <Notice tone="danger" live>
          {t("chat.reports.loadFailed")}
        </Notice>
      </Panel>
    );
  }

  if (!mayModerate) {
    /*
     * The instance's administrator, and the sentence is the point. They hold
     * every capability and no board seat, so the queue is not theirs - and an
     * empty queue would tell them that nothing has been reported, which is a
     * fact about rooms they may not be told exist.
     */
    return (
      <Panel title={t("chat.reports.title")}>
        <Notice tone="info">{t("chat.reports.notTheBoard")}</Notice>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("chat.reports.title")}
      description={t("chat.reports.intro")}
      notice={
        failure === null ? null : (
          <Notice tone="danger" live>
            {t(chatFailureKey(failure))}
          </Notice>
        )
      }
    >
      {reports === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("chat.reports.reading")}
        </p>
      ) : reports.length === 0 ? (
        <p className="text-body text-ink-muted">{t("chat.reports.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {reports.map((report) => (
            <li
              key={report.reportId}
              className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-body font-semibold">
                  {report.groupName ?? t("chat.reports.unnamedGroup")}
                </span>
                <span className="ml-auto font-data text-data text-ink-muted">
                  <time dateTime={report.reportedAt}>
                    {instant(report.reportedAt, i18n.language)}
                  </time>
                </span>
              </div>

              <p className={HINT}>
                {t("chat.reports.reportedBy", {
                  reporter: nameOf(report.reporter, t),
                  author: nameOf(report.author, t),
                })}
              </p>

              {report.note === null ? null : (
                <p className="text-body whitespace-pre-line">{report.note}</p>
              )}

              <blockquote className="border-l-4 border-line pl-3">
                <p className="text-body whitespace-pre-line">{report.body}</p>
                <p className={HINT}>
                  <time dateTime={report.writtenAt}>
                    {instant(report.writtenAt, i18n.language)}
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
                    ? t("chat.reports.striking")
                    : t("chat.reports.strike")}
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
                  {t("chat.reports.dismiss")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className={HINT}>{t("chat.reports.hint")}</p>
    </Panel>
  );
}

/**
 * Who somebody is, as one string.
 *
 * A person with protected personal data is not named to the board here either.
 * The queue is a screen left open on a desk, and `protectedData:reveal` is for
 * an act of revealing that is recorded rather than for a name that simply
 * appears.
 */
function nameOf(who: ChatAuthor, t: (key: TranslationKey) => string): string {
  if (who.kind === "person") {
    return who.name;
  }
  return who.kind === "protected"
    ? t("chat.authorProtected")
    : t("chat.authorUnknown");
}

/** An instant on the association's own clock, day and time. */
function instant(value: string, locale: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: ASSOCIATION_TIME_ZONE,
      }).format(parsed);
}
