import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  ATTENDANCE_CAPACITIES,
  ATTENDANCE_MODES,
  type AttendanceCapacity,
  type AttendanceMode,
  type Meeting,
  recordAttendance,
  withdrawAttendance,
} from "../api/meetings";
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
import { meetingFailureKey } from "./meeting-failures";
import { MeetingPersonName } from "./MeetingPersonName";
import { PersonSelect } from "./PersonSelect";
import type { MeetingPeople } from "./use-meeting-people";

export interface MeetingCheckInPanelProps {
  meeting: Meeting;
  people: MeetingPeople;
  onChanged: () => void;
}

/**
 * Checking people in: the list EFL 6 kap. 27 § has drawn up at the meeting.
 *
 * ## Three capacities, and only two of them a vote
 *
 * A member attends and votes in their own right (EFL 6 kap. 2-3 §§). A proxy
 * holder exercises somebody else's vote under an authority registered above, and
 * is refused here if they hold none - a person on the list with nothing to
 * exercise would have to be reported as such by the voting register instead of
 * the board being told at the door, which is the worse of the two. An assistant
 * (bitrade) is on the list because that paragraph covers them, has the right to
 * speak under EFL 6 kap. 7 §, and carries no vote at all.
 *
 * So the assistant is the one capacity that names somebody else: 6 kap. 7 § has
 * a member or a proxy holder bring them, which means the person they came with
 * has to be on the list already. The field appears for that capacity and for no
 * other, and naming somebody on a member's or a proxy holder's line is refused
 * by the server rather than dropped - a field a request set and the server
 * silently ignored is a defect nothing surfaces.
 *
 * ## Nothing here is optimistic
 *
 * Every act discards its answer and asks the screen to read the meeting again.
 * A check-in changes the voting register - who is present, how many votes are in
 * the room, which proxy holders now have nothing to exercise because the member
 * turned up - and none of that is derivable from the one attendance line the
 * write answers with. A panel that folded the write's answer into its own state
 * would hold a list of who is present beside a count of votes that no longer
 * followed from it.
 *
 * The re-read happens whether the act succeeded or was refused. The refusal that
 * most needs it is a proxy holder refused for holding no authority: the board's
 * next act is to look at the authorities, and they have to be the ones the
 * server has rather than the ones the screen last saw.
 *
 * ## Struck off, never deleted
 *
 * A withdrawal writes a date on the line and the line stays, so "was recorded as
 * present and struck off again" is answerable afterwards. Somebody struck off
 * and checked in again is the same line with the date cleared, which is why the
 * form takes a person rather than a row.
 */
export function MeetingCheckInPanel({
  meeting,
  people,
  onChanged,
}: MeetingCheckInPanelProps): ReactElement {
  const { t } = useTranslation();

  const [personId, setPersonId] = useState("");
  const [capacity, setCapacity] = useState<AttendanceCapacity>("MEMBER");
  const [mode, setMode] = useState<AttendanceMode>("IN_PERSON");
  const [onBehalfOfPersonId, setOnBehalfOfPersonId] = useState("");
  /**
   * Which line the withdrawal in flight is for.
   *
   * One action serves every row, so without this one press would put "striking
   * off" on everybody at the meeting.
   */
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  const check = useSaveAction(recordAttendance);
  const strike = useSaveAction(withdrawAttendance);

  const held = meeting.concludedAt !== null;
  const busy = check.state.kind === "saving" || strike.state.kind === "saving";

  const needsPrincipal = capacity === "ASSISTANT";
  const sendable =
    personId !== "" && (!needsPrincipal || onBehalfOfPersonId !== "");

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!sendable) {
      return;
    }
    strike.reset();
    void check
      .submit({
        id: meeting.id,
        values: {
          personId,
          capacity,
          mode,
          /*
           * Null on every capacity but the assistant's, and null rather than
           * absent. The server refuses a principal named on a member's or a
           * proxy holder's line, which is what stops a stale field from the
           * previous check-in travelling with the next one.
           */
          onBehalfOfPersonId: needsPrincipal ? onBehalfOfPersonId : null,
        },
      })
      .then(() => {
        onChanged();
      });
  };

  const onWithdraw = (attendanceId: string): void => {
    check.reset();
    setWithdrawing(attendanceId);
    void strike
      .submit({ id: meeting.id, attendanceId })
      .then(() => {
        onChanged();
      })
      .finally(() => {
        setWithdrawing(null);
      });
  };

  const failure =
    check.state.kind === "failed"
      ? check.state.failure
      : strike.state.kind === "failed"
        ? strike.state.failure
        : null;

  const present = meeting.attendances.filter(
    (line) => line.withdrawnAt === null,
  );
  const struck = meeting.attendances.filter(
    (line) => line.withdrawnAt !== null,
  );

  return (
    <Panel
      title={t("meetings.checkIn.title")}
      description={t("meetings.checkIn.description")}
      notice={
        <>
          {meeting.bylaws.assistantEligibilityWidened ? (
            <Notice tone="info">
              {t("meetings.checkIn.assistantWidened")}
            </Notice>
          ) : (
            <Notice tone="info">
              {t("meetings.checkIn.assistantStatutory")}
            </Notice>
          )}
          {failure !== null ? (
            <Notice tone="danger" live>
              {t(meetingFailureKey(failure))}
            </Notice>
          ) : check.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("meetings.checkIn.recorded")}
            </Notice>
          ) : strike.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("meetings.checkIn.struck")}
            </Notice>
          ) : null}
        </>
      }
      actions={
        held ? undefined : (
          <>
            <button
              type="submit"
              form="meeting-check-in"
              className={PRIMARY_BUTTON}
              disabled={busy || !sendable}
            >
              {check.state.kind === "saving"
                ? t("meetings.checkIn.recording")
                : t("meetings.checkIn.record")}
            </button>
            <p className={HINT}>{t("meetings.checkIn.capacityHint")}</p>
          </>
        )
      }
    >
      {held ? (
        <Notice tone="info">{t("meetings.checkIn.heldNotice")}</Notice>
      ) : (
        <form
          id="meeting-check-in"
          className="flex flex-wrap gap-4"
          onSubmit={onSubmit}
        >
          <PersonSelect
            label={t("meetings.checkIn.person")}
            people={people}
            value={personId}
            onChange={setPersonId}
          />

          <label className={LABEL}>
            {t("meetings.checkIn.capacity")}
            <select
              className={`${FIELD} w-56`}
              value={capacity}
              onChange={(event) => {
                setCapacity(event.target.value as AttendanceCapacity);
              }}
            >
              {ATTENDANCE_CAPACITIES.map((value) => (
                <option key={value} value={value}>
                  {t(`meetings.capacity.${value}`)}
                </option>
              ))}
            </select>
          </label>

          <label className={LABEL}>
            {t("meetings.checkIn.mode")}
            <select
              className={`${FIELD} w-56`}
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as AttendanceMode);
              }}
            >
              {ATTENDANCE_MODES.map((value) => (
                <option key={value} value={value}>
                  {t(`meetings.mode.${value}`)}
                </option>
              ))}
            </select>
          </label>

          {/* Offered for the assistant and for nobody else, because only an
              assistant came with anybody: EFL 6 kap. 7 § has a member or a proxy
              holder bring them, and the person they came with must already be on
              the list. */}
          {needsPrincipal ? (
            <PersonSelect
              label={t("meetings.checkIn.onBehalfOf")}
              people={people}
              value={onBehalfOfPersonId}
              onChange={setOnBehalfOfPersonId}
            />
          ) : null}
        </form>
      )}

      {present.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("meetings.checkIn.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {present.map((line) => (
            <li
              key={line.id}
              className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-page px-3 py-2"
            >
              <MeetingPersonName
                person={people.find(line.personId)}
                personId={line.personId}
              />
              <span className="text-chip text-ink-muted uppercase">
                {t(`meetings.capacity.${line.capacity}`)}
              </span>
              <span className="text-chip text-ink-muted uppercase">
                {t(`meetings.mode.${line.mode}`)}
              </span>
              {line.onBehalfOfPersonId === null ? null : (
                <span className={HINT}>
                  {t("meetings.checkIn.cameWith")}{" "}
                  <MeetingPersonName
                    person={people.find(line.onBehalfOfPersonId)}
                    personId={line.onBehalfOfPersonId}
                  />
                </span>
              )}
              {held ? null : (
                <button
                  type="button"
                  className={`${QUIET_BUTTON} ms-auto`}
                  disabled={busy}
                  aria-label={t("meetings.checkIn.strikeNamed", {
                    person: people.find(line.personId)?.name ?? line.personId,
                  })}
                  onClick={() => {
                    onWithdraw(line.id);
                  }}
                >
                  {busy && withdrawing === line.id
                    ? t("meetings.checkIn.striking")
                    : t("meetings.checkIn.strike")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Kept on the screen rather than removed. The list is the record of who
          was recorded present at this meeting, and somebody struck off is part
          of it - a board that struck the wrong row has to be able to see that it
          did. */}
      {struck.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-label text-ink-muted uppercase">
            {t("meetings.checkIn.struckHeading")}
          </h3>
          <ul className="flex flex-col gap-2">
            {struck.map((line) => (
              <li
                key={line.id}
                className="flex flex-wrap items-center gap-3 rounded-control border border-dashed border-line px-3 py-2"
              >
                <MeetingPersonName
                  person={people.find(line.personId)}
                  personId={line.personId}
                />
                <span className="text-chip text-ink-muted uppercase">
                  {t(`meetings.capacity.${line.capacity}`)}
                </span>
                <span className="text-small text-ink-muted">
                  {t("meetings.checkIn.wasStruck")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
