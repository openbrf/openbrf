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
  fetchSubletIntake,
  type OwnSubletApplication,
  type SubletApartment,
} from "../api/sublets";
import { LoadFailure } from "../ui/LoadFailure";
import { ApplyForSubletPanel } from "./ApplyForSubletPanel";
import { OwnSubletsPanel } from "./OwnSubletsPanel";

export interface SubletsScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  apartments: readonly SubletApartment[];
  own: readonly OwnSubletApplication[];
  /**
   * Whether the read failed.
   *
   * A failed read has no rows, and a panel handed no rows says so in words: the
   * member would be told they have applied for nothing. The notice above does
   * not undo a sentence somebody has already read, so the panels are not drawn
   * over a failed read at all.
   */
  intakeFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  apartments: [],
  own: [],
  intakeFailed: false,
};

/**
 * Asking the board's consent to let in andra hand, and following one's own
 * requests.
 *
 * The house's page, for a member. `sublets:apply` is derived from the
 * tenant-ownership rather than from living here: BRL 7 kap. 10 § forsta stycket
 * gives the act to a bostadsrattshavare letting "sin lagenhet", so a partner, an
 * adult child or a tenant sees no form. The board decides the requests on its
 * own page at /board/sublets (ADR 0049).
 *
 * Hiding a panel is courtesy only. The API refuses the calls either way, and the
 * apartment the request names is checked against the register before anything is
 * written - an administrator holds every capability and no tenant-ownership, and
 * the statute does not care which grants an account has.
 */
export function SubletsScreen({ viewer }: SubletsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canApply = viewer.capabilities.includes("sublets:apply");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /**
   * Which read is the current one.
   *
   * Every act on this screen ends in a re-read, and two of them can be in flight
   * at once - a member withdraws one application while the answer to the one
   * before it is still coming back. Both answers are well formed, so the screen
   * cannot tell them apart by content; what it can say is that only the newest
   * read may be applied. Without that, whichever response happens to arrive last
   * wins, and the older one puts a withdrawn application back as open.
   */
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    const intake = canApply ? await fetchSubletIntake() : null;

    return {
      ready: true,
      apartments: intake?.ok === true ? intake.value.apartments : [],
      own: intake?.ok === true ? intake.value.applications : [],
      intakeFailed: intake?.ok === false,
    };
  }, [canApply]);

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

  const { ready, apartments, own, intakeFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("sublets.title")}</h1>
        <p className="text-body text-ink-muted">{t("sublets.intro")}</p>
      </header>

      {intakeFailed ? (
        <LoadFailure messageKey="sublets.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("sublets.loading")}
        </p>
      )}

      {ready && canApply && !intakeFailed ? (
        <>
          <ApplyForSubletPanel apartments={apartments} onApplied={reload} />
          <OwnSubletsPanel applications={own} onChanged={reload} />
        </>
      ) : null}
    </div>
  );
}
