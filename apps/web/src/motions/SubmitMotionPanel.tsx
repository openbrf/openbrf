import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type MotionDeadline, submitMotion } from "../api/motions";
import { FIELD, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { motionFailureKey, scannedParts } from "./motion-failures";

export interface SubmitMotionPanelProps {
  /** The bylaws clause, or null when the bylaws set none. */
  deadline: MotionDeadline | null;
  onSubmitted: () => void;
}

const EMPTY = { title: "", body: "" };

/**
 * Putting an item to the general meeting.
 *
 * The form is offered to whoever the server let onto this screen, which under
 * EFL 6 kap. 15 § is a member: `motions:submit` is derived from membership rather
 * than from residency, so a partner, an adult child or a tenant never reaches it.
 * The server asks the register again before it writes, so hiding or showing this
 * panel is courtesy either way.
 *
 * The deadline is stated and never enforced. It is the condition on the right to
 * have an item taken up at a *particular* meeting rather than a condition on the
 * association's ability to receive one, so a motion arriving after it is taken
 * and the board decides which meeting it can reach. Saying so here is the point:
 * a form that silently accepted a late motion without mentioning the date would
 * leave a member believing their item was on the coming agenda.
 */
export function SubmitMotionPanel({
  deadline,
  onSubmitted,
}: SubmitMotionPanelProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(EMPTY);

  const send = useSaveAction(submitMotion, () => {
    setDraft(EMPTY);
    onSubmitted();
  });

  const failure = send.state.kind === "failed" ? send.state.failure : null;
  /*
   * Which fields the scan caught, by name and never by value.
   *
   * The refusal carries an offset too, and it is deliberately not shown: a
   * character position in a textarea is not something a person can act on, while
   * "there is a personal identity number in the body" is.
   */
  const scanned = failure === null ? [] : scannedParts(failure);

  return (
    <Panel
      title={t("motions.submit.title")}
      description={t("motions.submit.description")}
      notice={
        failure === null ? (
          deadline === null ? (
            <Notice tone="info">{t("motions.submit.noDeadline")}</Notice>
          ) : (
            <Notice tone="info">
              {t("motions.submit.deadline", { date: deadline.nextOn })}
            </Notice>
          )
        ) : (
          <Notice tone="danger" live>
            {t(motionFailureKey(failure))}
            {scanned.length === 0
              ? null
              : ` ${scanned
                  .map((part) =>
                    part === "title"
                      ? t("motions.submit.titleField")
                      : t("motions.submit.bodyField"),
                  )
                  .join(", ")}`}
          </Notice>
        )
      }
      actions={
        <>
          <button
            type="submit"
            form="submit-motion"
            className={PRIMARY_BUTTON}
            disabled={send.state.kind === "saving"}
          >
            {send.state.kind === "saving"
              ? t("motions.submit.sending")
              : t("motions.submit.action")}
          </button>
          {send.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("motions.submit.sent")}
            </Notice>
          ) : null}
        </>
      }
    >
      <form
        id="submit-motion"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send.submit(draft);
        }}
      >
        <label className={LABEL}>
          {t("motions.submit.titleField")}
          <input
            className={FIELD}
            value={draft.title}
            maxLength={200}
            required
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
        </label>

        <label className={LABEL}>
          {t("motions.submit.bodyField")}
          <textarea
            className={`${FIELD} min-h-40 py-2`}
            value={draft.body}
            maxLength={8000}
            required
            onChange={(event) => {
              setDraft({ ...draft, body: event.target.value });
            }}
          />
        </label>
      </form>
    </Panel>
  );
}
