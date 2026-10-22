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
  fetchIssueQueue,
  fetchOwnApartments,
  fetchOwnIssues,
  fetchReportableTypes,
  type IssueApartment,
  type OwnIssue,
  type QueuedIssue,
  type ReportableIssueType,
} from "../api/issues";
import { BoardZone } from "../ui/BoardZone";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { IssueQueuePanel } from "./IssueQueuePanel";
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
  queue: readonly QueuedIssue[];
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  types: [],
  apartments: [],
  own: [],
  queue: [],
  loadFailed: false,
};

/**
 * Reporting an issue, following one's own, and - for whoever handles them - the
 * queue.
 *
 * What a viewer sees follows from their capabilities, and the two halves are
 * deliberately independent. A resident reports and follows. An external
 * property manager holds issues:handle and nothing else, so they get the queue
 * and no report form at all: they do not live in the building. A board member
 * holds both and gets both.
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
 */
export function IssuesScreen({
  viewer,
  fromPostId = null,
}: IssuesScreenProps): ReactElement {
  const { t } = useTranslation();

  const canReport = viewer.capabilities.includes("issues:report");
  const canHandle = viewer.capabilities.includes("issues:handle");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const currentRead = useRef(0);
  /** The post a report is made from, as read, and which post it was. */
  const [postRead, setPostRead] = useState<{
    postId: string;
    read: Extract<FromPost, { kind: "read" | "unreadable" }>;
  } | null>(null);
  const [reportedFrom, setReportedFrom] = useState<string | null>(null);
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

  const read = useCallback(async (): Promise<Loaded> => {
    const [types, apartments, own, queue] = await Promise.all([
      canReport ? fetchReportableTypes() : null,
      canReport ? fetchOwnApartments() : null,
      canReport ? fetchOwnIssues() : null,
      canHandle ? fetchIssueQueue() : null,
    ]);

    return {
      ready: true,
      types: types?.ok === true ? types.value : [],
      apartments: apartments?.ok === true ? apartments.value : [],
      own: own?.ok === true ? own.value : [],
      queue: queue?.ok === true ? queue.value : [],
      loadFailed:
        types?.ok === false ||
        apartments?.ok === false ||
        own?.ok === false ||
        queue?.ok === false,
    };
  }, [canReport, canHandle]);

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
        setLoaded(next);
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

  const { ready, types, apartments, own, queue, loadFailed } = loaded;

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
          <ReportIssuePanel
            // Mounted again once the post is read, so the form opens with it.
            key={fromPost.kind === "read" ? fromPost.prefill.postId : "blank"}
            types={types}
            apartments={apartments}
            {...(fromPost.kind === "read" ? { prefill: fromPost.prefill } : {})}
            onReported={(postId) => {
              setReportedFrom(postId);
              reload();
            }}
          />
          <OwnIssuesPanel issues={own} />
        </>
      ) : null}

      {ready && canHandle ? (
        <BoardZone title={t("issues.boardZone")} audience="issueHandling">
          <IssueQueuePanel issues={queue} onChanged={reload} />
        </BoardZone>
      ) : null}
    </div>
  );
}
