import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type AttendableOccurrence,
  fetchUpcomingOccurrences,
  signUpForOccurrence,
  withdrawFromOccurrence,
} from "../api/events";
import { formatTimeOfDay } from "../bookings/booking-calendar";
import { HINT, QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { formatEventDay } from "./event-calendar";
import { eventFailureKey } from "./event-failures";

/**
 * What the association has coming, and putting your name down for it.
 *
 * ## The count and the button come from the same answer
 *
 * Nothing here is optimistic. A sign-up is a place at a date with a limited
 * number of them, and two households can be taking the last one at the same
 * moment - so the only state this panel shows is state the server sent. Both
 * halves of every row are read out of one payload: the places gone, and whether
 * this reader has one of them. They therefore cannot disagree, which is what a
 * screen that counted its own click could not promise after losing a race.
 *
 * The reading effect owns every read, including the one an act asks for. That is
 * what `refreshes` is for. An act reads for itself would be a second reader with
 * its own idea of when its answer is stale, and the answer it gets describes one
 * date while this list describes every date - a claim that landed on another row
 * in the meantime would be invisible until something else happened to reload.
 *
 * The re-read happens whether the act succeeded or was refused, and the refusal
 * that most needs it is the one for a date whose last place has just gone: the
 * sentence says somebody was first, and the count beside it has to say so too.
 * That is why the outcome is read off `submit`'s own answer rather than only
 * through `onSaved`, which runs on success alone.
 *
 * ## What a row does not carry
 *
 * How many places are gone, and never who has them. Who is coming is personal
 * data about other residents and is what events:manage exists to gate, so there
 * is no field in the answer for it and nothing on this panel to render one into.
 *
 * ## When there is no button
 *
 * A date that takes no sign-ups, one the board has called off, one that has
 * begun and one whose places are gone are all rendered as a statement rather
 * than as a control. Each of them is refused by the server, and a button that
 * always refused would be a worse way to say so. All four facts come from the
 * answer, "has begun" included: the calendar decides and the screen renders,
 * which is the rule every other fact on the row already follows. A comparison
 * made here would be a second clock, on a machine whose time nobody here sets.
 *
 * ## Whether the same words are on the street
 *
 * A row published to everyone says so. Somebody reading a notice about the sauna
 * is entitled to see the members' events and the public ones both, and cannot
 * otherwise tell which of the two they have in front of them - and a board that
 * published one to the street by mistake should find out from a screen rather
 * than from a neighbour. The audience is on this answer and on no payload the
 * website itself is given.
 */
export function EventAttendPanel(): ReactElement {
  const { t, i18n } = useTranslation();

  const [occurrences, setOccurrences] = useState<
    readonly AttendableOccurrence[] | null
  >(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * Bumped to ask for the calendar again without changing what is asked for.
   *
   * An act needs a fresh read of the same list, which is a request the reading
   * effect below cannot tell from the one it already made. This is how it is
   * told, and it keeps that effect the only thing that reads.
   */
  const [refreshes, setRefreshes] = useState(0);
  /**
   * Which date the act in flight is for.
   *
   * One action serves the whole list, so without this every row reads the same
   * save state and one click puts "signing up" on every date of the year.
   */
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    // The effect owns its own call and drops an answer that arrives after the
    // panel is gone, or after a later read superseded it.
    let active = true;
    void fetchUpcomingOccurrences().then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        setOccurrences(result.value);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [refreshes]);

  const claim = useSaveAction(signUpForOccurrence);
  const stand = useSaveAction(withdrawFromOccurrence);

  const busy = claim.state.kind === "saving" || stand.state.kind === "saving";

  /**
   * Runs one act on one date, and reads the calendar again either way.
   *
   * `acting` is cleared when the act settles, whichever way it went. Left
   * standing, the row would go on reading "signing up" over a sign-up that has
   * finished - the accessible name saying what the date has become while the
   * words inside it still say what is happening to it.
   */
  const act = (
    occurrenceId: string,
    run: (id: string) => Promise<boolean>,
  ): void => {
    setActing(occurrenceId);
    /*
     * The outcome is deliberately not read. A place taken and a place refused
     * both change what the calendar says, and the refusal that most needs the
     * fresh answer is the one for a date whose last place has just gone.
     */
    void run(occurrenceId)
      .then(() => {
        setRefreshes((count) => count + 1);
      })
      .finally(() => {
        setActing(null);
      });
  };

  const signUp = (occurrenceId: string): void => {
    stand.reset();
    act(occurrenceId, claim.submit);
  };

  const withdraw = (occurrenceId: string): void => {
    claim.reset();
    act(occurrenceId, stand.submit);
  };

  /*
   * The refusal on screen is the one the last act met. Each act clears the other
   * before it runs, so this is a tie-break between simultaneous acts rather
   * than a ranking of stale ones.
   */
  const failure =
    claim.state.kind === "failed"
      ? claim.state.failure
      : stand.state.kind === "failed"
        ? stand.state.failure
        : null;

  const days = groupByDay(occurrences ?? []);

  return (
    <Panel
      title={t("events.attend.title")}
      description={t("events.attend.description")}
      notice={
        loadFailed ? (
          <Notice tone="danger" live>
            {t("events.loadFailed")}
          </Notice>
        ) : failure !== null ? (
          <Notice tone="danger" live>
            {t(eventFailureKey(failure))}
          </Notice>
        ) : claim.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("events.attend.signedUp")}
          </Notice>
        ) : stand.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("events.attend.withdrawn")}
          </Notice>
        ) : null
      }
    >
      {/*
       * Nothing under a first read that failed: the notice above has already
       * said the calendar could not be read, and "reading the calendar..." under
       * it would go on saying something is still happening when nothing is. A
       * failed re-read is a different case and keeps the list it has, because the
       * dates on screen are still the last thing the server said.
       */}
      {occurrences === null ? (
        loadFailed ? null : (
          <p role="status" className="text-body text-ink-muted">
            {t("events.attend.loading")}
          </p>
        )
      ) : days.length === 0 ? (
        <p className="text-body text-ink-muted">{t("events.attend.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-5">
          {days.map(([day, dates]) => (
            <li key={day} className="flex flex-col gap-2">
              <h3 className="text-label text-ink-muted uppercase">
                <time dateTime={day}>{formatEventDay(day, i18n.language)}</time>
              </h3>
              <ul className="flex flex-col gap-3">
                {dates.map((occurrence) => (
                  <li key={occurrence.occurrenceId}>
                    <OccurrenceRow
                      occurrence={occurrence}
                      busy={busy}
                      acting={busy && acting === occurrence.occurrenceId}
                      onSignUp={() => {
                        signUp(occurrence.occurrenceId);
                      }}
                      onWithdraw={() => {
                        withdraw(occurrence.occurrenceId);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * One date, and the one act it offers.
 *
 * Every fact on it is the server's. The row is a statement rather than a control
 * wherever the act would be refused, and the sentence says which of the four
 * reasons it is - a disabled button carrying no word would leave the reader
 * guessing between "full" and "called off".
 */
function OccurrenceRow({
  occurrence,
  busy,
  acting,
  onSignUp,
  onWithdraw,
}: {
  occurrence: AttendableOccurrence;
  /** True while any act on the panel is in flight. */
  busy: boolean;
  /** True while the act in flight is this row's. */
  acting: boolean;
  onSignUp: () => void;
  onWithdraw: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const standing =
    occurrence.own !== null && occurrence.own.withdrawnAt === null;
  const calledOff = occurrence.cancelledAt !== null;
  const begun = occurrence.begun;
  const full = occurrence.placesLeft === 0;

  return (
    <article
      className={[
        "flex flex-col gap-2 rounded-control border bg-page px-3 py-3",
        calledOff ? "border-dashed border-line" : "border-line",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-body font-semibold">{occurrence.title}</h4>
        {occurrence.category === null ? null : (
          <span className="text-chip text-ink-muted uppercase">
            {occurrence.category}
          </span>
        )}
        <span className="font-data text-data">
          <time dateTime={occurrence.startsAt}>
            {formatTimeOfDay(occurrence.startsAt, locale)}
          </time>{" "}
          {t("events.until")}{" "}
          <time dateTime={occurrence.endsAt}>
            {formatTimeOfDay(occurrence.endsAt, locale)}
          </time>
        </span>
        {standing ? (
          <span className="rounded-control bg-info-soft px-2 py-0.5 text-chip uppercase">
            {t("events.attend.yours")}
          </span>
        ) : null}
        {/* Said only for the audience that is not the default. A members' event
            is what the calendar is, so marking those would mark almost every
            row and say nothing; the one worth a word is the one that is also on
            the street. */}
        {occurrence.visibility === "PUBLIC" ? (
          <span
            title={t("events.attend.alsoPublicTitle")}
            className="text-chip text-ink-muted uppercase"
          >
            {t("events.attend.alsoPublic")}
          </span>
        ) : null}
      </div>

      {occurrence.location === null ? null : (
        <p className="text-small text-ink-muted">{occurrence.location}</p>
      )}

      {occurrence.description === null ? null : (
        <p className="text-small whitespace-pre-line">
          {occurrence.description}
        </p>
      )}

      {/*
       * The places, exactly as the server counted them. Two sentences rather
       * than one, because "eight of twenty places are gone" and "eight have
       * signed up" are different facts: a series with no capacity has no
       * remainder to state, and a screen that invented one would be inventing a
       * limit the board did not set.
       */}
      {occurrence.signupOpen ? (
        <p className={HINT}>
          {occurrence.capacity === null
            ? t("events.attend.signedUpCount", {
                count: occurrence.placesTaken,
              })
            : t("events.attend.places", {
                taken: occurrence.placesTaken,
                capacity: occurrence.capacity,
              })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {calledOff ? (
          <p className="text-small text-ink-muted">
            {t("events.attend.calledOff")}
          </p>
        ) : !occurrence.signupOpen ? (
          <p className="text-small text-ink-muted">
            {t("events.attend.noSignup")}
          </p>
        ) : standing ? (
          <button
            type="button"
            disabled={busy}
            // The name carries the event and the date, because every row offers
            // the same act and "stand down" on its own does not say from what.
            aria-label={t("events.attend.withdrawNamed", {
              title: occurrence.title,
              date: formatEventDay(occurrence.on, locale),
            })}
            onClick={onWithdraw}
            className={QUIET_BUTTON}
          >
            {acting
              ? t("events.attend.withdrawing")
              : t("events.attend.withdraw")}
          </button>
        ) : begun ? (
          <p className="text-small text-ink-muted">
            {t("events.attend.begun")}
          </p>
        ) : full ? (
          <p className="text-small text-ink-muted">{t("events.attend.full")}</p>
        ) : (
          <button
            type="button"
            disabled={busy}
            aria-label={t("events.attend.signUpNamed", {
              title: occurrence.title,
              date: formatEventDay(occurrence.on, locale),
            })}
            onClick={onSignUp}
            className={SECONDARY_BUTTON}
          >
            {acting ? t("events.attend.signingUp") : t("events.attend.signUp")}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * The dates grouped by the local day the server said they belong to.
 *
 * The day comes from the answer rather than being worked out here, because which
 * day a date belongs to is a question about the association's clock and the
 * server has already answered it. The order the API returned is kept, which is
 * earliest first.
 */
function groupByDay(
  occurrences: readonly AttendableOccurrence[],
): readonly [string, AttendableOccurrence[]][] {
  const days = new Map<string, AttendableOccurrence[]>();
  for (const occurrence of occurrences) {
    const held = days.get(occurrence.on);
    if (held === undefined) {
      days.set(occurrence.on, [occurrence]);
    } else {
      held.push(occurrence);
    }
  }
  return [...days];
}
