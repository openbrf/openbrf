import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ChatAuthor, ChatMessage as Message } from "../api/chat";
import { ASSOCIATION_TIME_ZONE } from "../bookings/booking-calendar";
import { NotRecorded } from "../ui/NotRecorded";

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
}

/**
 * One line somebody wrote in a room.
 *
 * Three facts and no controls: who wrote it, when, and what they wrote. There is
 * nothing to do to a message and there is deliberately no affordance suggesting
 * otherwise - no edit, no delete, no withdraw, and no strike-through. What
 * somebody wrote is a record of what was said, and the only thing that removes
 * one is the retention clock.
 *
 * A reader's own message is marked, and only by weight and alignment of the
 * attribution rather than by colour: a room where one person's lines were a
 * different colour would be a room that read differently for each person looking
 * at it, and the theme decides colour.
 */
export function ChatMessage({ message, mine }: ChatMessageProps): ReactElement {
  const { t, i18n } = useTranslation();

  return (
    <li className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-body font-semibold">
          <Author of={message.author} />
        </span>
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
      <p className="text-body whitespace-pre-line">{message.body}</p>
    </li>
  );
}
