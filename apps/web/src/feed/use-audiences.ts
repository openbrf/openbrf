import { useCallback, useEffect, useRef, useState } from "react";
import type { AudienceListView } from "@openbrf/shared";

import { fetchAudiences } from "../api/feed";

/** Why the list of audiences is not on screen, when it is not. */
export type AudienceListFailure = "failed" | "notOffered";

export interface Audiences {
  /** The audiences this account is in, or null until the first read answers. */
  list: AudienceListView | null;
  /**
   * The last read that did not answer. Before the first list it is the whole
   * screen; after it, a notice beside the list still on screen.
   */
  failure: AudienceListFailure | null;
  /**
   * Reads the list again, and answers whether it did.
   *
   * Called whenever the list itself changes - a group made, a group left -
   * because which audiences exist is the server's answer, and a list this
   * screen edited would be a list nothing on the server ever said.
   */
  reload: () => Promise<boolean>;
  /** Takes an audience's unread count down to none, once its marker has landed. */
  markedRead: (audienceId: string) => void;
}

/**
 * The audiences this account is in, as the server last said.
 *
 * ## Which audiences exist is the server's answer, and none is an answer
 *
 * The capability opens the endpoints and membership decides what is in them,
 * and the two are separate questions. The administrator holds every capability,
 * no board seat and no residency, so they reach the feed and are answered with
 * no audiences at all - which the screen says in words rather than rendering an
 * empty feed.
 *
 * ## An older read never overwrites a newer one
 *
 * Reads are numbered as they start, and only the newest one's answer is kept:
 * a retry that fails after a later one answered must not put the failure back
 * over the list, and a slow read from before a group was made must not put back
 * the list without it.
 */
export function useAudiences(): Audiences {
  const [list, setList] = useState<AudienceListView | null>(null);
  const [failure, setFailure] = useState<AudienceListFailure | null>(null);
  const reads = useRef(0);

  const reload = useCallback(async (): Promise<boolean> => {
    reads.current += 1;
    const read = reads.current;
    const result = await fetchAudiences();
    if (reads.current !== read) {
      return false;
    }
    if (!result.ok) {
      /*
       * A refusal by the guard is not a failure to answer, and saying "try
       * again" to somebody who holds no capability would be telling them a part
       * of the product is broken rather than not theirs.
       */
      setFailure(result.failure.status === 403 ? "notOffered" : "failed");
      return false;
    }
    setFailure(null);
    setList(result.value);
    return true;
  }, []);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);

  const markedRead = useCallback((audienceId: string): void => {
    setList((held) =>
      held === null
        ? held
        : {
            ...held,
            audiences: held.audiences.map((each) =>
              each.id === audienceId ? { ...each, unread: 0 } : each,
            ),
          },
    );
  }, []);

  return { list, failure, reload, markedRead };
}
