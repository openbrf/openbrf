import { MAX_WITHHELD_IDS } from "@openbrf/shared";
import { useEffect, useState } from "react";

import {
  fetchWithheldFromDevices,
  type WithheldFromDevices,
  type WithheldKind,
} from "../api/withheld-from-devices";

const NONE: ReadonlyMap<string, WithheldFromDevices> = new Map();

/**
 * Which of an editor's items the register check withholds from devices
 * (ADR 0032), by item id.
 *
 * `version` is whatever changes when the saved text of those items does, such
 * as their revisions: the question is asked again whenever it or the ids
 * change, and an answer is shown only for the question it answered, so a mark
 * from before a save never stands beside the text the save wrote. A read that
 * fails keeps the marks of the last answer for the same items, so that an item
 * that was withheld is not shown as passing because the re-read after a save
 * failed; with no such answer, or when a support session is refused, it marks
 * nothing. The mark is the board's aid in rephrasing, and the check itself
 * runs on every device's read whether or not the editor could show it.
 */
export function useWithheldFromDevices(
  kind: WithheldKind,
  ids: readonly string[],
  version: string,
): ReadonlyMap<string, WithheldFromDevices> {
  const scope = `${kind}\n${ids.join(",")}`;
  const key = `${scope}\n${version}`;
  const [answer, setAnswer] = useState<{
    key: string;
    scope: string;
    marks: ReadonlyMap<string, WithheldFromDevices>;
  } | null>(null);

  useEffect(() => {
    if (ids.length === 0) {
      return undefined;
    }
    const controller = new AbortController();
    const batches: string[][] = [];
    for (let start = 0; start < ids.length; start += MAX_WITHHELD_IDS) {
      batches.push(ids.slice(start, start + MAX_WITHHELD_IDS));
    }
    void Promise.all(
      batches.map((batch) =>
        fetchWithheldFromDevices(kind, batch, controller.signal),
      ),
    ).then((results) => {
      if (controller.signal.aborted) {
        return;
      }
      const marks = new Map<string, WithheldFromDevices>();
      for (const result of results) {
        if (!result.ok) {
          setAnswer((previous) => ({
            key,
            scope,
            marks: previous?.scope === scope ? previous.marks : NONE,
          }));
          return;
        }
        for (const item of result.value.items) {
          marks.set(item.id, item.withheldFromDevices);
        }
      }
      setAnswer({ key, scope, marks });
    });
    return () => {
      controller.abort();
    };
    // The key holds kind, ids and version; the effect asks for exactly it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return answer?.key === key ? answer.marks : NONE;
}
