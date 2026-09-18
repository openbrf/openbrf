import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  fetchChats,
  markChatRead,
  messagesSince,
  readChat,
  writeMessage,
  type ChatMessage as Message,
  type ChatRoom,
} from "../api/chat";
import type { Viewer } from "../api/instance";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { usePoll } from "../ui/use-poll";
import { chatFailureKey } from "./chat-failures";
import { ChatMessage } from "./ChatMessage";

/**
 * The longest message the API stores.
 *
 * Mirrored rather than imported, like every other part of the contract in this
 * client. It is on the field so a writer is stopped by the box rather than by a
 * refusal after they have written the paragraph; the API enforces it either way,
 * and this number being wrong would cost somebody a refusal and nothing more.
 */
const MESSAGE_MAX_LENGTH = 2000;

/**
 * How often the screen asks what has been written since it last looked.
 *
 * Four seconds, recorded in ADR 0010. It is the only delivery path there is:
 * nothing is appended by this screen, so a message reaches it because a read
 * brought it. Fast enough that a board member typing at each other does not feel
 * they are sending letters, and slow enough that ten open screens are two and a
 * half requests a second against an index scan that answers nothing most of the
 * time.
 *
 * The poll runs only while the tab is being looked at - see `use-poll.ts`.
 */
const POLL_INTERVAL_MS = 4000;

/** The room on screen, as this client holds it. */
interface Conversation {
  chatId: string;
  /** Every message read so far, oldest first. */
  messages: readonly Message[];
  /** The cursor for the page before the oldest one here, or null at the start. */
  earlier: string | null;
  /** Where the poll asks from, or null while the room is empty. */
  cursor: string | null;
  failure: ApiFailure | null;
}

export interface ChatScreenProps {
  viewer: Viewer;
}

/**
 * The board's chat.
 *
 * ## Which rooms exist is the server's answer, and none is an answer
 *
 * The capability opens the endpoints and membership decides what is in them, and
 * the two are separate questions. An administrator holds every capability and no
 * board seat, so they reach this screen and are answered with no rooms at all -
 * which the screen says in words rather than rendering an empty room. That is
 * the one support question this feature was always going to generate, and the
 * sentence is the answer to it.
 *
 * ## Nothing is optimistic
 *
 * A written message is not appended to the list: the write clears the box and
 * asks the poll for a read, and what the reader sees is what came back. That is
 * what makes the poll the one delivery path rather than a second opinion about
 * one, and it is the news thread's own rule. The answer to a write is one
 * message and the room is the whole of it, so a list assembled from both is a
 * list nothing on the server ever said.
 *
 * ## The room arrives from both ends
 *
 * The first read answers the newest page and two cursors: one for the page
 * before it, which the reader asks for by pressing, and one for the poll, which
 * asks forwards. Pages are concatenated and never merged - each is a window no
 * other page overlaps - and the poll's answers are appended by identifier, so a
 * message that arrives twice is shown once.
 *
 * An empty room has no forward cursor, because there is no message to take one
 * from. The poll re-reads the newest page in that case rather than standing
 * still: a room nobody has written in yet is the one most likely to be sitting
 * open on somebody's screen.
 *
 * ## The read marker is the screen's own act
 *
 * It is posted with the instant of the newest message actually on screen rather
 * than with the moment of the call: a room marked read at "now" would mark a
 * message read that was written while the request was in flight and that nobody
 * has seen. It never moves backwards, so two tabs cannot un-read each other.
 *
 * The unread count is shown here rather than as a plate in the navigation band.
 * A plate would mean every screen in the product fetching the chat on every
 * navigation, for a number only this screen acts on - which is a request per
 * screen to decorate a link.
 */
export function ChatScreen({ viewer }: ChatScreenProps): ReactElement {
  const { t } = useTranslation();

  const [rooms, setRooms] = useState<readonly ChatRoom[] | null>(null);
  const [loadOutcome, setLoadOutcome] = useState<
    "reading" | "failed" | "notOffered"
  >("reading");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [reading, setReading] = useState(false);

  /*
   * One room today, and the screen is written so that a list of them is a
   * rendering change rather than a rewrite: what it holds is the room it is
   * reading, and the group half of the model is PR 7's.
   */
  const room = rooms?.[0] ?? null;
  const chatId = room?.id ?? null;

  /** A poll already in flight, so two do not ask from the same cursor at once. */
  const polling = useRef(false);

  /*
   * The cursor the poll asks from, held in a ref as well as in state. The loop
   * below reads it between requests, and reading it out of the closure would ask
   * every page from the cursor the callback was built with.
   */
  const cursorRef = useRef<string | null>(null);
  /*
   * Written after the render rather than during it: a ref assigned while
   * rendering is a side effect in a function React is allowed to call twice, and
   * nothing reads this one until a poll fires.
   */
  useEffect(() => {
    cursorRef.current = conversation?.cursor ?? null;
  }, [conversation?.cursor]);

  useEffect(() => {
    let abandoned = false;

    void (async () => {
      const result = await fetchChats();
      if (abandoned) {
        return;
      }
      if (!result.ok) {
        /*
         * A refusal by the guard is not a failure to answer, and saying "try
         * again" to somebody who holds no capability would be telling them a
         * part of the product is broken rather than not theirs.
         */
        setLoadOutcome(result.failure.status === 403 ? "notOffered" : "failed");
        return;
      }
      setRooms(result.value);
    })();

    return () => {
      abandoned = true;
    };
  }, []);

  useEffect(() => {
    if (chatId === null) {
      return;
    }
    let abandoned = false;

    void (async () => {
      const result = await readChat({ chatId, before: null });
      if (abandoned) {
        return;
      }
      setConversation(
        result.ok
          ? {
              chatId,
              messages: result.value.messages,
              earlier: result.value.earlier,
              cursor: result.value.latest,
              failure: null,
            }
          : {
              chatId,
              messages: [],
              earlier: null,
              cursor: null,
              failure: result.failure,
            },
      );
    })();

    return () => {
      abandoned = true;
    };
  }, [chatId]);

  /**
   * Asks what has arrived, and applies it if anybody still wants it.
   *
   * It carries on immediately while the server says more is waiting, so a screen
   * that was closed for a week catches up a page at a time rather than waiting
   * out an interval per page - and never asks for a week of messages in one
   * response, which is what the server's own bound is for.
   */
  const poll = useCallback(
    async (stillWanted: () => boolean): Promise<void> => {
      if (chatId === null || polling.current) {
        return;
      }
      polling.current = true;
      try {
        for (;;) {
          const after = cursorRef.current;
          if (!stillWanted()) {
            return;
          }

          if (after === null) {
            /*
             * An empty room has no cursor to ask from, so the poll re-reads the
             * newest page instead of asking what is newer than nothing.
             *
             * Without this the poll would not start until the room already had
             * a message in it, which is exactly backwards: a board member who
             * opens a room before anybody has written in it would sit watching
             * it and never see the first line arrive, and nor would whoever
             * wrote it. One re-read, and the cursor it comes back with takes
             * over from the next attempt.
             */
            const first = await readChat({ chatId, before: null });
            if (!stillWanted() || !first.ok) {
              return;
            }
            setConversation((held) =>
              held === null || held.chatId !== chatId
                ? held
                : {
                    ...held,
                    messages: appendNew(held.messages, first.value.messages),
                    earlier: first.value.earlier,
                    cursor: first.value.latest,
                  },
            );
            return;
          }

          const result = await messagesSince({ chatId, after });
          if (!stillWanted()) {
            return;
          }
          if (!result.ok) {
            /*
             * A failed poll is left silent, unlike a failed read. The room on
             * screen is still what the server last said, nothing the reader did
             * has failed, and a notice appearing by itself every four seconds on
             * a flaky connection would be worse than the gap it reports.
             */
            return;
          }

          const update = result.value;
          setConversation((held) =>
            held === null || held.chatId !== chatId
              ? held
              : {
                  ...held,
                  messages: appendNew(held.messages, update.messages),
                  cursor: update.cursor,
                },
          );
          if (!update.more) {
            return;
          }
        }
      } finally {
        polling.current = false;
      }
    },
    [chatId],
  );

  /*
   * Enabled as soon as a room is open, cursor or no cursor. An empty room is
   * the one a reader is most likely to be watching, and gating the poll on
   * having a cursor would leave it silent until somebody had already written.
   */
  usePoll(poll, {
    intervalMs: POLL_INTERVAL_MS,
    enabled: conversation !== null,
  });

  const newest = conversation?.messages.at(-1)?.createdAt ?? null;
  /*
   * Named once, so the control below depends on the cursor rather than on the
   * whole conversation - which changes on every poll and would rebuild the
   * callback four times a minute for nothing.
   */
  const earlierCursor = conversation?.earlier ?? null;

  useEffect(() => {
    if (chatId === null || newest === null) {
      return;
    }
    let abandoned = false;

    void (async () => {
      const result = await markChatRead({ chatId, readAt: newest });
      if (abandoned || !result.ok) {
        // Nothing is said about a marker that did not land. It decides a count
        // on a screen and nothing about what anybody may read, so a notice here
        // would report a failure the reader can neither act on nor care about.
        return;
      }
      setRooms(
        (held) =>
          held?.map((each) =>
            each.id === chatId ? { ...each, unread: 0 } : each,
          ) ?? null,
      );
    })();

    return () => {
      abandoned = true;
    };
  }, [chatId, newest]);

  /** Reads the page before the oldest one on screen and puts it in front. */
  const showEarlier = useCallback(async (): Promise<void> => {
    if (chatId === null || earlierCursor === null) {
      return;
    }
    setReading(true);
    const before = earlierCursor;
    const result = await readChat({ chatId, before });
    setReading(false);
    if (!result.ok) {
      setConversation((held) =>
        held === null ? held : { ...held, failure: result.failure },
      );
      return;
    }
    setConversation((held) =>
      held === null || held.chatId !== chatId || held.earlier !== before
        ? // A page already applied, or a room that changed under it: applying
          // this one again would show every message on it twice.
          held
        : {
            ...held,
            // In front, because older messages were written first and so read
            // first. Pages never overlap, so this is concatenation rather than
            // arithmetic about a message.
            messages: [...result.value.messages, ...held.messages],
            earlier: result.value.earlier,
            failure: null,
          },
    );
  }, [chatId, earlierCursor]);

  const send = useSaveAction(writeMessage, () => {
    setDraft("");
    // A read rather than an append. The message arrives because the server said
    // it is there, which is the same way everybody else's arrives.
    void poll(() => true);
  });
  const sending = send.state.kind === "saving";

  const failure =
    send.state.kind === "failed"
      ? send.state.failure
      : (conversation?.failure ?? null);

  if (loadOutcome === "failed") {
    return (
      <Notice tone="danger" live>
        {t("chat.loadFailed")}
      </Notice>
    );
  }

  if (loadOutcome === "notOffered") {
    return (
      <Panel title={t("chat.title")} description={t("chat.intro")}>
        <Notice tone="info">{t("chat.notOffered")}</Notice>
      </Panel>
    );
  }

  if (rooms === null) {
    return (
      <p role="status" className="text-body text-ink-muted">
        {t("chat.loading")}
      </p>
    );
  }

  if (room === null) {
    /*
     * The administrator's answer, and it has to be a sentence rather than an
     * empty room. They hold every capability and no seat, so the navigation
     * offers them this destination and the endpoints let them in - and what they
     * find is that membership is the other question and it is answered by an
     * election rather than by a grant.
     */
    return (
      <Panel title={t("chat.title")} description={t("chat.intro")}>
        <Notice tone="info">{t("chat.noRoom")}</Notice>
      </Panel>
    );
  }

  return (
    <Panel
      title={room.name ?? t("chat.boardChat")}
      description={t("chat.description")}
      notice={
        failure !== null ? (
          <Notice tone="danger" live>
            {t(chatFailureKey(failure))}
          </Notice>
        ) : null
      }
      actions={
        <button
          type="submit"
          form="write-chat-message"
          className={PRIMARY_BUTTON}
          disabled={sending || draft.trim() === ""}
        >
          {sending ? t("chat.sending") : t("chat.submit")}
        </button>
      }
    >
      {room.unread > 0 ? (
        <p className={HINT}>{t("chat.unread", { count: room.unread })}</p>
      ) : null}

      {conversation === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("chat.reading")}
        </p>
      ) : conversation.messages.length === 0 ? (
        <p className="text-body text-ink-muted">{t("chat.empty")}</p>
      ) : (
        <>
          {conversation.earlier === null ? null : (
            /*
             * Above the messages, because that is where the ones it fetches go.
             * The reader is looking at the newest page and reaching backwards,
             * so the control belongs at the end they are reaching from.
             */
            <div>
              <button
                type="button"
                className={QUIET_BUTTON}
                disabled={reading}
                onClick={() => {
                  void showEarlier();
                }}
              >
                {reading ? t("chat.earlierReading") : t("chat.earlier")}
              </button>
            </div>
          )}

          <ul className="flex flex-col gap-3">
            {conversation.messages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                mine={
                  message.author.kind === "person" &&
                  message.author.personId === viewer.personId
                }
              />
            ))}
          </ul>
        </>
      )}

      <form
        id="write-chat-message"
        className="flex flex-col gap-2 border-t border-line pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send.submit({ chatId: room.id, body: draft });
        }}
      >
        <label className={LABEL}>
          {t("chat.field")}
          <textarea
            className={`${FIELD} min-h-24 py-2`}
            value={draft}
            maxLength={MESSAGE_MAX_LENGTH}
            required
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </label>
        <p className={HINT}>{t("chat.hint")}</p>
      </form>
    </Panel>
  );
}

/**
 * The messages on screen with whatever the poll brought, minus anything already
 * there.
 *
 * A free function because it is the one piece of arithmetic this screen does and
 * it is worth being able to assert on its own. The cursor should make a repeat
 * impossible; a manual read after a write and an interval that fired at the same
 * moment can still ask from the same place, and a message shown twice in a room
 * that cannot be edited is a defect nobody can clear.
 */
function appendNew(
  held: readonly Message[],
  arriving: readonly Message[],
): readonly Message[] {
  if (arriving.length === 0) {
    return held;
  }
  const known = new Set(held.map((message) => message.id));
  const fresh = arriving.filter((message) => !known.has(message.id));
  return fresh.length === 0 ? held : [...held, ...fresh];
}
