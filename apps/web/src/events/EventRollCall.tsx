import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  type EventAttendee,
  fetchRollCall,
  type RollCall,
  withdrawSignupForBoard,
} from "../api/events";
import { HINT, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { formatEventDay } from "./event-calendar";
import { eventFailureKey } from "./event-failures";

/**
 * Who has put their name down for one date (deltagarlistan).
 *
 * Behind events:manage, which is the whole of this panel's reason to exist: a
 * roll-call is a list of named residents and which of the association's dates
 * each of them is going to, which is personal data no other resident is shown.
 * The calendar a resident reads carries how many places are gone and never who
 * has them.
 *
 * A person with protected personal data (skyddade personuppgifter) is a place
 * here and never a name. The board's own address book prints it because a
 * statutory register has to; a list read in a stairwell doorway has no such
 * reason, and the server does not send the name either. Somebody the register no
 * longer holds is a place too, because a sign-up outlives the person record a
 * purge has reached.
 *
 * Read when it is opened rather than with the series it belongs to. A board
 * reading its calendar is not asking who is coming to all of it, and reading
 * every roll-call of a weekly series would be reading a year of residents'
 * names to draw one screen.
 *
 * The ones who stood down stay on the list, saying that they did. That is the
 * point of a withdrawal being a dated close rather than a deleted row: who was
 * expected and who changed their mind are two answers rather than one absence.
 *
 * The row says that they stood down and not when. The date is on the sign-up,
 * and what reaches this screen is the instant it was written; which day of the
 * association's own calendar that instant falls on is a question the server has
 * answered for the occurrence and not for the withdrawal, so there is no local
 * day here to print and nothing here derives one. What a board reading this list
 * is deciding is who to expect, and for that the word is the whole answer.
 */
export function EventRollCall({
  occurrenceId,
}: {
  occurrenceId: string;
}): ReactElement {
  const { t, i18n } = useTranslation();

  const [rollCall, setRollCall] = useState<RollCall | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * Bumped to ask for the list again without changing which date is asked for.
   *
   * A withdrawal needs a fresh read of the same date, which the reading effect
   * cannot tell from the read it already made. This is how it is told, and it
   * keeps that effect the only thing that reads - so the places taken and the
   * rows below it are one answer and cannot disagree.
   */
  const [refreshes, setRefreshes] = useState(0);
  /** Which row the withdrawal in flight belongs to. */
  const [standing, setStanding] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchRollCall(occurrenceId).then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        setRollCall(result.value);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [occurrenceId, refreshes]);

  const withdraw = (signupId: string): void => {
    setStanding(signupId);
    setFailure(null);
    void withdrawSignupForBoard(signupId)
      .then((result) => {
        if (!result.ok) {
          setFailure(result.failure);
        }
        // Read again either way. A withdrawal that was refused because somebody
        // had already stood down leaves a list saying otherwise, and the board's
        // next act depends on which of them is true.
        setRefreshes((count) => count + 1);
      })
      .finally(() => {
        setStanding(null);
      });
  };

  if (loadFailed) {
    return (
      <Notice tone="danger" live>
        {t("events.rollCall.loadFailed")}
      </Notice>
    );
  }

  if (rollCall === null) {
    return (
      <p role="status" className="text-small text-ink-muted">
        {t("events.rollCall.loading")}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-control border border-line bg-raised px-3 py-3">
      <header className="flex flex-col gap-1">
        <h5 className="text-label text-ink-muted uppercase">
          {t("events.rollCall.heading")}
        </h5>
        <p className={HINT}>
          {rollCall.capacity === null
            ? t("events.rollCall.signedUpCount", {
                count: rollCall.placesTaken,
              })
            : t("events.rollCall.places", {
                taken: rollCall.placesTaken,
                capacity: rollCall.capacity,
              })}
        </p>
      </header>

      {failure === null ? null : (
        <Notice tone="danger" live>
          {t(eventFailureKey(failure))}
        </Notice>
      )}

      {rollCall.entries.length === 0 ? (
        <p className="text-small text-ink-muted">
          {t("events.rollCall.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rollCall.entries.map((entry) => (
            <li
              key={entry.signupId}
              className="flex flex-wrap items-center gap-3 border-t border-line pt-2 text-small first:border-t-0 first:pt-0"
            >
              <span id={`eventAttendee-${entry.signupId}`}>
                <Attendee attendee={entry.attendee} />
              </span>

              {entry.withdrawnAt === null ? (
                <button
                  type="button"
                  disabled={standing !== null}
                  // The name carries the date, because every roll-call on the
                  // screen offers the same act. Never the attendee's name: an
                  // accessible name is text like any other, and the protected
                  // rows deliberately have none to put in it.
                  aria-label={t("events.rollCall.withdrawNamed", {
                    date: formatEventDay(rollCall.on, i18n.language),
                  })}
                  // Which row it is, from the row's own text rather than from a
                  // name this component may not have. One roll-call is one date,
                  // so the name above is the same on every row and says which
                  // date but not which person - and somebody moving through the
                  // list with a screen reader is choosing between people. What
                  // the row says is what the description says, so a protected row
                  // describes itself as protected personal data and a purged one
                  // as no longer in the register, and neither invents a name.
                  aria-describedby={`eventAttendee-${entry.signupId}`}
                  onClick={() => {
                    withdraw(entry.signupId);
                  }}
                  className={`${QUIET_BUTTON} ml-auto`}
                >
                  {standing === entry.signupId
                    ? t("events.rollCall.withdrawing")
                    : t("events.rollCall.withdraw")}
                </button>
              ) : (
                <span className="ml-auto text-ink-muted">
                  {t("events.rollCall.stoodDown")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Who signed up, in the three shapes the server can answer with. */
function Attendee({ attendee }: { attendee: EventAttendee }): ReactElement {
  const { t } = useTranslation();

  if (attendee.kind === "resident") {
    return <span>{attendee.name}</span>;
  }
  if (attendee.kind === "protected") {
    return <span>{t("events.rollCall.attendeeProtected")}</span>;
  }
  return <span>{t("events.rollCall.attendeeUnknown")}</span>;
}
