import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  acknowledgeMotion,
  type MotionDeadline,
  type MotionSubmitter,
  type QueuedMotion,
} from "../api/motions";
import { SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { motionFailureKey } from "./motion-failures";
import { MotionStatusChip } from "./MotionStatusChip";

export interface MotionQueuePanelProps {
  motions: readonly QueuedMotion[];
  deadline: MotionDeadline | null;
  onChanged: () => void;
}

/**
 * The queue the board works: what the members have put to the meeting.
 *
 * Open motions first and oldest first within a status, which is the order the
 * server returns them in - the queue is worked from the top and the item that has
 * been waiting longest is the one to look at.
 *
 * Acknowledging is the only act on this panel, and it records that the board has
 * received the motion. There is deliberately no reject control: refusing to take
 * up a member's item is not the board's to decide under EFL 6 kap. 15 §, and
 * whether the meeting adopts the proposal is minuted at the meeting rather than
 * here.
 */
export function MotionQueuePanel({
  motions,
  deadline,
  onChanged,
}: MotionQueuePanelProps): ReactElement {
  const { t } = useTranslation();
  const [actingOn, setActingOn] = useState<string | null>(null);

  const acknowledge = useSaveAction(acknowledgeMotion, () => {
    setActingOn(null);
    onChanged();
  });

  const failure =
    acknowledge.state.kind === "failed" ? acknowledge.state.failure : null;

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
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
