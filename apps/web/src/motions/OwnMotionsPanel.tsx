import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type OwnMotion, withdrawMotion } from "../api/motions";
import { localDayOfInstant } from "../bookings/booking-calendar";
import { QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { motionFailureKey } from "./motion-failures";
import { MotionStatusChip } from "./MotionStatusChip";

export interface OwnMotionsPanelProps {
  motions: readonly OwnMotion[];
  onChanged: () => void;
}

/**
 * What this member has put to the meeting.
 *
 * Withdrawing is offered only while the motion is still open, because that is
 * the only state the API accepts it in: once the board has recorded that it
 * received the item, the item may already be in a notice that has been issued, and a
 * button that always failed would be a worse way to say so than no button.
 *
 * A withdrawn motion stays on the list with its date. The record that the member
 * put something to the meeting is theirs, and nothing here deletes a row - the
 * purge does, two years after the motion closed.
 *
 * Which meeting takes the item up is stated as soon as the board has answered.
 * That is the answer the right in EFL 6 kap. 15 § is actually about - it is a
 * right to have the item taken up at a general meeting - so a member who is told
 * only that the board received it has been told the smaller half. It is named
 * and dated rather than given as an identifier, because a member holds no
 * capability that would resolve one, and the notice states the same meeting to
 * them anyway.
 */
export function OwnMotionsPanel({
  motions,
  onChanged,
}: OwnMotionsPanelProps): ReactElement {
  const { t } = useTranslation();
  /** Which row is mid-request, so only that row reads as busy. */
  const [actingOn, setActingOn] = useState<string | null>(null);

  /*
   * Read again whatever the answer. The likely refusal is the board having
   * acknowledged the motion meanwhile, and then the row on the screen is the
   * thing that is wrong: left as it is, it keeps a button every retry of which
   * is refused.
   */
  const settled = (): void => {
    setActingOn(null);
    onChanged();
  };
  const withdraw = useSaveAction(withdrawMotion, settled, settled);
  // Every row waits while one withdrawal is out, so a second row pressed
  // meanwhile cannot be freed by the first one's answer and sent twice.
  const saving = withdraw.state.kind === "saving";

  const failure =
    withdraw.state.kind === "failed" ? withdraw.state.failure : null;

  return (
    <Panel
      title={t("motions.mine.title")}
      description={t("motions.mine.description")}
      notice={
        failure === null ? null : (
          <Notice tone="danger" live>
            {t(motionFailureKey(failure))}
          </Notice>
        )
      }
    >
      {motions.length === 0 ? (
        <p className="text-body text-ink-muted">{t("motions.mine.empty")}</p>
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
                  {localDayOfInstant(motion.submittedAt)}
                </span>
              </div>

              <p className="text-small whitespace-pre-line">{motion.body}</p>

              {motion.meeting === null ? null : (
                <p className="font-data text-small text-ink-muted">
                  {t("motions.mine.onMeeting", {
                    kind: t(`meetings.kind.${motion.meeting.kind}`),
                    date: motion.meeting.heldOn,
                  })}
                </p>
              )}

              {motion.status === "SUBMITTED" ? (
                <div>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    // Names the motion, because every row offers the same act
                    // and a screen reader hears one button per row otherwise.
                    aria-label={t("motions.mine.withdrawNamed", {
                      title: motion.title,
                    })}
                    disabled={saving}
                    onClick={() => {
                      setActingOn(motion.id);
                      void withdraw.submit({ motionId: motion.id });
                    }}
                  >
                    {actingOn === motion.id && saving
                      ? t("motions.mine.withdrawing")
                      : t("motions.mine.withdraw")}
                  </button>
                </div>
              ) : (
                <p className="text-small text-ink-muted">
                  {motion.status === "ACKNOWLEDGED"
                    ? t("motions.mine.acknowledgedOn", {
                        date:
                          motion.closedAt === null
                            ? ""
                            : localDayOfInstant(motion.closedAt),
                      })
                    : t("motions.mine.withdrawnOn", {
                        date:
                          motion.closedAt === null
                            ? ""
                            : localDayOfInstant(motion.closedAt),
                      })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
