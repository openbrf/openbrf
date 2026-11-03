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
  fetchHandlerIssueTypes,
  fetchIssuePlaceCounts,
  fetchIssueQueue,
  type IssuePlaceCount,
  type IssueTypeView,
  type QueuedIssue,
} from "../api/issues";
import { BoardPage } from "../ui/BoardPage";
import { LoadFailure } from "../ui/LoadFailure";
import { IssuePlaceCountsPanel } from "./IssuePlaceCountsPanel";
import { IssueQueuePanel } from "./IssueQueuePanel";
import { OpenIssuePanel } from "./OpenIssuePanel";

export interface IssueQueueScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  queue: readonly QueuedIssue[];
  /**
   * The types with their statuses, which an issue is moved between, or null
   * when they could not be read. A failure here leaves the queue readable and
   * the panel says that nothing can be moved.
   */
  types: readonly IssueTypeView[] | null;
  /**
   * The common-area places with their counts. A failure here leaves the queue
   * as it is, and the panel is not drawn.
   */
  places: readonly IssuePlaceCount[];
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  queue: [],
  types: null,
  places: [],
  loadFailed: false,
};

/**
 * "Handle issues": the queue the residents' reports arrive in, as a page of
 * its own under /board.
 *
 * Shared by the board and the external property manager, who holds
 * issues:handle and nothing else - for them this page is the whole of the
 * board's section - so it is signed for both rather than "Board" alone.
 * Reporting an issue and following one's own stay on the house's page.
 *
 * Hiding the queue is courtesy only. The API refuses the read either way.
 */
export function IssueQueueScreen({
  viewer,
}: IssueQueueScreenProps): ReactElement {
  const { t } = useTranslation();

  const canHandle = viewer.capabilities.includes("issues:handle");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const currentRead = useRef(0);
  /** The place the queue is narrowed to, or "" for all of it. */
  const [placeId, setPlaceId] = useState("");

  /**
   * Reads, and applies the answer only while it is still the newest one, on
   * the precedent `MotionQueueScreen` sets: the failure notice offers a retry,
   * so two reads in flight is somebody pressing a button twice.
   */
  const reload = useCallback((): void => {
    if (!canHandle) {
      return;
    }
    const version = ++currentRead.current;
    // Read together and applied together, so a row is never drawn against
    // the statuses of an earlier read: a status the board added since would
    // be missing from its form.
    void Promise.all([
      fetchIssueQueue(placeId === "" ? undefined : { placeId }),
      fetchHandlerIssueTypes(),
      fetchIssuePlaceCounts(),
    ]).then(([queue, types, places]) => {
      if (version === currentRead.current) {
        setLoaded({
          ready: true,
          queue: queue.ok ? queue.value : [],
          types: types.ok ? types.value : null,
          places: places.ok ? places.value : [],
          loadFailed: !queue.ok,
        });
      }
    });
  }, [canHandle, placeId]);

  useEffect(() => {
    reload();
    // Leaving supersedes whatever is in flight, so a late answer is dropped by
    // the same check that drops a superseded one.
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const { ready, queue, types, places, loadFailed } = loaded;

  return (
    <BoardPage
      title={t("issues.boardTitle")}
      audience="issueHandling"
      offered={canHandle}
    >
      {loadFailed ? (
        <LoadFailure messageKey="issues.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("issues.loading")}
        </p>
      )}

      {/*
       * Not drawn over a failed read: an empty queue says nothing is waiting,
       * which is a claim the notice above would not undo.
       */}
      {ready && !loadFailed && types !== null ? (
        <OpenIssuePanel types={types} onOpened={reload} />
      ) : null}

      {ready && !loadFailed ? (
        <IssuePlaceCountsPanel
          places={places}
          selected={placeId}
          onSelect={setPlaceId}
        />
      ) : null}

      {ready && !loadFailed ? (
        <IssueQueuePanel issues={queue} types={types} onChanged={reload} />
      ) : null}
    </BoardPage>
  );
}
