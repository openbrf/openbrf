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
  fetchMotionIntake,
  fetchMotionQueue,
  type MotionDeadline,
  type OwnMotion,
  type QueuedMotion,
} from "../api/motions";
import { Notice } from "../ui/Notice";
import { MotionQueuePanel } from "./MotionQueuePanel";
import { OwnMotionsPanel } from "./OwnMotionsPanel";
import { SubmitMotionPanel } from "./SubmitMotionPanel";

export interface MotionsScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  deadline: MotionDeadline | null;
  own: readonly OwnMotion[];
  queue: readonly QueuedMotion[];
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  deadline: null,
  own: [],
  queue: [],
  loadFailed: false,
};

/**
 * Putting an item to the general meeting, and - for the board - the queue they
 * arrive in.
 *
 * What a viewer sees follows from their capabilities, and the two halves are
 * deliberately independent. `motions:submit` is a member's, derived from the
 * tenant-ownership rather than from living here: EFL 6 kap. 15 §, applied to a
 * housing cooperative by BRL 9 kap. 14 §, gives the right to a member, so a
 * partner, an adult child or a tenant sees no form. `motions:handle` is the
 * board's, because a motion is addressed to it.
 *
 * A board member who is also a member holds both and sees both, which is the
 * ordinary case in a cooperative and is why neither half assumes it is alone on
 * the screen.
 *
 * Hiding a panel is courtesy only. The API refuses the calls either way, and the
 * membership question is asked again by the server before a motion is written -
 * an administrator holds every capability and no membership, and the statute does
 * not care which grants an account has.
 *
 * ## Which read lives where
 *
 * Both halves are read here rather than in their panels, because both answers
 * carry the deadline and the screen would otherwise ask for the same bylaws
 * clause twice and be able to show two different dates for it.
 */
export function MotionsScreen({ viewer }: MotionsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canSubmit = viewer.capabilities.includes("motions:submit");
  const canHandle = viewer.capabilities.includes("motions:handle");

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

  const read = useCallback(async (): Promise<Loaded> => {
    const [intake, queue] = await Promise.all([
      canSubmit ? fetchMotionIntake() : null,
      canHandle ? fetchMotionQueue() : null,
    ]);

    return {
      ready: true,
      /*
       * The board's answer first where there is one, because a board member who
       * is also a member gets both and the two carry the same clause. Falling
       * back to the intake's copy keeps a member-only viewer supplied.
       */
      deadline:
        queue?.ok === true
          ? queue.value.deadline
          : intake?.ok === true
            ? intake.value.deadline
            : null,
      own: intake?.ok === true ? intake.value.motions : [],
      queue: queue?.ok === true ? queue.value.motions : [],
      loadFailed: intake?.ok === false || queue?.ok === false,
    };
  }, [canSubmit, canHandle]);

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * Held in one place so the first read and every re-read are governed by the
   * same rule rather than each carrying its own version of it.
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
     * Leaving supersedes whatever is in flight, so a response that arrives after
     * the screen is gone is dropped by the same check that drops a superseded
     * one. One rule for both, rather than a mounted flag beside a version and
     * two ways for a read to be ignored.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const { ready, deadline, own, queue, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("motions.title")}</h1>
        <p className="text-body text-ink-muted">{t("motions.intro")}</p>
      </header>

      {loadFailed ? (
        <Notice tone="danger" live>
          {t("motions.loadFailed")}
        </Notice>
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("motions.loading")}
        </p>
      )}

      {ready && canHandle ? (
        <MotionQueuePanel
          motions={queue}
          deadline={deadline}
          onChanged={reload}
        />
      ) : null}

      {ready && canSubmit ? (
        <>
          <SubmitMotionPanel deadline={deadline} onSubmitted={reload} />
          <OwnMotionsPanel motions={own} onChanged={reload} />
        </>
      ) : null}
    </div>
  );
}
