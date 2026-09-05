import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  MEETING_AGENDA_MAX_ITEMS,
  MEETING_AGENDA_TITLE_MAX,
  type Meeting,
  setMeetingAgenda,
} from "../api/meetings";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { meetingFailureKey } from "./meeting-failures";

export interface MeetingAgendaPanelProps {
  meeting: Meeting;
  onChanged: () => void;
}

/**
 * One row of the draft: a title, and something to key it by while it moves.
 *
 * The key is not the position. These rows are reordered and removed, and React
 * keyed by index would carry the text of the row that used to be third into the
 * field that is now third - which is what makes a moved item look like an edited
 * one and puts the cursor in the wrong box. It is not an identifier either: an
 * agenda item has none until the server has written it.
 */
interface DraftItem {
  key: number;
  title: string;
}

/**
 * The counter the draft rows are keyed from.
 *
 * Module-level rather than a ref on the component, because the first rows are
 * built while the panel is still rendering for the first time and a ref may not
 * be read during render. Sharing one counter across every instance of the panel
 * costs nothing: a key has to be unique within its own list, and a number that
 * only ever goes up is unique everywhere.
 */
let nextDraftKey = 0;

/** The rows a list of titles becomes, each with a key of its own. */
function draftFrom(values: readonly string[]): DraftItem[] {
  return values.map((title) => {
    nextDraftKey += 1;
    return { key: nextDraftKey, title };
  });
}

/**
 * The running order (dagordningen), and the two things that put it beyond
 * reach.
 *
 * ## Why the whole order is written at once
 *
 * The endpoint takes the agenda as a list and writes the positions from it, so
 * this panel edits a draft of the whole running order and sends it in one act.
 * That is the shape of the thing rather than a convenience: moving an item is
 * the same act as adding one, and an interface that offered both would have to
 * reconcile two orderings. The numbers are never stated here - a caller that
 * stated its own could state a gap or a repeat, which is not a running order.
 *
 * ## When it is a form and when it is a record
 *
 * Two dates decide, in this order, and both are on the meeting the screen read.
 *
 * The notice binds first and binds harder. EFL 6 kap. 22 § has the notice state
 * clearly the matters the meeting is to deal with, and 6 kap. 25 § leaves the
 * meeting unable to decide a matter its notice did not take up without the
 * consent of every member the failure affects. So from the moment the members
 * are summoned, these rows are what they were summoned to - and the remedy for a
 * notice that went wrong is an extra general meeting rather than a second
 * notice.
 *
 * Recording the meeting as held binds afterwards, for a different reason: the
 * endpoint replaces the agenda by deleting and rewriting it, which would discard
 * the minute of a decision recorded against an item that went.
 *
 * Both are rendered as a statement with the order beneath it, never as a
 * disabled form. A board reading "you cannot change this" wants to know which of
 * the two rules is holding, because one of them is answered by arranging another
 * meeting and the other is not answered at all.
 *
 * ## The draft is seeded once and then owned here
 *
 * The rows below are this panel's own state from the moment it mounts, because
 * they are a draft the board is part way through typing. The screen remounts it
 * on the agenda the server answered with - see the key it gives this panel - so
 * a save that landed is what replaces the draft, rather than every re-read
 * overwriting whatever is half-typed.
 */
export function MeetingAgendaPanel({
  meeting,
  onChanged,
}: MeetingAgendaPanelProps): ReactElement {
  const { t } = useTranslation();

  const summoned = meeting.notice !== null;
  const held = meeting.concludedAt !== null;
  const editable = !summoned && !held;

  const [items, setItems] = useState<readonly DraftItem[]>(() =>
    draftFrom(
      meeting.agenda.length === 0 ? [""] : meeting.agenda.map((it) => it.title),
    ),
  );

  const save = useSaveAction(setMeetingAgenda);

  const stated = items
    .map((item) => item.title.trim())
    .filter((title) => title !== "");
  const tooMany = stated.length > MEETING_AGENDA_MAX_ITEMS;
  /*
   * An agenda with nothing on it is refused here as well as at the API, and the
   * reason is the notice rather than the table: a meeting with no matters to
   * deal with is one nobody can be summoned to.
   */
  const sendable = stated.length > 0 && !tooMany;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!sendable) {
      return;
    }
    void save
      .submit({
        id: meeting.id,
        values: { items: stated.map((title) => ({ title })) },
      })
      .then(() => {
        onChanged();
      });
  };

  const change = (key: number, title: string): void => {
    setItems((rows) =>
      rows.map((row) => (row.key === key ? { ...row, title } : row)),
    );
  };

  const remove = (key: number): void => {
    setItems((rows) => {
      const next = rows.filter((row) => row.key !== key);
      // Never nothing: an empty list would leave the board with no field to type
      // the first item into and no control that puts one back.
      return next.length === 0 ? draftFrom([""]) : next;
    });
  };

  const move = (index: number, by: -1 | 1): void => {
    setItems((rows) => {
      const to = index + by;
      const moved = rows[index];
      const displaced = rows[to];
      if (moved === undefined || displaced === undefined) {
        return rows;
      }
      const next = [...rows];
      next[index] = displaced;
      next[to] = moved;
      return next;
    });
  };

  return (
    <Panel
      title={t("meetings.agenda.title")}
      description={t("meetings.agenda.description")}
      notice={
        <>
          {summoned ? (
            <Notice tone="info">{t("meetings.agenda.summonedNotice")}</Notice>
          ) : held ? (
            <Notice tone="info">{t("meetings.agenda.heldNotice")}</Notice>
          ) : null}
          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(meetingFailureKey(save.state.failure))}
            </Notice>
          ) : save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("meetings.agenda.saved")}
            </Notice>
          ) : null}
          {tooMany ? (
            <Notice tone="warn" live>
              {t("meetings.agenda.tooMany", { max: MEETING_AGENDA_MAX_ITEMS })}
            </Notice>
          ) : null}
        </>
      }
      actions={
        editable ? (
          <>
            <button
              type="submit"
              form="meeting-agenda"
              className={PRIMARY_BUTTON}
              disabled={save.state.kind === "saving" || !sendable}
            >
              {save.state.kind === "saving"
                ? t("meetings.agenda.saving")
                : t("meetings.agenda.save")}
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={items.length >= MEETING_AGENDA_MAX_ITEMS}
              onClick={() => {
                setItems((rows) => [...rows, ...draftFrom([""])]);
              }}
            >
              {t("meetings.agenda.addItem")}
            </button>
            <p className={HINT}>{t("meetings.agenda.replaceHint")}</p>
          </>
        ) : undefined
      }
    >
      {editable ? (
        <form
          id="meeting-agenda"
          className="flex flex-col gap-3"
          onSubmit={onSubmit}
        >
          {items.map((item, index) => (
            <div key={item.key} className="flex flex-wrap items-end gap-2">
              <label className={`${LABEL} min-w-64 flex-1`}>
                {t("meetings.agenda.itemLabel", { position: index + 1 })}
                <input
                  className={FIELD}
                  type="text"
                  maxLength={MEETING_AGENDA_TITLE_MAX}
                  value={item.title}
                  onChange={(event) => {
                    change(item.key, event.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className={QUIET_BUTTON}
                disabled={index === 0}
                aria-label={t("meetings.agenda.moveUpNamed", {
                  position: index + 1,
                })}
                onClick={() => {
                  move(index, -1);
                }}
              >
                {t("meetings.agenda.moveUp")}
              </button>
              <button
                type="button"
                className={QUIET_BUTTON}
                disabled={index === items.length - 1}
                aria-label={t("meetings.agenda.moveDownNamed", {
                  position: index + 1,
                })}
                onClick={() => {
                  move(index, 1);
                }}
              >
                {t("meetings.agenda.moveDown")}
              </button>
              <button
                type="button"
                className={QUIET_BUTTON}
                aria-label={t("meetings.agenda.removeNamed", {
                  position: index + 1,
                })}
                onClick={() => {
                  remove(item.key);
                }}
              >
                {t("meetings.agenda.remove")}
              </button>
            </div>
          ))}
        </form>
      ) : meeting.agenda.length === 0 ? (
        <p className="text-body text-ink-muted">{t("meetings.agenda.empty")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {meeting.agenda.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-data text-data text-ink-muted">
                {item.position}
              </span>
              <span className="text-body">{item.title}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
