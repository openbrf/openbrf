import { MAX_REPLY_CHARACTERS } from "@openbrf/shared";
import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type BoardMailboxMember,
  type BoardMailboxMessage,
  type BoardMailboxThread,
  releaseBoardMailboxThread,
  replyToBoardMailboxThread,
  setBoardMailboxThreadClosed,
  takeBoardMailboxThread,
} from "../api/board-mailbox";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { formatMailboxMoment } from "./board-mailbox-dates";
import { BoardMailboxStatusChip } from "./BoardMailboxStatusChip";

const THREAD_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "thread-not-found": "boardMailbox.errors.threadNotFound",
  "thread-closed": "boardMailbox.errors.threadClosed",
  "mailbox-not-configured": "boardMailbox.errors.notConfigured",
  "empty-reply": "boardMailbox.errors.emptyReply",
  "invalid-body": "boardMailbox.errors.unknown",
};

/**
 * Why a reply did not go out, in the board's own words.
 *
 * The server sends a code and never the mail server's prose, because a rejection
 * quotes the envelope back and the envelope is somebody's address. What the
 * board is shown is the class of the failure and, for the two it can act on,
 * what to do about it.
 */
const DELIVERY_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "mail-not-configured": "boardMailbox.delivery.mailNotConfigured",
  "send-failed": "boardMailbox.delivery.refused",
  "thread-gone": "boardMailbox.delivery.threadGone",
  "reply-sending-interrupted": "boardMailbox.delivery.interrupted",
};

export interface BoardMailboxThreadPanelProps {
  thread: BoardMailboxThread;
  /** Called after any change, so the screen can re-read the inbox. */
  onChanged: () => void;
}

/**
 * One conversation: what was written to the board, and what the board answered.
 *
 * The reply form is on the panel rather than behind a control, because a board
 * member who opened a letter is nearly always about to answer it - and it is
 * absent altogether on a closed thread, which is not a styling choice. The
 * server refuses a reply to a closed thread, and a screen offers no control the
 * server would refuse: the board reopens the thread first, which is a decision
 * it takes rather than one the software makes on its behalf.
 */
export function BoardMailboxThreadPanel({
  thread,
  onChanged,
}: BoardMailboxThreadPanelProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  const take = useSaveAction(takeBoardMailboxThread, onChanged);
  const release = useSaveAction(releaseBoardMailboxThread, onChanged);
  const close = useSaveAction(setBoardMailboxThreadClosed, onChanged);
  const reply = useSaveAction(replyToBoardMailboxThread, () => {
    setDraft("");
    onChanged();
  });

  const busy =
    take.state.kind === "saving" ||
    release.state.kind === "saving" ||
    close.state.kind === "saving" ||
    reply.state.kind === "saving";

  const failure =
    take.state.kind === "failed"
      ? take.state.failure
      : release.state.kind === "failed"
        ? release.state.failure
        : close.state.kind === "failed"
          ? close.state.failure
          : reply.state.kind === "failed"
            ? reply.state.failure
            : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void reply.submit({ threadId: thread.id, body: draft });
  };

  return (
    <Panel
      title={thread.subject}
      description={t("boardMailbox.thread.from", {
        sender: thread.correspondent.name ?? thread.correspondent.email,
        email: thread.correspondent.email,
      })}
      notice={
        failure !== null ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                failure,
                THREAD_FAILURES,
                "boardMailbox.errors.unknown",
              ),
            )}
          </Notice>
        ) : reply.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("boardMailbox.thread.replyQueued")}
          </Notice>
        ) : null
      }
      actions={
        <span className="flex flex-wrap items-center gap-2">
          <BoardMailboxStatusChip status={thread.status} />
          {thread.status === "CLOSED" ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void take.submit({ threadId: thread.id });
              }}
              className={SECONDARY_BUTTON}
            >
              {t("boardMailbox.thread.take")}
            </button>
          )}
          {thread.takenBy === null || thread.status === "CLOSED" ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void release.submit({ threadId: thread.id });
              }}
              className={QUIET_BUTTON}
            >
              {t("boardMailbox.thread.release")}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void close.submit({
                threadId: thread.id,
                closed: thread.status !== "CLOSED",
              });
            }}
            className={QUIET_BUTTON}
          >
            {t(
              thread.status === "CLOSED"
                ? "boardMailbox.thread.reopen"
                : "boardMailbox.thread.close",
            )}
          </button>
        </span>
      }
    >
      <p className="text-small text-ink-muted">
        {thread.takenBy === null
          ? t("boardMailbox.thread.nobodyHasIt")
          : t("boardMailbox.thread.heldBy", {
              name: memberName(thread.takenBy, t),
            })}
      </p>

      {/*
        A warning on the thread itself rather than only in the documentation.
        Everything below arrived from outside the association, and the two things
        a board member is most likely to do wrong with it - believe the name on
        it, and act on a request to change a bank account - are both consequences
        of forgetting that.
      */}
      <Notice tone="info">{t("boardMailbox.thread.untrusted")}</Notice>

      {thread.messageCount > thread.messages.length ? (
        <p className="text-small text-ink-muted">
          {t("boardMailbox.thread.olderNotShown", {
            shown: thread.messages.length,
            total: thread.messageCount,
          })}
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {thread.messages.map((message) => (
          <li key={message.id}>
            <Message message={message} />
          </li>
        ))}
      </ul>

      {thread.status === "CLOSED" ? (
        <p className="text-small text-ink-muted">
          {t("boardMailbox.thread.closedNoReply")}
        </p>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <label className={LABEL}>
            {t("boardMailbox.thread.replyLabel")}
            {/*
              Bounded here at the number the server takes. A draft the field let
              the board member finish and the server then refuses is refused
              after the writing, and a length is not something the screen can
              explain afterwards: the reply route answers a validation failure
              with a code this panel has no sentence for.
            */}
            <textarea
              name="boardMailboxReply"
              rows={6}
              maxLength={MAX_REPLY_CHARACTERS}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              className={`${FIELD} py-2`}
            />
          </label>
          <span className="text-small text-ink-muted">
            {t("boardMailbox.thread.replyRemaining", {
              count: MAX_REPLY_CHARACTERS - draft.length,
            })}
          </span>
          <span className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || draft.trim() === ""}
              className={PRIMARY_BUTTON}
            >
              {reply.state.kind === "saving"
                ? t("boardMailbox.thread.replying")
                : t("boardMailbox.thread.reply")}
            </button>
            <span className="text-small text-ink-muted">
              {t("boardMailbox.thread.replyGoesTo", {
                email: thread.correspondent.email,
              })}
            </span>
          </span>
        </form>
      )}
    </Panel>
  );
}

/** One message, in either direction. */
function Message({ message }: { message: BoardMailboxMessage }): ReactElement {
  const { t, i18n } = useTranslation();
  const inbound = message.direction === "INBOUND";

  return (
    <div
      className={`flex flex-col gap-2 rounded-control border px-3 py-3 ${
        inbound ? "border-line bg-page" : "border-line-strong bg-sunken"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-small font-semibold">
          {inbound
            ? t("boardMailbox.message.received")
            : t("boardMailbox.message.sentBy", {
                name:
                  message.sentBy === null
                    ? t("boardMailbox.member.unknown")
                    : memberName(message.sentBy, t),
              })}
        </span>
        <span className="ml-auto font-data text-data text-ink-muted">
          {formatMailboxMoment(message.occurredAt, i18n.language)}
        </span>
      </div>

      {message.bodyFromHtml ? (
        <p className={"text-small text-ink-muted"}>
          {t("boardMailbox.message.fromHtml")}
        </p>
      ) : null}

      {/*
        Text, always: the server keeps no markup at all, so this is the sender's
        words rather than a rendering of them, and React escapes it like any
        other child. `whitespace-pre-line` keeps the paragraph breaks somebody
        typed, which are part of what they wrote.
      */}
      <p className="text-small whitespace-pre-line">{message.body}</p>

      {message.bodyTruncated ? (
        <p className="text-small text-ink-muted">
          {t("boardMailbox.message.truncated")}
        </p>
      ) : null}

      {message.attachments.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <li key={attachment.id}>
              <a
                href={attachment.url}
                className={QUIET_BUTTON}
                rel="noreferrer"
              >
                {attachment.fileName}
              </a>
            </li>
          ))}
        </ul>
      )}

      {message.attachmentsDropped > 0 ? (
        <p className="text-small text-ink-muted">
          {t("boardMailbox.message.attachmentsDropped", {
            count: message.attachmentsDropped,
          })}
        </p>
      ) : null}

      {message.delivery === null ? null : (
        <p className="text-small text-ink-muted">
          {message.delivery.status === "FAILED"
            ? t(deliveryFailureKey(message.delivery.failure))
            : message.delivery.status === "PENDING"
              ? t("boardMailbox.delivery.pending")
              : t("boardMailbox.delivery.sent")}
        </p>
      )}
    </div>
  );
}

/**
 * The sentence for a delivery failure.
 *
 * Hoisted out of the markup rather than written inline, because the expression
 * that chooses it is a conditional inside a translation call inside an attribute
 * position, and that is the shape the parser used by the security scan reads
 * only partly - which fails the build without naming the file.
 */
function deliveryFailureKey(failure: string | null): TranslationKey {
  if (failure === null) {
    return "boardMailbox.delivery.unknown";
  }
  return DELIVERY_FAILURES[failure] ?? "boardMailbox.delivery.unknown";
}

/**
 * A board member's name, or what stands in for it.
 *
 * A person with protected personal data is not named here even though the
 * board's own address book names them: that register has a statutory reason to
 * print a name and this screen has none, and unlike the address book there is no
 * audited reveal behind it. The server sends no name either, so this is the
 * screen rendering the answer it was given rather than deciding it in the
 * browser.
 */
function memberName(
  member: BoardMailboxMember,
  t: (key: TranslationKey) => string,
): string {
  if (member.kind === "member") {
    return member.name;
  }
  if (member.kind === "protected") {
    return t("boardMailbox.member.protected");
  }
  return t("boardMailbox.member.unknown");
}
