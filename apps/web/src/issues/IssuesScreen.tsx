import { Link } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import {
  fetchKnownFaults,
  fetchOwnApartments,
  fetchOwnIssues,
  fetchReportableTypes,
  type IssueApartment,
  type KnownFault,
  type OwnIssue,
  type ReportableIssueType,
} from "../api/issues";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { OwnIssuesPanel } from "./OwnIssuesPanel";
import { type PostPrefill, readPostPrefill } from "./post-prefill";
import { MAX_PHOTOS, ReportIssuePanel } from "./ReportIssuePanel";

export interface IssuesScreenProps {
  viewer: Viewer;
  /**
   * The post in the feed "Gör felanmälan" was pressed on, or null. The form
   * opens with its text and images, and the report is linked to it.
   */
  fromPostId?: string | null;
}

/** Where reading the post a report is made from stands. */
type FromPost =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "read"; prefill: PostPrefill }
  | { kind: "unreadable" };

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  types: readonly ReportableIssueType[];
  apartments: readonly IssueApartment[];
  own: readonly OwnIssue[];
  knownFaults: readonly KnownFault[];
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  types: [],
  apartments: [],
  own: [],
  knownFaults: [],
  loadFailed: false,
};

/**
 * Reporting an issue, and following one's own.
 *
 * The house's page, for whoever lives here and holds issues:report. The list
 * those reports arrive in is the board's page at /board/issues (ADR 0049), so
 * nothing here is shown to the board that a resident is not shown too.
 *
 * Hiding a panel is courtesy only. The API refuses the calls either way, and
 * the type list a reporter is offered is filtered by the server rather than
 * here.
 *
 * ## A report made from a post
 *
 * Opened from a post in the feed, the form waits for the post and opens with
 * what it says and its images in it. A post this account may not read - or one
 * that is gone - is said in a sentence, and the form opens empty: the feed
 * answers both as one, and so does this screen. Once the report is filed, the
 * screen offers the way back to the post, where its status now shows.
 *
 * ## Known faults, and a report that follows up another
 *
 * The form opens with the known faults the house is told of (decision 22),
 * so a resident about to report the same thing sees that it is known. A
 * report closed too long ago for a reply to reopen it, or merged into
 * another, offers a new report linked to it instead (ADR 0054): the form
 * opens on its type and says which report it follows up.
 */
export function IssuesScreen({
  viewer,
  fromPostId = null,
}: IssuesScreenProps): ReactElement {
  const { t } = useTranslation();

  const canReport = viewer.capabilities.includes("issues:report");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const currentRead = useRef(0);
  /** The post a report is made from, as read, and which post it was. */
  const [postRead, setPostRead] = useState<{
    postId: string;
    read: Extract<FromPost, { kind: "read" | "unreadable" }>;
  } | null>(null);
  const [reportedFrom, setReportedFrom] = useState<string | null>(null);
  /** The closed report a new one follows up, while the reporter writes it. */
  const [followUp, setFollowUp] = useState<OwnIssue | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const fromPost: FromPost =
    fromPostId === null || !canReport
      ? { kind: "none" }
      : postRead?.postId === fromPostId
        ? postRead.read
        : { kind: "reading" };

  useEffect(() => {
    if (fromPostId === null || !canReport) {
      return;
    }
    let wanted = true;
    void (async () => {
      const read = await readPostPrefill(
        fromPostId,
        (number) => t("issues.fromPost.photoName", { number }),
        MAX_PHOTOS,
      );
      if (wanted) {
        setPostRead({
          postId: fromPostId,
          read: read.ok
            ? { kind: "read", prefill: read.value }
            : { kind: "unreadable" },
        });
      }
    })();
    return () => {
      wanted = false;
    };
  }, [fromPostId, canReport, t]);

  /**
   * One read of the three lists. A list that could not be read comes back
   * `null`, so a re-read that fails on one of them leaves what the screen
   * already shows in place instead of replacing it with an empty list.
   */
  const read = useCallback(async () => {
    const [types, apartments, own, knownFaults] = await Promise.all([
      canReport ? fetchReportableTypes() : null,
      canReport ? fetchOwnApartments() : null,
      canReport ? fetchOwnIssues() : null,
      canReport ? fetchKnownFaults() : null,
    ]);

    return {
      types: types?.ok === true ? types.value : null,
      apartments: apartments?.ok === true ? apartments.value : null,
      own: own?.ok === true ? own.value : null,
      knownFaults: knownFaults?.ok === true ? knownFaults.value : null,
      loadFailed:
        types?.ok === false ||
        apartments?.ok === false ||
        own?.ok === false ||
        knownFaults?.ok === false,
      /** Nothing was asked for: a viewer who cannot report has no lists. */
      asked: canReport,
    };
  }, [canReport]);

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * One rule for the first read and every re-read, on the precedent
   * `MotionsScreen` sets. It matters more now than it did: the failure notice
   * offers a retry, so two reads in flight is a board pressing a button twice
   * rather than a race nobody could reach, and an older failure landing after a
   * newer success would put the screen back into the state the reader had just
   * got out of.
   */
  const reload = useCallback((): void => {
    const version = ++currentRead.current;
    void read().then((next) => {
      if (version === currentRead.current) {
        setLoaded((previous) => ({
          ready: true,
          types: next.types ?? (next.asked ? previous.types : []),
          apartments:
            next.apartments ?? (next.asked ? previous.apartments : []),
          own: next.own ?? (next.asked ? previous.own : []),
          knownFaults:
            next.knownFaults ?? (next.asked ? previous.knownFaults : []),
          loadFailed: next.loadFailed,
        }));
      }
    });
  }, [read]);

  useEffect(() => {
    reload();
    /*
     * Leaving supersedes whatever is in flight, so a response that arrives
     * after the screen is gone is dropped by the same check that drops a
     * superseded one. One rule for both.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const { ready, types, apartments, own, knownFaults, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("issues.title")}</h1>
        <p className="text-body text-ink-muted">{t("issues.intro")}</p>
      </header>

      {loadFailed ? (
        <LoadFailure messageKey="issues.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("issues.loading")}
        </p>
      )}

      {fromPost.kind === "unreadable" ? (
        <Notice tone="warn" live>
          {t("issues.fromPost.unreadable")}
        </Notice>
      ) : null}
      {fromPost.kind === "read" && fromPost.prefill.photosMissing > 0 ? (
        <Notice tone="warn" live>
          {t("issues.fromPost.photosMissing", {
            count: fromPost.prefill.photosMissing,
          })}
        </Notice>
      ) : null}
      {reportedFrom === null ? null : (
        <Notice tone="ok" live>
          {t("issues.fromPost.reported")}{" "}
          <Link
            to="/feed/$postId"
            params={{ postId: reportedFrom }}
            className="text-trust underline"
          >
            {t("issues.fromPost.back")}
          </Link>
        </Notice>
      )}

      {ready && canReport && fromPost.kind !== "reading" ? (
        <>
          <div ref={formRef}>
            <ReportIssuePanel
              // Mounted again once the post is read, or a follow-up chosen, so
              // the form opens with it.
              key={
                fromPost.kind === "read"
                  ? fromPost.prefill.postId
                  : followUp === null
                    ? "blank"
                    : `follows-${followUp.id}`
              }
              types={types}
              apartments={apartments}
              knownFaults={knownFaults}
              {...(fromPost.kind === "read"
                ? { prefill: fromPost.prefill }
                : followUp === null
                  ? {}
                  : {
                      followUp,
                      onFollowUpCancelled: () => {
                        setFollowUp(null);
                      },
                    })}
              onReported={(postId) => {
                setReportedFrom(postId);
                setFollowUp(null);
                reload();
              }}
            />
          </div>
          <OwnIssuesPanel
            issues={own}
            onChanged={reload}
            onFollowUp={(issue) => {
              setFollowUp(issue);
              formRef.current?.scrollIntoView({ block: "start" });
            }}
          />
        </>
      ) : null}
    </div>
  );
}
