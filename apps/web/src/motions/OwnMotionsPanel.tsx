import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type OwnMotion, withdrawMotion } from "../api/motions";
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

  const withdraw = useSaveAction(withdrawMotion, () => {
    setActingOn(null);
    onChanged();
  });

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
                  {motion.submittedAt.slice(0, 10)}
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
                    disabled={
                      actingOn === motion.id && withdraw.state.kind === "saving"
                    }
                    onClick={() => {
                      setActingOn(motion.id);
                      void withdraw.submit({ motionId: motion.id });
                    }}
                  >
                    {actingOn === motion.id && withdraw.state.kind === "saving"
                      ? t("motions.mine.withdrawing")
                      : t("motions.mine.withdraw")}
                  </button>
                </div>
              ) : (
                <p className="text-small text-ink-muted">
                  {motion.status === "ACKNOWLEDGED"
                    ? t("motions.mine.acknowledgedOn", {
                        date: motion.closedAt?.slice(0, 10) ?? "",
                      })
                    : t("motions.mine.withdrawnOn", {
                        date: motion.closedAt?.slice(0, 10) ?? "",
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
