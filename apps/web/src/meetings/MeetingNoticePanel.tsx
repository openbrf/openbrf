import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  issueMeetingNotice,
  MEETING_DIGITAL_PARTICIPATION_MAX,
  MEETING_PLACE_MAX,
  type Meeting,
} from "../api/meetings";
import { formatTimeOfDay } from "../bookings/booking-calendar";
import { formatEventDay } from "../events/event-calendar";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { meetingFailureKey } from "./meeting-failures";
import { MeetingPersonName } from "./MeetingPersonName";
import type { MeetingPeople } from "./use-meeting-people";

export interface MeetingNoticePanelProps {
  meeting: Meeting;
  people: MeetingPeople;
  onChanged: () => void;
}

/**
 * The notice (kallelsen) that summons the meeting.
 *
 * ## What it states, and why those three things
 *
 * EFL 6 kap. 22 § has the notice state the time and the place of the meeting,
 * the matters to be dealt with, and - where the meeting is held digitally - how
 * the members take part and how they vote. The matters are the agenda and are
 * not restated here; they are what the panel above holds, and issuing the notice
 * is what fixes them.
 *
 * The time is a time of day and never a date. The day is the meeting's own, it
 * is the day the voting register is read against, and a notice carrying a second
 * date could summon the members to a different day from the one that decides
 * their votes. The server turns the hour into an instant on the association's
 * clock and refuses an hour that day does not have - which is the one the clock
 * skips when summer time begins.
 *
 * The instruction for taking part digitally is empty for a meeting held in a
 * room and required for one held on a call. A digital meeting whose members were
 * told nothing about how to attend or how to vote has not been summoned as that
 * paragraph requires, so the field is offered behind the switch that says which
 * kind of meeting it is, rather than as an optional box somebody may leave
 * blank without noticing.
 *
 * ## Issued once, and never edited
 *
 * There is no route that changes or withdraws a notice, and so there is no
 * control here for one. EFL 6 kap. 25 § gives the remedy for a notice that went
 * wrong and it is an extra general meeting, not a second notice - so once the
 * summons is out this panel is a record of what was sent and to how many.
 *
 * ## The ledger says who was not reached
 *
 * A notice is a summons rather than an announcement: EFL 6 kap. 21 § has the
 * members called, so a member this platform could not reach is one the board
 * still has to call another way. The ledger therefore names them, and this panel
 * renders those names rather than a count - a board told that four copies failed
 * cannot ring anybody.
 *
 * That an instance has no mail server is called out separately from a delivery
 * that failed. The notice is issued either way and the members are still
 * summoned; what differs is whether the board has four people to telephone or
 * an instance to configure.
 *
 * Electronic notice is lawful under BRL 1 kap. 10 § with EFL 1 kap. 16 §, whose
 * conditions are the association's to satisfy. The ledger records that the
 * notice was sent and never that it was permitted, and neither does this panel.
 */
export function MeetingNoticePanel({
  meeting,
  people,
  onChanged,
}: MeetingNoticePanelProps): ReactElement {
  const { t, i18n } = useTranslation();

  const [startsAt, setStartsAt] = useState("");
  const [place, setPlace] = useState("");
  const [digital, setDigital] = useState(false);
  const [participation, setParticipation] = useState("");

  const issue = useSaveAction(issueMeetingNotice);

  const notice = meeting.notice;
  const held = meeting.concludedAt !== null;
  const hasAgenda = meeting.agenda.length > 0;

  const participationStated = participation.trim();
  const sendable =
    startsAt.trim() !== "" &&
    place.trim() !== "" &&
    (!digital || participationStated !== "");

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!sendable) {
      return;
    }
    void issue
      .submit({
        id: meeting.id,
        values: {
          startsAt,
          place: place.trim(),
          /*
           * Null and never an empty string for a meeting held in a room. The API
           * reads null as "there is no digital participation" and refuses blank
           * text, which is what keeps a digital meeting from being summoned with
           * an instruction nobody can follow.
           */
          digitalParticipation: digital ? participationStated : null,
        },
      })
      .then(() => {
        onChanged();
      });
  };

  return (
    <Panel
      title={t("meetings.notice.title")}
      description={t("meetings.notice.description")}
      notice={
        <>
          <Notice tone="info">{t("meetings.notice.statutoryNotice")}</Notice>
          {issue.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(meetingFailureKey(issue.state.failure))}
            </Notice>
          ) : issue.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("meetings.notice.issued")}
            </Notice>
          ) : null}
        </>
      }
      actions={
        notice === null && !held ? (
          <>
            <button
              type="submit"
              form="meeting-notice"
              className={PRIMARY_BUTTON}
              disabled={
                issue.state.kind === "saving" || !sendable || !hasAgenda
              }
            >
              {issue.state.kind === "saving"
                ? t("meetings.notice.issuing")
                : t("meetings.notice.issue")}
            </button>
            <p className={HINT}>{t("meetings.notice.onceHint")}</p>
          </>
        ) : undefined
      }
    >
      {notice !== null ? (
        <IssuedNotice
          notice={notice}
          heldOn={meeting.heldOn}
          people={people}
          locale={i18n.language}
        />
      ) : held ? (
        <p className="text-body text-ink-muted">
          {t("meetings.notice.heldWithoutNotice")}
        </p>
      ) : (
        <>
          {hasAgenda ? null : (
            <Notice tone="warn">{t("meetings.notice.needsAgenda")}</Notice>
          )}

          <form
            id="meeting-notice"
            className="flex flex-col gap-4"
            onSubmit={onSubmit}
          >
            <div className="flex flex-wrap gap-4">
              <label className={LABEL}>
                {t("meetings.notice.startsAt")}
                <input
                  className={`${FIELD_DATA} w-36`}
                  type="time"
                  value={startsAt}
                  onChange={(event) => {
                    setStartsAt(event.target.value);
                  }}
                />
                <span className={HINT}>
                  {t("meetings.notice.dayHint", {
                    date: formatEventDay(meeting.heldOn, i18n.language),
                  })}
                </span>
              </label>

              <label className={`${LABEL} min-w-64 flex-1`}>
                {t("meetings.notice.place")}
                <input
                  className={FIELD}
                  type="text"
                  maxLength={MEETING_PLACE_MAX}
                  value={place}
                  onChange={(event) => {
                    setPlace(event.target.value);
                  }}
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-small">
              <input
                type="checkbox"
                checked={digital}
                onChange={(event) => {
                  setDigital(event.target.checked);
                }}
              />
              {t("meetings.notice.digital")}
            </label>

            {digital ? (
              <label className={LABEL}>
                {t("meetings.notice.participation")}
                <textarea
                  className={`${FIELD} min-h-24 py-2`}
                  maxLength={MEETING_DIGITAL_PARTICIPATION_MAX}
                  value={participation}
                  onChange={(event) => {
                    setParticipation(event.target.value);
                  }}
                />
                <span className={HINT}>
                  {t("meetings.notice.participationHint")}
                </span>
              </label>
            ) : null}
          </form>
        </>
      )}
    </Panel>
  );
}

/**
 * The notice as it went out, and how the sending went.
 *
 * A record rather than a form. The counts are the ledger's own and are read from
 * the answer on every re-read, because the sending is a queued job: a board that
 * issued the notice a moment ago sees copies still pending and the same panel
 * says "sent" once they have gone.
 */
function IssuedNotice({
  notice,
  heldOn,
  people,
  locale,
}: {
  notice: NonNullable<Meeting["notice"]>;
  heldOn: string;
  people: MeetingPeople;
  locale: string;
}): ReactElement {
  const { t } = useTranslation();
  const { deliveries } = notice;

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <dt className="text-label text-ink-muted uppercase">
            {t("meetings.notice.when")}
          </dt>
          <dd className="font-data text-data">
            <time dateTime={heldOn}>{formatEventDay(heldOn, locale)}</time>{" "}
            <time dateTime={notice.startsAt}>
              {formatTimeOfDay(notice.startsAt, locale)}
            </time>
          </dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="text-label text-ink-muted uppercase">
            {t("meetings.notice.place")}
          </dt>
          <dd className="text-body">{notice.place}</dd>
        </div>
        {notice.digitalParticipation === null ? null : (
          <div className="flex flex-col gap-1">
            <dt className="text-label text-ink-muted uppercase">
              {t("meetings.notice.participation")}
            </dt>
            <dd className="text-body whitespace-pre-line">
              {notice.digitalParticipation}
            </dd>
          </div>
        )}
      </dl>

      <p className={HINT}>
        {t("meetings.notice.deliveries", {
          sent: deliveries.sent,
          pending: deliveries.pending,
          failed: deliveries.failed,
        })}
      </p>

      {deliveries.mailNotConfigured ? (
        <Notice tone="warn">{t("meetings.notice.mailNotConfigured")}</Notice>
      ) : null}

      {deliveries.unreachedPersonIds.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Notice tone="warn">{t("meetings.notice.unreachedNotice")}</Notice>
          <ul className="flex flex-col gap-1">
            {deliveries.unreachedPersonIds.map((personId) => (
              <li key={personId} className="text-small">
                <MeetingPersonName
                  person={people.find(personId)}
                  personId={personId}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
