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
  type BoardMailboxSetAside,
  type BoardMailboxStatus,
  type BoardMailboxThread,
  type BoardMailboxThreadSummary,
  collectBoardMailbox,
  fetchBoardMailboxStatus,
  fetchBoardMailboxThread,
  fetchBoardMailboxThreads,
} from "../api/board-mailbox";
import type { TranslationKey } from "../i18n/translation-key";
import { BoardPageTitle } from "../ui/BoardPage";
import { SECONDARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { formatMailboxDay, formatMailboxMoment } from "./board-mailbox-dates";
import { BoardMailboxStatusChip } from "./BoardMailboxStatusChip";
import { BoardMailboxThreadPanel } from "./BoardMailboxThreadPanel";

const COLLECT_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "mailbox-not-configured": "boardMailbox.errors.notConfigured",
  "mailbox-unreachable": "boardMailbox.errors.unreachable",
  "mailbox-sign-in-refused": "boardMailbox.errors.signInRefused",
  // A server saved before private hosts were refused, or a name that has
  // since moved to one.
  "host-not-public": "boardMailbox.errors.hostNotPublic",
};

const SET_ASIDE_REASONS: Readonly<Record<string, TranslationKey>> = {
  "no-sender-address": "boardMailbox.setAside.reasons.noSenderAddress",
  unstorable: "boardMailbox.setAside.reasons.unstorable",
  "too-large": "boardMailbox.setAside.reasons.tooLarge",
  "too-slow": "boardMailbox.setAside.reasons.tooSlow",
};

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  status: BoardMailboxStatus | null;
  threads: readonly BoardMailboxThreadSummary[];
  /** What to ask for to read the next page, or null when there is none. */
  nextCursor: string | null;
  loadFailed: boolean;
}

/** The thread open on screen, as last read, and which one it is. */
interface Opened {
  id: string;
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
  /** First-page threads a later page answered again, as that page said them. */
  newer: ReadonlyMap<string, BoardMailboxThreadSummary>;
  cursor: string | null;
  of: Loaded | null;
}

const NO_APPENDED: AppendedPages = {
  rows: [],
  newer: new Map(),
  cursor: null,
  of: null,
};

const EMPTY: Loaded = {
  ready: false,
  status: null,
  threads: [],
  nextCursor: null,
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

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * One rule for the first read and every re-read, on the precedent the issues
   * and motions screens set. It matters here because the screen re-reads after
   * every act on a thread and after every collection, so two reads in flight is
   * ordinary rather than a race nobody could reach - and an older answer landing
   * after a newer one would put a thread back into the state it had just left.
   *
   * The inbox only. Opening a thread reads that thread and leaves the inbox
   * alone: a fresh read of it would drop the pages read past the first, and with
   * them the thread just opened from one of them.
   */
  const reload = useCallback((): void => {
    const version = ++currentRead.current;
    void Promise.all([
      fetchBoardMailboxStatus(),
      fetchBoardMailboxThreads(),
    ]).then(([status, threads]) => {
      if (version === currentRead.current) {
        setLoaded({
          ready: true,
          status: status.ok ? status.value : null,
          threads: threads.ok ? threads.value.threads : [],
          nextCursor: threads.ok ? threads.value.nextCursor : null,
          loadFailed: !status.ok || !threads.ok,
        });
      }
    });
  }, []);

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

  const [opened, setOpened] = useState<Opened | null>(null);
  const currentThreadRead = useRef(0);

  /** Reads the open thread, on the same newest-answer-wins rule as the inbox. */
  const reloadThread = useCallback((): void => {
    const version = ++currentThreadRead.current;
    if (selectedId === null) {
      return;
    }
    void fetchBoardMailboxThread(selectedId).then((result) => {
      if (version === currentThreadRead.current) {
        setOpened({
          id: selectedId,
          thread: result.ok ? result.value : null,
          loadFailed: !result.ok,
        });
      }
    });
  }, [selectedId]);

  useEffect(() => {
    reloadThread();
    return () => {
      currentThreadRead.current += 1;
    };
  }, [reloadThread]);

  /** An act on the thread changes the thread and its row in the inbox. */
  const reloadAll = useCallback((): void => {
    reload();
    reloadThread();
  }, [reload, reloadThread]);

  /*
   * Which thread is selected now, for an act that lands after the board has
   * opened another: its panel is gone, and the callback it held reads the
   * thread it was opened on. Read again, that thread's answer would supersede
   * the one being opened and leave the screen with no thread on it.
   */
  const selectedNow = useRef<string | null>(null);
  useEffect(() => {
    selectedNow.current = selectedId;
  }, [selectedId]);

  /** An act on one thread: the inbox always, the thread while it is open. */
  const threadChanged = useCallback(
    (id: string): void => {
      reload();
      if (id === selectedNow.current) {
        reloadThread();
      }
    },
    [reload, reloadThread],
  );

  /*
   * The open thread's read as it is now, for a collection that lands after the
   * board has opened another. The answer is handled by the callback the
   * collection started with, and the read that callback held is of the thread
   * open then - read again, it would supersede the one being opened.
   */
  const reloadThreadNow = useRef(reloadThread);
  useEffect(() => {
    reloadThreadNow.current = reloadThread;
  }, [reloadThread]);

  const [collection, setCollection] = useState<BoardMailboxCollection | null>(
    null,
  );
  /*
   * The open thread as well as the inbox. A collected letter can join the
   * thread on screen and reopen it if it was closed, and a panel left as it was
   * would show the closed thread without the letter beside an inbox row saying
   * otherwise.
   */
  const collect = useSaveAction(collectBoardMailbox, (result) => {
    setCollection(result);
    reload();
    reloadThreadNow.current();
  });

  const { ready, status, threads, nextCursor } = loaded;
  /*
   * Only the selected thread's own answer. Until it arrives nothing is shown:
   * the thread being left is not this one.
   */
  const current = opened !== null && opened.id === selectedId ? opened : null;
  const thread = current?.thread ?? null;
  const loadFailed = loaded.loadFailed || current?.loadFailed === true;

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
  /** The load a "more" read failed against, held like the pages it failed to add. */
  const [moreFailedFor, setMoreFailedFor] = useState<Loaded | null>(null);
  const appended = pages.of === loaded ? pages : NO_APPENDED;

  const cursor = appended.of === null ? nextCursor : appended.cursor;
  const listed = [
    ...threads.map((row) => appended.newer.get(row.id) ?? row),
    ...appended.rows,
  ];

  const readMore = useCallback((): void => {
    if (cursor === null) {
      return;
    }
    setReadingMore(true);
    setMoreFailedFor(null);
    void fetchBoardMailboxThreads(cursor).then((page) => {
      setReadingMore(false);
      if (!page.ok) {
        setMoreFailedFor(loaded);
        return;
      }
      setPages((held) => {
        const rows = held.of === loaded ? held.rows : [];
        const newer = new Map(held.of === loaded ? held.newer : []);
        /*
         * The server sorts by status and last message but pages by an id
         * cursor, so a thread that changed between two reads can be on both
         * pages. It is listed once, where it was first seen, and with what the
         * later page says of it: that is the read that saw the change.
         */
        const answered = new Map(
          page.value.threads.map((row) => [row.id, row]),
        );
        const firstPage = new Set(loaded.threads.map((row) => row.id));
        const seen = new Set([...firstPage, ...rows.map((row) => row.id)]);
        for (const id of firstPage) {
          const row = answered.get(id);
          if (row !== undefined) {
            newer.set(id, row);
          }
        }
        return {
          rows: [
            ...rows.map((row) => answered.get(row.id) ?? row),
            ...page.value.threads.filter((row) => !seen.has(row.id)),
          ],
          newer,
          cursor: page.value.nextCursor,
          of: loaded,
        };
      });
    });
  }, [cursor, loaded]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <BoardPageTitle>{t("boardMailbox.title")}</BoardPageTitle>
        <p className="text-body text-ink-muted">{t("boardMailbox.intro")}</p>
      </header>

      {loadFailed ? (
        <LoadFailure messageKey="boardMailbox.loadFailed" onRetry={reloadAll} />
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
          {status.setAsideCount > 0 ? (
            <SetAsideLetters
              letters={status.setAside}
              count={status.setAsideCount}
            />
          ) : null}
        </Panel>
      )}

      {!ready ? null : (
        <Panel
          title={t("boardMailbox.inbox.title")}
          description={t("boardMailbox.inbox.description")}
          notice={
            moreFailedFor === loaded ? (
              <Notice tone="danger" live>
                {t("boardMailbox.inbox.moreFailed")}
              </Notice>
            ) : null
          }
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
                        correspondent:
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
        <BoardMailboxThreadPanel
          // A different thread is a different panel: the reply typed in it and
          // the outcome of the last act on it are that thread's alone.
          key={thread.id}
          thread={thread}
          onChanged={() => {
            threadChanged(thread.id);
          }}
        />
      )}
    </div>
  );
}

/**
 * The letters the collection read and did not store.
 *
 * On the screen because each one is a letter the board has not read and would
 * otherwise never hear of: it is not in the inbox, and it is still in the
 * mailbox. What the board is given is what finds it there - the date the letter
 * carried - and why it was left, and nothing the sender wrote.
 */
function SetAsideLetters({
  letters,
  count,
}: {
  letters: readonly BoardMailboxSetAside[];
  count: number;
}): ReactElement {
  const { t, i18n } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      {/* Live, because a collection from this screen can change it. */}
      <Notice tone="warn" live>
        {t("boardMailbox.setAside.intro", { count })}
      </Notice>
      <ul className="flex flex-col gap-1">
        {letters.map((letter, position) => (
          <li
            // The rows carry no identifier, and the list is replaced whole on
            // every read rather than edited.
            key={position}
            className="flex flex-wrap gap-x-3 text-small"
          >
            <span className="font-semibold">
              {t(
                SET_ASIDE_REASONS[letter.reason] ??
                  "boardMailbox.setAside.reasons.unknown",
              )}
            </span>
            <span className="font-data">
              {letter.letterDate === null
                ? t("boardMailbox.setAside.undated")
                : t("boardMailbox.setAside.dated", {
                    date: formatMailboxMoment(letter.letterDate, i18n.language),
                  })}
            </span>
            <span className="font-data text-ink-muted">
              {t("boardMailbox.setAside.setAsideAt", {
                date: formatMailboxDay(letter.setAsideAt, i18n.language),
              })}
            </span>
            {letter.retryAt === null ? null : (
              <span className="font-data text-ink-muted">
                {t("boardMailbox.setAside.retryFrom", {
                  date: formatMailboxMoment(letter.retryAt, i18n.language),
                })}
              </span>
            )}
          </li>
        ))}
      </ul>
      {count > letters.length ? (
        <p className="text-small text-ink-muted">
          {t("boardMailbox.setAside.more", { count: count - letters.length })}
        </p>
      ) : null}
    </div>
  );
}
