import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { MeetingSummary } from "../api/meetings";
import {
  acknowledgeMotion,
  type MotionDeadline,
  type MotionSubmitter,
  type QueuedMotion,
  setMotionMeeting,
} from "../api/motions";
import { FIELD, HINT, LABEL, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { motionFailureKey } from "./motion-failures";
import { MotionStatusChip } from "./MotionStatusChip";

export interface MotionQueuePanelProps {
  motions: readonly QueuedMotion[];
  deadline: MotionDeadline | null;
  /**
   * The meetings an item may be put to, or null where this viewer may not read
   * them.
   *
   * Null and not an empty list, because the two mean different things and the
   * panel says different things about them. `meetings:manage` is what reads the
   * meetings, and although the board holds it alongside `motions:handle` today,
   * a seat granted only the queue would otherwise be shown a control offering
   * nothing and told the association had arranged no meetings.
   */
  meetings: readonly MeetingSummary[] | null;
  onChanged: () => void;
}

/**
 * The queue the board works: what the members have put to the meeting.
 *
 * Open motions first and oldest first within a status, which is the order the
 * server returns them in - the queue is worked from the top and the item that has
 * been waiting longest is the one to look at.
 *
 * Two acts, and neither of them is a decision about the proposal. Acknowledging
 * records that the board has received the motion. Putting it to a meeting
 * records which general meeting deals with it. There is deliberately no reject
 * control: refusing to take up a member's item is not the board's to decide
 * under EFL 6 kap. 15 §, and whether the meeting adopts the proposal is minuted
 * at the meeting rather than here.
 *
 * ## Which meeting, and until when
 *
 * EFL 6 kap. 15 § gives the member the right to have the item taken up at a
 * general meeting if the written request reaches the board in time for it to go
 * into the notice to that meeting, and 6 kap. 22 § has that notice state the
 * matters to be dealt with. So the notice is what settles the answer: a meeting
 * whose members have been summoned is offered as a destination no longer, and
 * an item already on such a meeting cannot be moved off it - 6 kap. 25 § leaves
 * a meeting unable to decide a matter its notice did not take up.
 *
 * Both halves of that are the server's rule and the server enforces both, which
 * is why the refusals are separate sentences. What this panel does is offer only
 * the meetings the server would accept, so a board is not sent to a control that
 * can only refuse - and the item's own meeting stays on the list even once
 * summoned, because otherwise the row would stop saying where the item is.
 */
export function MotionQueuePanel({
  motions,
  deadline,
  meetings,
  onChanged,
}: MotionQueuePanelProps): ReactElement {
  const { t } = useTranslation();
  const [actingOn, setActingOn] = useState<string | null>(null);

  const acknowledge = useSaveAction(acknowledgeMotion, () => {
    setActingOn(null);
    onChanged();
  });
  const attach = useSaveAction(setMotionMeeting);

  const failure =
    acknowledge.state.kind === "failed"
      ? acknowledge.state.failure
      : attach.state.kind === "failed"
        ? attach.state.failure
        : null;

  /**
   * Puts one item on a meeting, or takes it off, and reads the queue again.
   *
   * The outcome is deliberately not read. A link written and a link refused both
   * change what the queue says - the refusal that most needs the fresh answer is
   * the one lost to another board member who moved the same item, where the row
   * on screen is already wrong about where the item is.
   */
  const putToMeeting = (motionId: string, meetingId: string | null): void => {
    acknowledge.reset();
    setActingOn(motionId);
    void attach
      .submit({ motionId, meetingId })
      .then(() => {
        onChanged();
      })
      .finally(() => {
        setActingOn(null);
      });
  };

  return (
    <Panel
      title={t("motions.queue.title")}
      description={t("motions.queue.description")}
      notice={
        failure === null ? (
          deadline === null ? (
            <Notice tone="info">{t("motions.queue.noDeadline")}</Notice>
          ) : (
            <Notice tone="info">
              {t("motions.queue.deadline", { date: deadline.nextOn })}
            </Notice>
          )
        ) : (
          <Notice tone="danger" live>
            {t(motionFailureKey(failure))}
          </Notice>
        )
      }
    >
      {motions.length === 0 ? (
        <p className="text-body text-ink-muted">{t("motions.queue.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {motions.map((motion) => (
            <li
              key={motion.id}
              className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-body font-semibold">{motion.title}</span>
                <MotionStatusChip status={motion.status} />
                <span className="ml-auto font-data text-data text-ink-muted">
                  {motion.submittedAt.slice(0, 10)}
                </span>
              </div>

              <p className="text-small whitespace-pre-line">{motion.body}</p>

              <p className="text-small text-ink-muted">
                {t("motions.queue.submittedBy")}{" "}
                <Submitter of={motion.submitter} />
              </p>

              {motion.status === "SUBMITTED" ? (
                <div>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    aria-label={t("motions.queue.acknowledgeNamed", {
                      title: motion.title,
                    })}
                    disabled={
                      actingOn === motion.id &&
                      acknowledge.state.kind === "saving"
                    }
                    onClick={() => {
                      setActingOn(motion.id);
                      void acknowledge.submit({ motionId: motion.id });
                    }}
                  >
                    {actingOn === motion.id &&
                    acknowledge.state.kind === "saving"
                      ? t("motions.queue.acknowledging")
                      : t("motions.queue.acknowledge")}
                  </button>
                </div>
              ) : null}

              {/* A withdrawn item is not put to a meeting: the member took it
                  back, and the server refuses the link for that reason rather
                  than for one the board can move it out of. */}
              {meetings === null || motion.status === "WITHDRAWN" ? (
                motion.meeting === null ? null : (
                  <p className={HINT}>
                    {t("motions.queue.onMeeting", {
                      kind: t(`meetings.kind.${motion.meeting.kind}`),
                      date: motion.meeting.heldOn,
                    })}
                  </p>
                )
              ) : (
                <MeetingChoice
                  motion={motion}
                  meetings={meetings}
                  busy={
                    actingOn === motion.id && attach.state.kind === "saving"
                  }
                  onChoose={(meetingId) => {
                    putToMeeting(motion.id, meetingId);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Which meeting this item is on, as a control the board changes.
 *
 * A select rather than a button per meeting, because the answer is one meeting
 * out of a list and taking it off again is the same answer set back to none -
 * which is exactly the shape the endpoint has.
 *
 * Only the meetings the server would accept are offered: one that has been
 * summoned may not take another item, and one recorded as held may not either.
 * The item's own meeting is offered whatever state it is in, because otherwise
 * the control would silently stop saying where the item is - and the row would
 * read as if the board had never answered.
 *
 * Once the item's own meeting has been summoned the control is gone altogether
 * and the row states the meeting instead. That is not the screen enforcing the
 * rule - the server refuses the change, and the refusal has its own sentence -
 * but a select that could only be set back to the value it already had would be
 * a control offering nothing.
 */
function MeetingChoice({
  motion,
  meetings,
  busy,
  onChoose,
}: {
  motion: QueuedMotion;
  meetings: readonly MeetingSummary[];
  busy: boolean;
  onChoose: (meetingId: string | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const own = motion.meeting;

  if (own !== null && own.summoned) {
    return (
      <p className={HINT}>
        {t("motions.queue.onSummonedMeeting", {
          kind: t(`meetings.kind.${own.kind}`),
          date: own.heldOn,
        })}
      </p>
    );
  }

  const offered = meetings.filter(
    (meeting) => meeting.concludedAt === null || meeting.id === own?.id,
  );

  return (
    <label className={`${LABEL} max-w-96`}>
      {t("motions.queue.meeting")}
      <select
        className={FIELD}
        value={own?.id ?? ""}
        disabled={busy}
        onChange={(event) => {
          onChoose(event.target.value === "" ? null : event.target.value);
        }}
      >
        <option value="">{t("motions.queue.noMeeting")}</option>
        {offered.map((meeting) => (
          <option key={meeting.id} value={meeting.id}>
            {`${t(`meetings.kind.${meeting.kind}`)} ${meeting.heldOn}`}
          </option>
        ))}
      </select>
      {offered.length === 0 ? (
        <span className={HINT}>{t("motions.queue.noMeetingsArranged")}</span>
      ) : null}
    </label>
  );
}

/**
 * Who submitted a motion, as the board is told.
 *
 * A member with protected personal data is not named here even though the
 * board's own address book prints them: that register has a statutory reason to
 * and a queue has none. A board member who has to reach them goes through the
 * register.
 */
function Submitter({ of }: { of: MotionSubmitter }): ReactElement {
  const { t } = useTranslation();

  if (of.kind === "member") {
    return <span>{of.name}</span>;
  }
  if (of.kind === "protected") {
    return <NotRecorded meaning={t("motions.queue.submitterProtected")} />;
  }
  return <NotRecorded meaning={t("motions.queue.submitterUnknown")} />;
}
