import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type BoardMailboxCollection,
  type BoardMailboxStatus,
  type BoardMailboxThread,
  type BoardMailboxThreadSummary,
  collectBoardMailbox,
  fetchBoardMailboxStatus,
  fetchBoardMailboxThread,
  fetchBoardMailboxThreads,
} from "../api/board-mailbox";
import type { TranslationKey } from "../i18n/translation-key";
import { SECONDARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { formatMailboxDay } from "./board-mailbox-dates";
import { BoardMailboxStatusChip } from "./BoardMailboxStatusChip";
import { BoardMailboxThreadPanel } from "./BoardMailboxThreadPanel";

const COLLECT_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "mailbox-not-configured": "boardMailbox.errors.notConfigured",
  "mailbox-unreachable": "boardMailbox.errors.unreachable",
  "mailbox-sign-in-refused": "boardMailbox.errors.signInRefused",
};

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  status: BoardMailboxStatus | null;
  threads: readonly BoardMailboxThreadSummary[];
  /** Whether the mailbox holds threads the list above does not show. */
  moreThreads: boolean;
  thread: BoardMailboxThread | null;
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  status: null,
  threads: [],
  moreThreads: false,
  thread: null,
  loadFailed: false,
};

/**
 * The board's shared mailbox.
 *
 * A list and one open conversation, on one screen rather than two routes. The
 * work here is triage - reading down what is waiting, opening one, answering it,
 * going back to the list - and a route per thread would put the browser's own
 * history in the middle of that for no gain, since nothing about a thread is
 * worth linking to from outside the board.
 *
 * The screen says whether a mailbox is configured at all, and that is not
 * decoration: an empty inbox and an instance collecting nothing look identical
 * otherwise, and only one of them is a reason to go and finish the settings.
 * Configuring it is an administrator's, so what this screen offers is the
 * sentence rather than the form.
 */
export function BoardMailboxScreen(): ReactElement {
  const { t, i18n } = useTranslation();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    const [status, threads] = await Promise.all([
      fetchBoardMailboxStatus(),
      fetchBoardMailboxThreads(),
    ]);

    const thread =
      selectedId === null ? null : await fetchBoardMailboxThread(selectedId);

    return {
      ready: true,
      status: status.ok ? status.value : null,
      threads: threads.ok ? threads.value.threads : [],
      moreThreads: threads.ok && threads.value.more,
      thread: thread?.ok === true ? thread.value : null,
      loadFailed: !status.ok || !threads.ok || thread?.ok === false,
    };
  }, [selectedId]);

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * One rule for the first read and every re-read, on the precedent the issues
   * and motions screens set. It matters here because the screen re-reads after
   * every act on a thread and after every collection, so two reads in flight is
   * ordinary rather than a race nobody could reach - and an older answer landing
   * after a newer one would put a thread back into the state it had just left.
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
     * one. One rule for both.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const [collection, setCollection] = useState<BoardMailboxCollection | null>(
    null,
  );
  const collect = useSaveAction(collectBoardMailbox, (result) => {
    setCollection(result);
    reload();
  });

  const { ready, status, threads, moreThreads, thread, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("boardMailbox.title")}</h1>
        <p className="text-body text-ink-muted">{t("boardMailbox.intro")}</p>
      </header>

      {loadFailed ? (
        <LoadFailure messageKey="boardMailbox.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("boardMailbox.loading")}
        </p>
      )}

      {!ready || status === null ? null : (
        <Panel
          title={t("boardMailbox.mailbox.title")}
          description={
            status.configured && status.address !== null
              ? t("boardMailbox.mailbox.address", { address: status.address })
              : t("boardMailbox.mailbox.noAddress")
          }
          notice={
            collect.state.kind === "failed" ? (
              <Notice tone="danger" live>
                {t(
                  failureMessageKey(
                    collect.state.failure,
                    COLLECT_FAILURES,
                    "boardMailbox.errors.unknown",
                  ),
                )}
              </Notice>
            ) : collection !== null ? (
              <Notice tone="ok" live>
                {t("boardMailbox.mailbox.collected", {
                  count: collection.collected,
                })}
              </Notice>
            ) : status.configured ? null : (
              <Notice tone="warn">
                {t("boardMailbox.mailbox.notConfigured")}
              </Notice>
            )
          }
          actions={
            status.configured ? (
              <button
                type="button"
                disabled={collect.state.kind === "saving"}
                onClick={() => {
                  void collect.submit();
                }}
                className={SECONDARY_BUTTON}
              >
                {collect.state.kind === "saving"
                  ? t("boardMailbox.mailbox.collecting")
                  : t("boardMailbox.mailbox.collect")}
              </button>
            ) : null
          }
        >
          <p className="text-small text-ink-muted">
            {t("boardMailbox.mailbox.schedule")}
          </p>
        </Panel>
      )}

      {!ready ? null : (
        <Panel
          title={t("boardMailbox.inbox.title")}
          description={t("boardMailbox.inbox.description")}
          notice={
            moreThreads ? (
              <Notice tone="warn">{t("boardMailbox.inbox.more")}</Notice>
            ) : null
          }
        >
          {threads.length === 0 ? (
            <p className="text-body text-ink-muted">
              {t("boardMailbox.inbox.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {threads.map((summary) => (
                <li key={summary.id}>
                  <button
                    type="button"
                    aria-current={summary.id === selectedId}
                    onClick={() => {
                      setSelectedId(
                        summary.id === selectedId ? null : summary.id,
                      );
                    }}
                    className={`flex min-h-11 w-full flex-col gap-2 rounded-control border px-3 py-3 text-left ${
                      summary.id === selectedId
                        ? "border-trust bg-trust-soft"
                        : "border-line bg-page"
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-3">
                      <span className="text-body font-semibold">
                        {summary.subject}
                      </span>
                      <BoardMailboxStatusChip status={summary.status} />
                      <span className="ml-auto font-data text-data text-ink-muted">
                        {formatMailboxDay(summary.lastMessageAt, i18n.language)}
                      </span>
                    </span>
                    <span className="text-small text-ink-muted">
                      {t("boardMailbox.inbox.summary", {
                        sender:
                          summary.correspondent.name ??
                          summary.correspondent.email,
                        count: summary.messageCount,
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {thread === null ? null : (
        <BoardMailboxThreadPanel thread={thread} onChanged={reload} />
      )}
    </div>
  );
}
