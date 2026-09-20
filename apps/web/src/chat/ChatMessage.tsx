import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ChatAuthor, ChatMessage as Message } from "../api/chat";
import { ASSOCIATION_TIME_ZONE } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, HINT, LABEL, QUIET_BUTTON } from "../ui/controls";
import { NotRecorded } from "../ui/NotRecorded";

/**
 * The longest note a report may carry.
 *
 * Mirrored from the API, like every other part of the contract in this client.
 * It is on the field so a reporter is stopped by the box rather than by a
 * refusal after they have written the paragraph.
 */
const REPORT_NOTE_MAX_LENGTH = 500;

/**
 * When a message was written, on the association's own clock.
 *
 * The day as well as the time, because a room is read days apart and a bare
 * time of day would put last Tuesday's line and this morning's beside each other
 * with nothing to tell them apart.
 *
 * On the association's clock rather than the reader's browser, and rather than
 * sliced out of the ISO string. Slicing reads the UTC day, which is the wrong
 * day for anything written after midnight in Stockholm summer time - a line
 * written at 01:30 on the 5th would be dated the 4th on its own author's screen.
 */
function writtenAt(instant: string, locale: string): string {
  const value = new Date(instant);
  return Number.isNaN(value.getTime())
    ? instant
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: ASSOCIATION_TIME_ZONE,
      }).format(value);
}

/**
 * Who wrote a message, as the room may say.
 *
 * A person with protected personal data is named to nobody here, every reader of
 * the room included: they each hold `protectedData:reveal` with their seat, but
 * that capability is what lets somebody perform an act of revealing and be
 * recorded doing it, and a name appearing in a room nothing audits is not that
 * act. A reference that no longer resolves says so rather than showing an empty
 * name - a message is erased on its own clock and a person can be purged out
 * from under one.
 */
function Author({ of }: { of: ChatAuthor }): ReactElement {
  const { t } = useTranslation();

  if (of.kind === "person") {
    return <span>{of.name}</span>;
  }
  if (of.kind === "protected") {
    return <NotRecorded meaning={t("chat.authorProtected")} />;
  }
  return <NotRecorded meaning={t("chat.authorUnknown")} />;
}

export interface ChatMessageProps {
  message: Message;
  /** Whether this account wrote it, which is the only thing that sets it apart. */
  mine: boolean;
  /**
   * Reports this message to the board, or null where there is nobody to report
   * it to.
   *
   * Null in the board chat, which has no strike-through at all, and null for a
   * message already struck: the board has answered about that one. A control
   * that was shown and then refused would be offering an act the product does
   * not have.
   */
  onReport: ((note: string) => Promise<boolean>) | null;
  /** Whether a report from this room is in flight, so two cannot be sent. */
  reporting: boolean;
}

/**
 * One line somebody wrote in a room.
 *
 * Three facts: who wrote it, when, and what they wrote. There is no edit, no
 * delete and no withdraw, by its author or by anybody else, and there is
 * deliberately no affordance suggesting otherwise - what somebody wrote is a
 * record of what was said, and the only thing that removes one is the retention
 * clock.
 *
 * The one control it can carry is in a group: reporting the message to the
 * board. That is the only thing that ever carries anything out of a room the
 * board cannot see, and what it carries is this message and nothing else. In the
 * board chat there is no control at all, because there is nobody to report a
 * board member's line to.
 *
 * A struck message stays exactly where it is with its author's name on it. What
 * changes is the text: withheld from the room, still shown to whoever wrote it
 * and to the board, and the screen renders the answer the server gave rather
 * than deciding it here.
 *
 * A reader's own message is marked, and only by weight and alignment of the
 * attribution rather than by colour: a room where one person's lines were a
 * different colour would be a room that read differently for each person looking
 * at it, and the theme decides colour.
 */
export function ChatMessage({
  message,
  mine,
  onReport,
  reporting,
}: ChatMessageProps): ReactElement {
  const { t, i18n } = useTranslation();

  return (
    <li className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-body font-semibold">
          <Author of={message.author} />
        </span>
        {message.struckAt === null ? null : (
          // The word as well as the tone: a reader who cannot tell the tones
          // apart still reads that this message was struck through.
          <span className="inline-flex items-center rounded-control border-l-4 border-warn bg-warn-soft px-2 py-1 text-chip text-ink uppercase">
            {t("chat.struck")}
          </span>
        )}
        {mine ? (
          // The word rather than a colour or a side: a reader who cannot tell
          // two tones apart still reads which line is their own.
          <span className="inline-flex items-center rounded-control border border-line px-2 py-1 text-chip text-ink-muted uppercase">
            {t("chat.you")}
          </span>
        ) : null}
        <span className="ml-auto font-data text-data text-ink-muted">
          <time dateTime={message.createdAt}>
            {writtenAt(message.createdAt, i18n.language)}
          </time>
        </span>
      </div>
      <MessageText message={message} />

      {onReport === null ? null : (
        <ReportControl
          author={message.author}
          reporting={reporting}
          onReport={onReport}
        />
      )}
    </li>
  );
}

/**
 * What a message says, or what happened to it.
 *
 * The three cases are written out rather than collapsed, because the middle one
 * is the whole of what moderation does here and this component must not be able
 * to fall into it by accident: a body that was absent for any reason other than
 * a strike-through would read as the board having taken text out of a room.
 */
function MessageText({ message }: { message: Message }): ReactElement {
  const { t } = useTranslation();

  if (message.struckAt === null) {
    return <p className="text-body whitespace-pre-line">{message.body}</p>;
  }
  if (message.body === null) {
    return (
      <p className="text-body text-ink-muted">{t("chat.struckWithheld")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-body whitespace-pre-line line-through decoration-line-strong">
        {message.body}
      </p>
      <p className={HINT}>{t("chat.struckReadable")}</p>
    </div>
  );
}

/**
 * Handing one message to the board.
 *
 * The note is asked for on the spot rather than in a dialog, and it is optional:
 * the message travels with the report, so somebody who has nothing to add should
 * not have to invent something. What the control says out loud is what reporting
 * does - the board reads this message, and nothing else about the room.
 */
function ReportControl({
  author,
  reporting,
  onReport,
}: {
  author: ChatAuthor;
  reporting: boolean;
  onReport: (note: string) => Promise<boolean>;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className={QUIET_BUTTON}
          aria-label={t("chat.reportNamed", { author: authorLabel(author, t) })}
          onClick={() => {
            setOpen(true);
          }}
        >
          {t("chat.report")}
        </button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-line pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onReport(note).then((sent) => {
          if (sent) {
            setNote("");
            setOpen(false);
          }
          return sent;
        });
      }}
    >
      <label className={LABEL}>
        {t("chat.reportNote")}
        <textarea
          className={`${FIELD} min-h-16 py-2`}
          value={note}
          maxLength={REPORT_NOTE_MAX_LENGTH}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </label>
      <p className={HINT}>{t("chat.reportHint")}</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={QUIET_BUTTON} disabled={reporting}>
          {reporting ? t("chat.reportSending") : t("chat.reportSubmit")}
        </button>
        <button
          type="button"
          className={QUIET_BUTTON}
          onClick={() => {
            setOpen(false);
          }}
        >
          {t("chat.reportCancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * The same attribution as one string, for the name a screen reader announces on
 * the report control.
 *
 * A sighted reader sees a sentence where an author cannot be named, and a
 * control announced as "report the message from - " would be announcing
 * punctuation. So the sentence the dash stands for is used instead.
 */
function authorLabel(
  of: ChatAuthor,
  t: (key: TranslationKey) => string,
): string {
  if (of.kind === "person") {
    return of.name;
  }
  return of.kind === "protected"
    ? t("chat.authorProtected")
    : t("chat.authorUnknown");
}
