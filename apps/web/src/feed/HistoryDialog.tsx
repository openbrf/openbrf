import { useEffect, useRef, useState, type ReactElement } from "react";
import type { RevisionListView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import type { ApiFailure, ApiResult } from "../api/client";
import { SECONDARY_BUTTON } from "../ui/controls";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";
import { writtenAt } from "./Author";
import { feedReadFailureKey } from "./feed-failures";
import { PostText } from "./PostText";

/**
 * The earlier versions of a post or a comment, for its writer and the board.
 *
 * What an edit replaced is kept rather than overwritten (ADR 0026): what
 * somebody wrote stays a record of what was said, and the record is the
 * history rather than the latest text. Each version says when it was written
 * and when an edit replaced it, the most recently replaced first, so the one at
 * the top is what stood just before the text the card shows now.
 *
 * Read when the dialog opens rather than with the post, because only two
 * people in a house ever ask and the server answers everybody else with a
 * refusal. The house reads that it was edited, and nothing more.
 */
export function HistoryDialog({
  title,
  load,
  onClose,
}: {
  /** The dialog's heading: whose post or comment this is. */
  title: string;
  /** Reads the versions. Called once, when the dialog opens. */
  load: () => Promise<ApiResult<RevisionListView>>;
  onClose: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [read, setRead] = useState<
    | { kind: "reading" }
    | { kind: "read"; value: RevisionListView }
    | { kind: "failed"; failure: ApiFailure }
  >({ kind: "reading" });
  /*
   * Held as it was when the dialog opened: the versions of the post or comment
   * it was opened on are read once, and a parent's new function on a later
   * render is not a reason to read them again.
   */
  const loader = useRef(load);

  useEffect(() => {
    let wanted = true;
    void (async () => {
      const result = await loader.current();
      if (!wanted) {
        return;
      }
      setRead(
        result.ok
          ? { kind: "read", value: result.value }
          : { kind: "failed", failure: result.failure },
      );
    })();
    return () => {
      wanted = false;
    };
  }, []);

  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
          {t("feed.history.close")}
        </button>
      }
    >
      {read.kind === "reading" ? (
        <p role="status" className="text-small text-ink-muted">
          {t("feed.history.reading")}
        </p>
      ) : read.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(feedReadFailureKey(read.failure))}
        </Notice>
      ) : read.value.revisions.length === 0 ? (
        <p className="text-small text-ink-muted">{t("feed.history.none")}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {read.value.revisions.map((revision) => (
            <li
              key={`${revision.writtenAt}-${revision.replacedAt}`}
              className="flex flex-col gap-1 rounded-control border border-line p-3"
            >
              <p className="text-small text-ink-muted">
                {t("feed.history.version", {
                  written: writtenAt(revision.writtenAt, i18n.language),
                  replaced: writtenAt(revision.replacedAt, i18n.language),
                })}
              </p>
              <PostText text={revision.body} />
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
