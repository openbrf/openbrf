import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type AgendaItem,
  MEETING_DECISION_OUTCOMES,
  MEETING_VOTE_COUNT_MAX,
  type Meeting,
  type MeetingDecisionOutcome,
  recordDecision,
} from "../api/meetings";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { meetingFailureKey } from "./meeting-failures";
import { MeetingPersonName } from "./MeetingPersonName";
import type { MeetingPeople } from "./use-meeting-people";

export interface MeetingDecisionsPanelProps {
  meeting: Meeting;
  people: MeetingPeople;
  onChanged: () => void;
}

/**
 * What the meeting decided on each item, beside the counts it was decided on.
 *
 * ## The platform's copy, not the protokoll
 *
 * EFL 6 kap. 39 § has the chair see that a protokoll is kept, with the voting
 * register taken into it or appended to it, and 6 kap. 40 § has it held
 * available to the members within three weeks. That document is filed in the
 * association's archive. What is recorded here is the platform's copy of what it
 * states about each item, which is why an item can be corrected by writing the
 * row again and why nothing here is signed: a document that has to be signed
 * under that Act may be signed with an advanced electronic signature (EFL 1 kap.
 * 15 §), which is a trust service this platform does not provide.
 *
 * ## Nothing here casts a vote
 *
 * The counts are transcribed from what the chair declared, not tallied. That is
 * the whole reason the form takes three numbers rather than offering a ballot:
 * an ordinary majority is measured against the votes cast (EFL), somebody
 * present who does not vote has cast none, and what a decision needed is the
 * chair's to state. The voting register above says how many votes were in the
 * room and is deliberately not a majority basis.
 *
 * The counts are therefore not checked against that figure either. A count above
 * the votes present is possible on a register the meeting itself resolved to
 * change, which is exactly what 6 kap. 27 § allows when it approves the
 * register - so a screen that refused it would be enforcing a rule the statute
 * does not have against the minutes of a meeting that has already happened.
 *
 * ## A closed ballot is recorded and never required
 *
 * The word `sluten` does not occur in EFL at all: a closed ballot (sluten
 * omrostning) at a general meeting is the meeting's own procedure rather than a
 * right anybody may demand. So this is a fact the chair minuted, recorded as
 * such, and no condition follows from it here.
 *
 * ## Only once the meeting has been held
 *
 * A decision is minuted after the meeting, and the server refuses one before -
 * `meeting-not-held`. So this panel is a statement until the board has recorded
 * the meeting as held, and a form afterwards. Rendering it as a disabled form
 * would leave a board wondering which field was wrong.
 */
export function MeetingDecisionsPanel({
  meeting,
  people,
  onChanged,
}: MeetingDecisionsPanelProps): ReactElement {
  const { t } = useTranslation();
  const held = meeting.concludedAt !== null;

  return (
    <Panel
      title={t("meetings.decisions.title")}
      description={t("meetings.decisions.description")}
      notice={
        held ? (
          <Notice tone="info">{t("meetings.decisions.copyNotice")}</Notice>
        ) : (
          <Notice tone="info">{t("meetings.decisions.notHeldNotice")}</Notice>
        )
      }
    >
      {meeting.agenda.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("meetings.decisions.empty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {meeting.agenda.map((item) => (
            <li key={item.id}>
              <ItemDecision
                meetingId={meeting.id}
                item={item}
                held={held}
                people={people}
                onChanged={onChanged}
              />
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/**
 * One agenda item, and what the meeting resolved on it.
 *
 * The form is seeded from the decision already recorded, because correcting a
 * mis-keyed count is writing the same row again and a board doing that is
 * editing four figures rather than entering them. The screen remounts this on
 * the decision the server answered with - see the key below - so a save that
 * landed replaces the fields rather than a re-read overwriting a correction
 * half-typed.
 */
function ItemDecision({
  meetingId,
  item,
  held,
  people,
  onChanged,
}: {
  meetingId: string;
  item: AgendaItem;
  held: boolean;
  people: MeetingPeople;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const recorded = item.decision;

  const [outcome, setOutcome] = useState<MeetingDecisionOutcome>(
    recorded?.outcome ?? "CARRIED",
  );
  const [votesFor, setVotesFor] = useState(
    recorded === null ? "" : String(recorded.votesFor),
  );
  const [votesAgainst, setVotesAgainst] = useState(
    recorded === null ? "" : String(recorded.votesAgainst),
  );
  const [votesAbstaining, setVotesAbstaining] = useState(
    recorded === null ? "" : String(recorded.votesAbstaining),
  );
  const [closedBallot, setClosedBallot] = useState(
    recorded?.closedBallot ?? false,
  );

  const save = useSaveAction(recordDecision);

  const counts = [votesFor, votesAgainst, votesAbstaining].map(countIn);
  const sendable = counts.every((count) => count !== null);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const [forCount, againstCount, abstainingCount] = counts;
    if (
      forCount === null ||
      forCount === undefined ||
      againstCount === null ||
      againstCount === undefined ||
      abstainingCount === null ||
      abstainingCount === undefined
    ) {
      return;
    }
    void save
      .submit({
        id: meetingId,
        agendaItemId: item.id,
        values: {
          outcome,
          votesFor: forCount,
          votesAgainst: againstCount,
          votesAbstaining: abstainingCount,
          closedBallot,
        },
      })
      .then(() => {
        onChanged();
      });
  };

  const formId = `meeting-decision-${item.id}`;

  return (
    <article className="flex flex-col gap-3 rounded-control border border-line bg-page px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-data text-data text-ink-muted">
          {item.position}
        </span>
        <h3 className="text-body font-semibold">{item.title}</h3>
        {recorded === null ? (
          <span className="text-chip text-ink-muted uppercase">
            {t("meetings.decisions.notRecorded")}
          </span>
        ) : (
          <span className="text-chip uppercase">
            {t(`meetings.outcome.${recorded.outcome}`)}
          </span>
        )}
      </div>

      {recorded === null ? null : (
        <p className={HINT}>
          {t("meetings.decisions.counts", {
            for: recorded.votesFor,
            against: recorded.votesAgainst,
            abstaining: recorded.votesAbstaining,
          })}
          {recorded.closedBallot
            ? ` · ${t("meetings.decisions.wasClosedBallot")}`
            : ""}
          {" · "}
          {t("meetings.decisions.recordedBy")}{" "}
          <MeetingPersonName
            person={people.find(recorded.recordedByPersonId)}
            personId={recorded.recordedByPersonId}
          />
        </p>
      )}

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(meetingFailureKey(save.state.failure))}
        </Notice>
      ) : save.state.kind === "saved" ? (
        <Notice tone="ok" live>
          {t("meetings.decisions.saved")}
        </Notice>
      ) : null}

      {held ? (
        <>
          <form
            id={formId}
            className="flex flex-wrap items-end gap-3"
            onSubmit={onSubmit}
          >
            <label className={LABEL}>
              {t("meetings.decisions.outcome")}
              <select
                className={`${FIELD} w-48`}
                value={outcome}
                onChange={(event) => {
                  setOutcome(event.target.value as MeetingDecisionOutcome);
                }}
              >
                {MEETING_DECISION_OUTCOMES.map((value) => (
                  <option key={value} value={value}>
                    {t(`meetings.outcome.${value}`)}
                  </option>
                ))}
              </select>
            </label>

            <CountField
              label={t("meetings.decisions.votesFor")}
              value={votesFor}
              onChange={setVotesFor}
            />
            <CountField
              label={t("meetings.decisions.votesAgainst")}
              value={votesAgainst}
              onChange={setVotesAgainst}
            />
            <CountField
              label={t("meetings.decisions.votesAbstaining")}
              value={votesAbstaining}
              onChange={setVotesAbstaining}
            />

            <label className="flex min-h-11 items-center gap-2 text-small">
              <input
                type="checkbox"
                checked={closedBallot}
                onChange={(event) => {
                  setClosedBallot(event.target.checked);
                }}
              />
              {t("meetings.decisions.closedBallot")}
            </label>
          </form>

          <div>
            <button
              type="submit"
              form={formId}
              className={PRIMARY_BUTTON}
              disabled={save.state.kind === "saving" || !sendable}
              aria-label={t("meetings.decisions.recordNamed", {
                title: item.title,
              })}
            >
              {save.state.kind === "saving"
                ? t("meetings.decisions.recording")
                : t("meetings.decisions.record")}
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}

/** One vote count. */
function CountField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className={LABEL}>
      {label}
      <input
        className={`${FIELD_DATA} w-24`}
        type="number"
        min={0}
        max={MEETING_VOTE_COUNT_MAX}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </label>
  );
}

/**
 * The whole count a field holds, or null when it holds no usable one.
 *
 * `Number` rather than `Number.parseInt`, for the reason the motion deadline
 * gives: a number input accepts exponent notation and `Number.parseInt("1e2")`
 * is 1, so a board that typed 100 votes would have minuted one. Blank is
 * answered before the conversion, since `Number("")` is 0 and a blank field is
 * not a count of nothing - it is a figure the board has not entered yet.
 *
 * The upper bound is checked here as well as at the API, because it is what
 * keeps a mis-keyed figure out of the association's copy of the protokoll's own
 * counts, and a refusal is a worse way to say so than a control that will not
 * send.
 */
function countIn(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return parsed >= 0 && parsed <= MEETING_VOTE_COUNT_MAX ? parsed : null;
}
