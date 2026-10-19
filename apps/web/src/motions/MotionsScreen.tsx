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
  type MotionDeadline,
  type OwnMotion,
} from "../api/motions";
import { LoadFailure } from "../ui/LoadFailure";
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
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  deadline: null,
  own: [],
  loadFailed: false,
};

/**
 * Putting an item to the general meeting, and following one's own.
 *
 * The house's page, for a member. `motions:submit` is derived from the
 * tenant-ownership rather than from living here: EFL 6 kap. 15 §, applied to a
 * housing cooperative by BRL 9 kap. 14 §, gives the right to a member, so a
 * partner, an adult child or a tenant sees no form. The queue those motions
 * arrive in is the board's page at /board/motions (ADR 0044).
 *
 * Hiding a panel is courtesy only. The API refuses the calls either way, and the
 * membership question is asked again by the server before a motion is written -
 * an administrator holds every capability and no membership, and the statute does
 * not care which grants an account has.
 */
export function MotionsScreen({ viewer }: MotionsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canSubmit = viewer.capabilities.includes("motions:submit");
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /**
   * Which read is the current one.
   *
   * Every act on this screen ends in a re-read, and two of them can be in flight
   * at once - a member withdraws one motion while the answer to the one before
   * it is still coming back. Only the newest read may be applied; without that,
   * whichever response happens to arrive last wins.
   */
  const currentRead = useRef(0);

  /*
   * Answers with a step from what is on the screen rather than a whole new
   * screen, because a read that failed keeps what it last showed: a re-read
   * that fails after a withdrawal would otherwise put "no motions" and "no
   * deadline" under the notice saying the read failed.
   */
  const read = useCallback(async (): Promise<(held: Loaded) => Loaded> => {
    const intake = canSubmit ? await fetchMotionIntake() : null;
    return (held: Loaded): Loaded => ({
      ready: true,
      deadline: intake?.ok === true ? intake.value.deadline : held.deadline,
      own: intake?.ok === true ? intake.value.motions : held.own,
      loadFailed: intake?.ok === false,
    });
  }, [canSubmit]);

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * Held in one place so the first read and every re-read are governed by the
   * same rule rather than each carrying its own version of it.
   */
  const reload = useCallback((): void => {
    const version = ++currentRead.current;
    void read().then((apply) => {
      if (version === currentRead.current) {
        setLoaded(apply);
      }
    });
  }, [read]);

  useEffect(() => {
    reload();
    /*
     * Leaving supersedes whatever is in flight, so a response that arrives after
     * the screen is gone is dropped by the same check that drops a superseded
     * one.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const { ready, deadline, own, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("motions.title")}</h1>
        <p className="text-body text-ink-muted">{t("motions.intro")}</p>
      </header>

      {loadFailed ? (
        <LoadFailure messageKey="motions.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("motions.loading")}
        </p>
      )}

      {ready && canSubmit ? (
        <>
          <SubmitMotionPanel deadline={deadline} onSubmitted={reload} />
          <OwnMotionsPanel motions={own} onChanged={reload} />
        </>
      ) : null}
    </div>
  );
}
