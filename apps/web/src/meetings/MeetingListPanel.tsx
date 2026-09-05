import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  arrangeMeeting,
  concludeMeeting,
  MEETING_KINDS,
  type MeetingKind,
  type MeetingSummary,
} from "../api/meetings";
import { formatEventDay } from "../events/event-calendar";
import {
  FIELD,
  FIELD_DATA,
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

export interface MeetingListPanelProps {
  meetings: readonly MeetingSummary[];
  /** The meeting whose screens are open below, or null while none is. */
  selectedId: string | null;
  onSelect: (meetingId: string) => void;
  /** Asks the screen to read the meetings again. */
  onChanged: () => void;
}

/**
 * The meetings the association has arranged, and arranging another.
 *
 * ## What arranging a meeting states, and what it does not
 *
 * Two things: whether it is the ordinary meeting or an extra one, and the day it
 * is held. The day is the whole of why it is stated first - EFL 6 kap. 3 § with
 * BRL 9 kap. 14 § 1 gives the vote to whoever is a member on that day, so the
 * voting register below is read against it and nothing else. The time and the
 * place are not asked for here: they belong to the notice, which is a different
 * act with a different paragraph behind it (EFL 6 kap. 22 §), and a meeting is
 * arranged before anybody is summoned to it.
 *
 * A day in the past is accepted, and deliberately. A board records a meeting it
 * has already held in order to minute what was decided at it, and a form that
 * refused yesterday would refuse the ordinary case of a cooperative starting to
 * use this platform.
 *
 * ## Recording a meeting as held
 *
 * A row action rather than a form, because it is one act with one answer. It is
 * the hinge of the whole screen: before it the agenda is a plan, the register is
 * a projection of the member register and nothing may be minuted; after it the
 * agenda is the record of what the meeting dealt with, the register is a fact
 * about a day that has passed, and the decisions can be written.
 *
 * Which is why it is offered once and then gone rather than disabled. The server
 * refuses a second one - two board members pressing it produce one close, and
 * the loser is answered exactly as a read would have answered them - and a
 * control that only ever refused would be a worse way of saying so.
 */
export function MeetingListPanel({
  meetings,
  selectedId,
  onSelect,
  onChanged,
}: MeetingListPanelProps): ReactElement {
  const { t, i18n } = useTranslation();

  const [kind, setKind] = useState<MeetingKind>("ORDINARY");
  const [heldOn, setHeldOn] = useState("");
  /**
   * Which meeting the act in flight is for.
   *
   * One action serves every row, so without this one press would put "recording
   * as held" on every meeting in the list.
   */
  const [concluding, setConcluding] = useState<string | null>(null);

  const arrange = useSaveAction(arrangeMeeting, (meeting) => {
    /*
     * Opened as soon as it exists. Arranging a meeting is never the last thing a
     * board does - the agenda comes next, and the panels for it are the ones
     * that appear when a meeting is selected - so leaving the new meeting closed
     * would put a second press between the board and the only screen that can
     * follow.
     */
    onSelect(meeting.id);
  });
  const conclude = useSaveAction(concludeMeeting);

  const busy =
    arrange.state.kind === "saving" || conclude.state.kind === "saving";

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    conclude.reset();
    /*
     * The outcome is deliberately not read here beyond the selection above. A
     * meeting that was created and one that was refused both change what the
     * list says, so the read happens either way - which is what keeps the
     * reading effect on the screen the only thing that reads.
     */
    void arrange.submit({ kind, heldOn }).then(() => {
      onChanged();
    });
  };

  const onConclude = (meetingId: string): void => {
    arrange.reset();
    setConcluding(meetingId);
    void conclude
      .submit(meetingId)
      .then(() => {
        onChanged();
      })
      .finally(() => {
        setConcluding(null);
      });
  };

  const failure =
    arrange.state.kind === "failed"
      ? arrange.state.failure
      : conclude.state.kind === "failed"
        ? conclude.state.failure
        : null;

  return (
    <Panel
      title={t("meetings.list.title")}
      description={t("meetings.list.description")}
      notice={
        failure !== null ? (
          <Notice tone="danger" live>
            {t(meetingFailureKey(failure))}
          </Notice>
        ) : arrange.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("meetings.list.arranged")}
          </Notice>
        ) : conclude.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("meetings.list.concluded")}
          </Notice>
        ) : null
      }
      actions={
        <>
          <button
            type="submit"
            form="arrange-meeting"
            className={PRIMARY_BUTTON}
            disabled={busy || heldOn.trim() === ""}
          >
            {arrange.state.kind === "saving"
              ? t("meetings.list.arranging")
              : t("meetings.list.arrange")}
          </button>
          <p className={HINT}>{t("meetings.list.dayHint")}</p>
        </>
      }
    >
      <form
        id="arrange-meeting"
        className="flex flex-wrap gap-4"
        onSubmit={onSubmit}
      >
        <label className={LABEL}>
          {t("meetings.list.kind")}
          <select
            className={`${FIELD} w-64`}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as MeetingKind);
            }}
          >
            {MEETING_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`meetings.kind.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className={LABEL}>
          {t("meetings.list.heldOn")}
          <input
            className={`${FIELD_DATA} w-48`}
            type="date"
            value={heldOn}
            onChange={(event) => {
              setHeldOn(event.target.value);
            }}
          />
        </label>
      </form>

      {meetings.length === 0 ? (
        <p className="text-body text-ink-muted">{t("meetings.list.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {meetings.map((meeting) => (
            <li key={meeting.id}>
              <article
                className={[
                  "flex flex-col gap-2 rounded-control border bg-page px-3 py-3",
                  meeting.id === selectedId
                    ? "border-line-strong"
                    : "border-line",
                ].join(" ")}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-body font-semibold">
                    {t(`meetings.kind.${meeting.kind}`)}
                  </h3>
                  <span className="font-data text-data">
                    <time dateTime={meeting.heldOn}>
                      {formatEventDay(meeting.heldOn, i18n.language)}
                    </time>
                  </span>
                  <span className="text-chip text-ink-muted uppercase">
                    {meeting.concludedAt === null
                      ? t("meetings.list.beingArranged")
                      : t("meetings.list.held")}
                  </span>
                </div>

                <p className={HINT}>
                  {t("meetings.list.agendaItemCount", {
                    count: meeting.agendaItemCount,
                  })}
                </p>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    disabled={busy}
                    aria-label={t("meetings.list.openNamed", {
                      kind: t(`meetings.kind.${meeting.kind}`),
                      date: meeting.heldOn,
                    })}
                    onClick={() => {
                      onSelect(meeting.id);
                    }}
                  >
                    {meeting.id === selectedId
                      ? t("meetings.list.open")
                      : t("meetings.list.openIt")}
                  </button>

                  {meeting.concludedAt === null ? (
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      disabled={busy}
                      aria-label={t("meetings.list.concludeNamed", {
                        kind: t(`meetings.kind.${meeting.kind}`),
                        date: meeting.heldOn,
                      })}
                      onClick={() => {
                        onConclude(meeting.id);
                      }}
                    >
                      {busy && concluding === meeting.id
                        ? t("meetings.list.concluding")
                        : t("meetings.list.conclude")}
                    </button>
                  ) : null}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
