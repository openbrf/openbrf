import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchMeetings, type MeetingSummary } from "../api/meetings";
import {
  fetchMotionQueue,
  type MotionDeadline,
  type QueuedMotion,
} from "../api/motions";
import { BoardPage } from "../ui/BoardPage";
import { LoadFailure } from "../ui/LoadFailure";
import { MotionQueuePanel } from "./MotionQueuePanel";

export interface MotionQueueScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  deadline: MotionDeadline | null;
  queue: readonly QueuedMotion[];
  /**
   * The cursor for the page of the queue behind the one on the screen, or null
   * at the end of it.
   *
   * The queue is read a page at a time: a motion's body runs to eight thousand
   * characters and an association accumulates a queue for as long as it exists,
   * so the whole of it was never an answer this screen could ask for.
   */
  queueCursor: string | null;
  /**
   * The meetings an item may be put to, or null where this viewer may not read
   * them.
   *
   * Null rather than an empty list where the capability is absent, because the
   * queue panel says different things about the two: no meetings arranged is a
   * fact about the association, and no capability is a fact about the account.
   */
  meetings: readonly MeetingSummary[] | null;
  /**
   * True where the meetings were asked for and the read failed.
   *
   * Its own flag rather than the null above, because the two are different
   * things to tell a board and null cannot say which happened. A seat that may
   * not read meetings is offered no control and that is correct; a board whose
   * read failed would otherwise be shown the same screen and told the
   * association has arranged no meeting - a claim about the cooperative, made
   * from a request that never answered.
   */
  meetingsFailed: boolean;
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  deadline: null,
  queue: [],
  queueCursor: null,
  meetings: null,
  meetingsFailed: false,
  loadFailed: false,
};

/**
 * "Handle motions": the queue the members' motions arrive in, as a page of its
 * own under /board.
 *
 * `motions:handle` is the board's, because a motion is addressed to it.
 * Putting an item in and following one's own stay on the house's page, which
 * a member reaches holding motions:submit (ADR 0049).
 *
 * Hiding the queue is courtesy only. The API refuses the calls either way.
 */
export function MotionQueueScreen({
  viewer,
}: MotionQueueScreenProps): ReactElement {
  const { t } = useTranslation();

  const canHandle = viewer.capabilities.includes("motions:handle");
  /*
   * Which meeting deals with an item is a fact about a meeting, so the list is
   * read with the capability that answers for meetings rather than with the one
   * that answers for the queue. The board holds both; a seat granted only the
   * queue reads the items and is offered no meeting to put them on, which is the
   * honest answer rather than an empty control.
   */
  const canReadMeetings = viewer.capabilities.includes("meetings:manage");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /**
   * Which read is the current one.
   *
   * Every act on this screen ends in a re-read, and two of them can be in flight
   * at once - the board records one motion as received while the answer to the
   * one before it is still coming back. Both answers are well formed, so the
   * screen cannot tell them apart by content; what it can say is that only the
   * newest read may be applied. Without that, whichever response happens to
   * arrive last wins, and the older one puts a closed motion back as open.
   */
  const currentRead = useRef(0);
  /**
   * Whether the read in flight is the one that fetches the page below.
   *
   * Told apart from a whole re-read, because the control says what it is doing
   * and a control announcing somebody else's work would describe the wrong act.
   */
  const [readingMore, setReadingMore] = useState(false);
  /**
   * Whether the last attempt to read the page below failed.
   *
   * A flag of its own rather than the screen's `loadFailed`, for two reasons.
   * That one says the screen's first read failed - so a page read clearing it
   * on success would clear a failure of the first page that nothing had fixed.
   * And the queue already on the screen is intact: what failed is one request
   * for more, so the sentence belongs beside the control that made it and the
   * control stays for another attempt. It is the comment thread's rule for a
   * failed earlier page, applied to the queue.
   */
  const [moreFailed, setMoreFailed] = useState(false);
  /**
   * How many pages of the queue the board has read down to.
   *
   * A re-read after an act reads as many again, so an item handled on the third
   * page is still in view afterwards rather than the queue collapsing to its
   * first page and taking the item with it.
   */
  const queuePages = useRef(1);

  /*
   * Answers with a step from what is on the screen rather than a whole new
   * screen, because a queue whose read failed keeps what it last showed. Every
   * act here ends in a re-read, and one that fails after an answer would
   * otherwise put "no motions" and "no deadline" under the notice saying the
   * read failed - sentences about the association made from a request that
   * never answered. The meetings screen keeps its meeting the same way.
   */
  const read = useCallback(async (): Promise<{
    apply: (held: Loaded) => Loaded;
    /**
     * True where the re-read reached the first page and failed on a later one.
     *
     * The queue then holds the pages read before the failure and the cursor
     * points at the page that failed, so the control below the queue can offer
     * that page again. It is not `loadFailed`: the rows on the screen are good.
     */
    laterPageFailed: boolean;
    /** How many pages of the queue this read holds, for the caller to keep. */
    pagesHeld: number;
  }> => {
    // Fixed for this read: another read finishing meanwhile must not move it.
    const target = queuePages.current;
    const [firstPage, meetings] = await Promise.all([
      canHandle ? fetchMotionQueue() : null,
      canHandle && canReadMeetings ? fetchMeetings() : null,
    ]);
    let queue = firstPage;
    let laterPageFailed = false;
    let pagesHeld = 1;
    for (
      ;
      pagesHeld < target &&
      queue?.ok === true &&
      queue.value.nextCursor !== null;
      pagesHeld += 1
    ) {
      const next = await fetchMotionQueue({ after: queue.value.nextCursor });
      if (!next.ok) {
        /*
         * Stop, and keep what the earlier pages gave. The first page is good
         * and so are the ones merged so far; throwing them away for one failed
         * request would empty a queue the board is working down. The cursor
         * stays where it is, on the page that failed, so the control offers
         * that page again.
         */
        laterPageFailed = true;
        break;
      }
      queue = {
        ok: true,
        value: {
          ...next.value,
          motions: mergeQueuePage(queue.value.motions, next.value.motions),
        },
      };
    }

    const apply = (held: Loaded): Loaded => ({
      ready: true,
      deadline: queue?.ok === true ? queue.value.deadline : held.deadline,
      queue: queue?.ok === true ? queue.value.motions : held.queue,
      queueCursor:
        queue?.ok === true ? queue.value.nextCursor : held.queueCursor,
      meetings: meetings?.ok === true ? meetings.value : null,
      /*
       * A meetings read that failed is deliberately not a failed load of this
       * screen: the queue is what the screen is for and it arrived. What is lost
       * is the control that puts an item on a meeting, and the panel says so in
       * its own words rather than in this screen's.
       */
      meetingsFailed: meetings?.ok === false,
      loadFailed: queue?.ok === false,
    });
    return { apply, laterPageFailed, pagesHeld };
  }, [canHandle, canReadMeetings]);

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * Held in one place so the first read and every re-read are governed by the
   * same rule rather than each carrying its own version of it.
   */
  const reload = useCallback((): void => {
    const version = ++currentRead.current;
    void read().then(({ apply, laterPageFailed, pagesHeld }) => {
      if (version === currentRead.current) {
        if (laterPageFailed) {
          // The board has read as far as the pages in hand, so a retry appends
          // the next one rather than skipping past it. Only once this read is
          // known to be the newest: a superseded one that stopped short must
          // not shorten what the next re-read asks for.
          queuePages.current = pagesHeld;
        }
        setLoaded(apply);
        // The queue has been read again from the top, so a failure to read a
        // page below the old one is no longer about anything on the screen.
        // Cleared as the new queue lands rather than as the read starts, so the
        // sentence never disappears while the rows it was about are still up.
        // Raised instead where the re-read itself stopped short of a page.
        setMoreFailed(laterPageFailed);
      }
    });
  }, [read]);

  /**
   * Reads the page behind the one on the screen and adds it to the end.
   *
   * Its own read rather than a wider first one, and it appends rather than
   * replacing: a board working down a long queue has read what is above and is
   * reaching for what is below. A superseded read is dropped by the same version
   * check every other read here is subject to, so a page that arrives after an
   * act has reset the queue does not put the old rows back.
   */
  const showMoreOfQueue = useCallback((): void => {
    const cursor = loaded.queueCursor;
    if (cursor === null || readingMore) {
      return;
    }
    const version = currentRead.current;
    setReadingMore(true);
    setMoreFailed(false);
    void fetchMotionQueue({ after: cursor })
      .then((answer) => {
        if (version !== currentRead.current) {
          return;
        }
        if (!answer.ok) {
          setMoreFailed(true);
          return;
        }
        queuePages.current += 1;
        setLoaded((held) => {
          /*
           * Merged by id rather than appended, because the queue is written
           * into while it is being read and its ordering puts a motion's state
           * first. An item that was SUBMITTED on the page above can be
           * acknowledged before this page is asked for, and it then sorts into
           * the later group - which is after the cursor, so the server answers
           * with it again. That is correct of the server: the cursor names a
           * place in an ordering rather than a set of rows already sent, and
           * nothing on the server remembers what this reader has seen.
           *
           * So the reader is what deduplicates, and the newer copy wins: it
           * carries the state the item is actually in now.
           *
           * It also takes the newer copy's place. Setting a key a Map already
           * holds keeps the key where it was first inserted, so an item
           * acknowledged since the page above would stay among the open ones
           * with an acknowledged chip on it - the queue would contradict its
           * own ordering. Deleting first puts it where this page puts it, which
           * is where the server's ordering now has it.
           */
          return {
            ...held,
            queue: mergeQueuePage(held.queue, answer.value.motions),
            queueCursor: answer.value.nextCursor,
          };
        });
      })
      .finally(() => {
        setReadingMore(false);
      });
  }, [loaded.queueCursor, readingMore]);

  useEffect(() => {
    reload();
    /*
     * Leaving supersedes whatever is in flight, so a response that arrives after
     * the screen is gone is dropped by the same check that drops a superseded
     * one. One rule for both, rather than a mounted flag beside a version and
     * two ways for a read to be ignored.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const {
    ready,
    deadline,
    queue,
    queueCursor,
    meetings,
    meetingsFailed,
    loadFailed,
  } = loaded;

  return (
    <BoardPage title={t("motions.boardTitle")} offered={canHandle}>
      {loadFailed ? (
        <LoadFailure messageKey="motions.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("motions.loading")}
        </p>
      )}

      {ready ? (
        <MotionQueuePanel
          motions={queue}
          deadline={deadline}
          meetings={meetings}
          meetingsFailed={meetingsFailed}
          hasMore={queueCursor !== null}
          readingMore={readingMore}
          moreFailed={moreFailed}
          onShowMore={showMoreOfQueue}
          onChanged={reload}
        />
      ) : null}
    </BoardPage>
  );
}

/**
 * The queue with the page below added to it, by id, the newer copy in its newer
 * place - see where "more" calls it for why.
 */
function mergeQueuePage(
  held: readonly QueuedMotion[],
  page: readonly QueuedMotion[],
): QueuedMotion[] {
  const byId = new Map(held.map((motion) => [motion.id, motion]));
  for (const motion of page) {
    byId.delete(motion.id);
    byId.set(motion.id, motion);
  }
  return [...byId.values()];
}
