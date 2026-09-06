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
  /** What to ask for to read the next page, or null when there is none. */
  nextCursor: string | null;
  thread: BoardMailboxThread | null;
  loadFailed: boolean;
}

/**
 * Pages read past the first, and which load they were read against.
 *
 * `of` is compared by identity: a fresh read of the inbox is a different object,
 * and the pages appended to the one before it are a different list.
 */
interface AppendedPages {
  rows: readonly BoardMailboxThreadSummary[];
  cursor: string | null;
  of: Loaded | null;
}

const NO_APPENDED: AppendedPages = { rows: [], cursor: null, of: null };

const EMPTY: Loaded = {
  ready: false,
  status: null,
  threads: [],
  nextCursor: null,
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
      nextCursor: threads.ok ? threads.value.nextCursor : null,
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

  const { ready, status, threads, nextCursor, thread, loadFailed } = loaded;

  /*
   * The pages read past the first one.
   *
   * Held against the load they belong to and read during render rather than
   * cleared by an effect: every act on a thread and every collection re-reads
   * the inbox from its start, and a page appended to a list rebuilt underneath
   * it would show the same threads twice. What belongs to a previous load is
   * simply not what is listed.
   */
  const [pages, setPages] = useState<AppendedPages>(NO_APPENDED);
  const [readingMore, setReadingMore] = useState(false);
  const appended = pages.of === loaded ? pages : NO_APPENDED;

  const cursor = appended.of === null ? nextCursor : appended.cursor;
  const listed = [...threads, ...appended.rows];

  const readMore = useCallback((): void => {
    if (cursor === null) {
      return;
    }
    setReadingMore(true);
    void fetchBoardMailboxThreads(cursor).then((page) => {
      setReadingMore(false);
      if (!page.ok) {
        return;
      }
      setPages((held) => ({
        rows: [...(held.of === loaded ? held.rows : []), ...page.value.threads],
        cursor: page.value.nextCursor,
        of: loaded,
      }));
    });
  }, [cursor, loaded]);

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
        >
          {listed.length === 0 ? (
            <p className="text-body text-ink-muted">
              {t("boardMailbox.inbox.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {listed.map((summary) => (
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

          {/*
            A control and not only a warning. The inbox is read a page at a time
            because how many threads there are is decided outside the
            association, and a bound with nothing behind it would put the
            conversations the board has finished with out of reach altogether.
          */}
          {cursor === null ? null : (
            <button
              type="button"
              disabled={readingMore}
              onClick={readMore}
              className={SECONDARY_BUTTON}
            >
              {readingMore
                ? t("boardMailbox.inbox.reading")
                : t("boardMailbox.inbox.more")}
            </button>
          )}
        </Panel>
      )}

      {thread === null ? null : (
        <BoardMailboxThreadPanel thread={thread} onChanged={reload} />
      )}
    </div>
  );
}
