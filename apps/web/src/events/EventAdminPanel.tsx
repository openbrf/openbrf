import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure, ApiResult } from "../api/client";
import {
  cancelEventOccurrence,
  createEventSeries,
  EVENT_CALENDAR_WINDOW_DAYS,
  type EventOccurrence,
  type EventSeries,
  type EventSeriesInput,
  type EventVisibility,
  fetchEventSeries,
  publishEventSeries,
  reinstateEventOccurrence,
  removeEventSeries,
  updateEventSeries,
} from "../api/events";
import {
  formatTimeOfDay,
  localDayNow,
  shiftLocalDay,
} from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { formatEventDay } from "./event-calendar";
import {
  draftOf,
  EMPTY_DRAFT,
  type EventDraft,
  inputOf,
  signatureOf,
} from "./event-draft";
import {
  eventFailureKey,
  type EventTextField,
  refusedDates,
  scannedFields,
} from "./event-failures";
import { EventRollCall } from "./EventRollCall";
import { EventSeriesFields } from "./EventSeriesFields";

const VISIBILITIES: readonly EventVisibility[] = ["MEMBER", "PUBLIC"];

const VISIBILITY_LABEL: Readonly<Record<EventVisibility, TranslationKey>> = {
  MEMBER: "events.manage.audienceMember",
  PUBLIC: "events.manage.audiencePublic",
};

/** The sentence naming each field a personal identity number was found in. */
const FIELD_LABEL: Readonly<Record<EventTextField, TranslationKey>> = {
  title: "events.manage.titleField",
  description: "events.manage.descriptionField",
  category: "events.manage.categoryField",
  location: "events.manage.locationField",
};

/** Which act is in flight, and on which series or date. */
interface Running {
  readonly kind:
    "add" | "save" | "publish" | "callOff" | "reinstate" | "remove";
  readonly target: string;
}

/**
 * One read of the calendar, and which period it answers for.
 *
 * The period is carried with the list so the panel can tell an answer about what
 * is on screen from one about the period that was on screen a moment ago. The
 * board's calendar reads a window at a time, and applying a late answer
 * unguarded would replace the months being looked at with the ones that were.
 */
interface Loaded {
  readonly key: string;
  readonly series: readonly EventSeries[];
}

/**
 * The association's calendar, as the board keeps it.
 *
 * One series is one card here, with its dates under it. A series that happens
 * once is a series with one date and not a second kind of thing, which is why
 * there is one form rather than two: the recurrence is a field on it, and
 * "does not repeat" is one of that field's values.
 *
 * ## Publishing is its own act
 *
 * Saving a series does not decide who may read it, and publishing one does not
 * change what it says. That follows the API, and the API is that way because
 * publication is what the audit log records and what the personal-identity-number
 * scan guards - a second way to reach either through an ordinary save would be a
 * second way for the record to be missed. Members unless the board says
 * otherwise, so a slip never puts a cleaning day on the street.
 *
 * ## A period at a time
 *
 * The endpoint answers for a window of days, because the whole calendar in one
 * payload is a read that grows with every series a house enters. So this panel
 * asks for a period and says which one it is showing, and earlier and later move
 * it by exactly the window the API answers for - no gap between one period and
 * the next, and never a request wide enough to be refused.
 *
 * A series with no date in the period is not on the screen, and that includes a
 * series entered a moment ago for a date further out. The card header states how
 * many dates the series has altogether, from the server's own count, so a period
 * showing three of twelve never reads as a series of three.
 *
 * ## One notice, cleared before every act
 *
 * Six acts share one notice, so each of them clears it before it runs. Without
 * that the refusal of a save would sit above a publication that then succeeded,
 * and the sentence about a personal identity number in the description would
 * still be on screen while the board was reading a date it had just called off.
 *
 * Two refusals say more than a sentence, and both are read off the response
 * rather than guessed at. `personal-identity-number` names the fields it was
 * found in - the field and never the value, and never the position, on the
 * reading the motion form applies to the same refusal. `occurrence-in-use` names
 * the dates people have signed up to, which is what makes it actionable: the
 * board's next act is to call one of those dates off or to stand its sign-ups
 * down, and both are on this card.
 *
 * ## Reading again after a refusal
 *
 * Every act ends in a read of the list, refused or not. The refusals here are
 * mostly about state the board is looking at - a date already called off,
 * sign-ups standing on a date an edit would move - so the list it goes back to
 * has to be the current one rather than the one that produced the refusal.
 */
export function EventAdminPanel(): ReactElement {
  const { t, i18n } = useTranslation();

  /** The first day of the period on screen. The last is derived from it. */
  const [from, setFrom] = useState(() => localDayNow());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * Bumped to ask for the list again without changing what is asked for.
   *
   * Every act asks for one, which is a request the reading effect below cannot
   * tell from the read it already made. This is how it is told, and it keeps
   * that effect the only thing that reads.
   */
  const [refreshes, setRefreshes] = useState(0);
  const [draft, setDraft] = useState<EventDraft>(EMPTY_DRAFT);
  const [running, setRunning] = useState<Running | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [outcome, setOutcome] = useState<TranslationKey | null>(null);

  const to = shiftLocalDay(from, EVENT_CALENDAR_WINDOW_DAYS - 1);
  const key = `${from}|${to}`;

  useEffect(() => {
    // The effect owns its own call and drops an answer that arrives after the
    // panel is gone, or after a later read superseded it.
    let active = true;
    void fetchEventSeries({ from, to }).then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        setLoaded({ key, series: result.value });
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [key, from, to, refreshes]);

  /*
   * The list on screen, or nothing while the answer describes another period.
   * A re-read of the same period that failed keeps the list it has - see the
   * render below for why - and one for a period nothing has answered for yet
   * has no list to keep.
   */
  const series = loaded?.key === key ? loaded.series : null;

  /**
   * Runs one act, reads the list again, and answers whether it was taken.
   *
   * One runner rather than one save hook per act, because the six of them share
   * a notice and the order that notice is read in has to be "the last act",
   * never "whichever act failed most recently". Clearing here is what makes that
   * true for all six at once.
   *
   * The answer is the outcome and not the value, because only one caller needs
   * to know: the form that adds a series clears its fields once the series
   * exists, and clearing them after a refusal would throw away what the board
   * had typed at the moment they were told to change one field of it.
   */
  const run = useCallback(
    async (
      what: Running,
      call: () => Promise<ApiResult<unknown>>,
      said: TranslationKey,
    ): Promise<boolean> => {
      setRunning(what);
      setFailure(null);
      setOutcome(null);

      const result = await call();

      setRunning(null);
      if (result.ok) {
        setOutcome(said);
      } else {
        setFailure(result.failure);
      }
      setRefreshes((count) => count + 1);
      return result.ok;
    },
    [],
  );

  const busy = running !== null;

  const onAdd = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const values = inputOf(draft);
    if (values === null) {
      return;
    }
    void run(
      { kind: "add", target: "" },
      () => createEventSeries(values),
      "events.manage.added",
    ).then((added) => {
      // Cleared only once the series exists. A refused form still holds what the
      // board typed, and the refusal tells them which part of it to change.
      if (added) {
        setDraft(EMPTY_DRAFT);
      }
    });
  };

  /*
   * The particulars a refusal published, in the words of the form the board is
   * looking at. Empty for every other refusal, which is what keeps the sentence
   * below one sentence.
   */
  const scanned = failure === null ? [] : scannedFields(failure);
  const dates = failure === null ? [] : refusedDates(failure);

  return (
    <Panel
      title={t("events.manage.title")}
      description={t("events.manage.description")}
      notice={
        loadFailed ? (
          <Notice tone="danger" live>
            {t("events.loadFailed")}
          </Notice>
        ) : failure !== null ? (
          <Notice tone="danger" live>
            {t(eventFailureKey(failure))}
            {scanned.length === 0
              ? null
              : ` ${scanned.map((field) => t(FIELD_LABEL[field])).join(", ")}`}
            {/* The dates as the list below writes them, and in the same face:
                the board's next act is to find one of them on that list, and a
                notice saying 2026-04-18 above a row saying lordag 18 april 2026
                would leave them mapping one form onto the other. */}
            {dates.length === 0 ? null : (
              <>
                {" "}
                <span className="font-data">
                  {dates
                    .map((day) => formatEventDay(day, i18n.language))
                    .join(", ")}
                </span>
              </>
            )}
          </Notice>
        ) : outcome !== null ? (
          <Notice tone="ok" live>
            {t(outcome)}
          </Notice>
        ) : null
      }
    >
      {/*
       * The period, and the two ways out of it. Named with its years, because
       * this calendar reaches into the next one and a period read as "18 april
       * to 19 juni" would be ambiguous exactly when a board is planning.
       */}
      <nav
        aria-label={t("events.manage.period")}
        className="flex flex-wrap items-center gap-3"
      >
        <button
          type="button"
          className={QUIET_BUTTON}
          onClick={() => {
            setFrom((current) =>
              shiftLocalDay(current, -EVENT_CALENDAR_WINDOW_DAYS),
            );
          }}
        >
          {t("events.manage.earlier")}
        </button>
        <span className="text-small text-ink-muted">
          <time dateTime={from}>{formatEventDay(from, i18n.language)}</time>{" "}
          {t("events.until")}{" "}
          <time dateTime={to}>{formatEventDay(to, i18n.language)}</time>
        </span>
        <button
          type="button"
          className={`${QUIET_BUTTON} ml-auto`}
          onClick={() => {
            setFrom((current) =>
              shiftLocalDay(current, EVENT_CALENDAR_WINDOW_DAYS),
            );
          }}
        >
          {t("events.manage.later")}
        </button>
      </nav>

      {/*
       * Nothing under a first read that failed, for the reason the attending
       * panel says: the notice above has said the calendar could not be read, and
       * "reading the calendar..." under it would go on saying something is still
       * happening. A failed re-read of the period on screen keeps the list it
       * has - the form below writes against those series, and taking them away
       * would take the form with them. A read for a period nothing has answered
       * for yet has no list to keep, so that one waits.
       */}
      {series === null ? (
        loadFailed ? null : (
          <p role="status" className="text-body text-ink-muted">
            {t("events.manage.loading")}
          </p>
        )
      ) : series.length === 0 ? (
        <p className="text-body text-ink-muted">{t("events.manage.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {series.map((event) => (
            <li key={event.id}>
              <SeriesCard
                // Keyed on the stored values, so a save re-seeds the fields with
                // what is now stored rather than leaving them showing what was
                // typed and refused.
                key={signatureOf(event)}
                series={event}
                busy={busy}
                running={running}
                onSave={(values) => {
                  void run(
                    { kind: "save", target: event.id },
                    () => updateEventSeries({ id: event.id, values }),
                    "events.manage.saved",
                  );
                }}
                onPublish={(published, visibility) => {
                  void run(
                    { kind: "publish", target: event.id },
                    () =>
                      publishEventSeries({
                        id: event.id,
                        // The audience is stated when publishing and left alone
                        // when taking down: taking a series down says nothing
                        // about who it was arranged for.
                        values: published
                          ? { published: true, visibility }
                          : { published: false },
                      }),
                    published
                      ? "events.manage.published"
                      : "events.manage.takenDown",
                  );
                }}
                onCallOff={(occurrenceId) => {
                  void run(
                    { kind: "callOff", target: occurrenceId },
                    () => cancelEventOccurrence(occurrenceId),
                    "events.manage.calledOff",
                  );
                }}
                onReinstate={(occurrenceId) => {
                  void run(
                    { kind: "reinstate", target: occurrenceId },
                    () => reinstateEventOccurrence(occurrenceId),
                    "events.manage.reinstated",
                  );
                }}
                onRemove={() => {
                  void run(
                    { kind: "remove", target: event.id },
                    () => removeEventSeries(event.id),
                    "events.manage.removed",
                  );
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-4 border-t border-line pt-4"
        onSubmit={onAdd}
      >
        <h3 className="text-label text-ink-muted uppercase">
          {t("events.manage.addTitle")}
        </h3>

        <EventSeriesFields
          draft={draft}
          onChange={setDraft}
          disabled={busy}
          scope="new"
        />

        <div>
          <button
            type="submit"
            // Gated on the same answer the payload is built from, so the button
            // and the request agree about what a finished form is.
            disabled={inputOf(draft) === null || busy}
            className={PRIMARY_BUTTON}
          >
            {running?.kind === "add"
              ? t("events.manage.adding")
              : t("events.manage.add")}
          </button>
        </div>

        <p className={HINT}>{t("events.manage.addHint")}</p>
      </form>
    </Panel>
  );
}

/**
 * One series, with everything the board can do to it.
 *
 * A save per series rather than a save for the panel, because these are separate
 * decisions about separate things: correcting the sauna evening's location has
 * nothing to do with the cleaning days, and one button for both would make every
 * visit to this card a write to every series on it.
 */
function SeriesCard({
  series,
  busy,
  running,
  onSave,
  onPublish,
  onCallOff,
  onReinstate,
  onRemove,
}: {
  series: EventSeries;
  /** True while any act on the panel is in flight. */
  busy: boolean;
  /** The act in flight, so this card can say which of its own is running. */
  running: Running | null;
  onSave: (values: EventSeriesInput) => void;
  onPublish: (published: boolean, visibility: EventVisibility) => void;
  onCallOff: (occurrenceId: string) => void;
  onReinstate: (occurrenceId: string) => void;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<EventDraft>(() => draftOf(series));
  const [visibility, setVisibility] = useState<EventVisibility>(
    series.visibility,
  );

  const mine = (kind: Running["kind"]): boolean =>
    running?.kind === kind && running.target === series.id;

  const values = inputOf(draft);

  return (
    <article className="flex flex-col gap-4 rounded-control border border-line bg-page px-3 py-3">
      <header className="flex flex-wrap items-center gap-3">
        <h4 className="text-body font-semibold">{series.title}</h4>
        <span className="text-chip text-ink-muted uppercase">
          {series.published
            ? t(
                series.visibility === "PUBLIC"
                  ? "events.manage.publishedPublic"
                  : "events.manage.publishedMember",
              )
            : t("events.manage.draft")}
        </span>
        {/* The whole series, from the server's own count. The list below shows
            the period on screen, and a card saying "3 dates" over three of a
            year's twelve cleaning days would be a card that lied about the
            series the form beside it edits. */}
        <span className="font-data text-data text-ink-muted">
          {t("events.manage.occurrenceCount", {
            count: series.occurrenceCount,
          })}
        </span>
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (values !== null) {
            onSave(values);
          }
        }}
      >
        <EventSeriesFields
          draft={draft}
          onChange={setDraft}
          disabled={busy}
          scope={series.id}
        />

        {/* Said before the refusal has to say it. An edit that would move or
            remove a date somebody has signed up to is refused whole, and the
            board's answer is to deal with those dates first - which is what the
            list below is for. Stated without naming any: which dates have
            sign-ups is not in this answer, and inventing a number here would be
            worse than saying nothing. */}
        <p className={HINT}>{t("events.manage.editLocked")}</p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={values === null || busy}
            className={SECONDARY_BUTTON}
          >
            {mine("save") ? t("events.manage.saving") : t("events.manage.save")}
          </button>

          <button
            type="button"
            disabled={busy}
            // The name carries the series, because every card offers the same
            // act and "remove" on its own does not say which one goes.
            aria-label={t("events.manage.removeNamed", { title: series.title })}
            onClick={() => {
              /*
               * Confirmed, because a series and every date in it go together and
               * nothing here puts one back. Refused outright while anybody has
               * signed up to one of those dates, which is the server's answer
               * rather than this dialogue's.
               */
              if (
                window.confirm(
                  t("events.manage.removeConfirm", { title: series.title }),
                )
              ) {
                onRemove();
              }
            }}
            className={`${QUIET_BUTTON} ml-auto`}
          >
            {mine("remove")
              ? t("events.manage.removing")
              : t("events.manage.remove")}
          </button>
        </div>
      </form>

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <label className={LABEL}>
          {t("events.manage.audienceField")}
          <select
            name={`eventVisibility-${series.id}`}
            value={visibility}
            disabled={busy}
            onChange={(event) => {
              setVisibility(event.target.value as EventVisibility);
            }}
            className={FIELD}
          >
            {VISIBILITIES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(VISIBILITY_LABEL[candidate])}
              </option>
            ))}
          </select>
        </label>

        <p className={HINT}>{t("events.manage.audienceHint")}</p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            aria-label={t("events.manage.publishNamed", {
              title: series.title,
            })}
            onClick={() => {
              onPublish(true, visibility);
            }}
            className={PRIMARY_BUTTON}
          >
            {mine("publish")
              ? t("events.manage.publishing")
              : t("events.manage.publish")}
          </button>

          {/* Offered only while there is something to take down. */}
          {series.published ? (
            <button
              type="button"
              disabled={busy}
              aria-label={t("events.manage.takeDownNamed", {
                title: series.title,
              })}
              onClick={() => {
                onPublish(false, visibility);
              }}
              className={QUIET_BUTTON}
            >
              {t("events.manage.takeDown")}
            </button>
          ) : null}
        </div>
      </div>

      <OccurrenceList
        occurrences={series.occurrences}
        signupOpen={series.signupOpen}
        busy={busy}
        callingOff={running?.kind === "callOff" ? running.target : null}
        reinstating={running?.kind === "reinstate" ? running.target : null}
        onCallOff={onCallOff}
        onReinstate={onReinstate}
      />
    </article>
  );
}

/**
 * The dates of one series that fall in the period, and the acts each offers.
 *
 * Called-off dates stay on the list, drawn dashed and with their own word: the
 * row is the record that the date was arranged and then called off, and hiding it
 * would say there had never been one. It carries no call-off control, because
 * there is nothing left to call off - and it carries the way back instead, since
 * a board that called off the wrong date has nothing else to reach for. Removing
 * the series is refused while anybody has signed up to one of its dates.
 *
 * Reinstating is offered on a called-off date that is still ahead. Once the date
 * has passed there is nothing to put back: it did not happen, and the server
 * refuses saying afterwards that it did.
 *
 * These are the dates in the period the panel is showing, which is why the
 * heading says so. The card above states how many the series has altogether.
 *
 * Who is coming is read only when it is opened. One series can hold a hundred
 * dates, and reading every roll-call to draw this list would be reading a year
 * of residents' names for a screen that asked about one date.
 */
function OccurrenceList({
  occurrences,
  signupOpen,
  busy,
  callingOff,
  reinstating,
  onCallOff,
  onReinstate,
}: {
  occurrences: readonly EventOccurrence[];
  /** Whether the series takes sign-ups, and so has a roll-call at all. */
  signupOpen: boolean;
  busy: boolean;
  /** The date the call-off in flight is for, or null. */
  callingOff: string | null;
  /** The date the reinstatement in flight is for, or null. */
  reinstating: string | null;
  onCallOff: (occurrenceId: string) => void;
  onReinstate: (occurrenceId: string) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [openRollCall, setOpenRollCall] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h5 className="text-label text-ink-muted uppercase">
        {t("events.manage.datesHeading")}
      </h5>

      <p className={HINT}>{t("events.manage.datesHint")}</p>

      <ul className="flex flex-col gap-2">
        {occurrences.map((occurrence) => {
          const calledOff = occurrence.cancelledAt !== null;
          const date = formatEventDay(occurrence.on, i18n.language);

          return (
            <li key={occurrence.id} className="flex flex-col gap-2">
              <div
                className={[
                  "flex flex-wrap items-center gap-3 rounded-control border bg-raised px-3 py-2.5 text-small",
                  calledOff ? "border-dashed border-line" : "border-line",
                ].join(" ")}
              >
                <span className="font-data text-data">
                  <time dateTime={occurrence.on}>{date}</time>{" "}
                  <time dateTime={occurrence.startsAt}>
                    {formatTimeOfDay(occurrence.startsAt, i18n.language)}
                  </time>{" "}
                  {t("events.until")}{" "}
                  <time dateTime={occurrence.endsAt}>
                    {formatTimeOfDay(occurrence.endsAt, i18n.language)}
                  </time>
                </span>

                {calledOff ? (
                  <span className="text-chip text-ink-muted uppercase">
                    {t("events.manage.dateCalledOff")}
                  </span>
                ) : null}

                {signupOpen ? (
                  <button
                    type="button"
                    aria-expanded={openRollCall === occurrence.id}
                    aria-label={t("events.manage.rollCallNamed", { date })}
                    onClick={() => {
                      setOpenRollCall((current) =>
                        current === occurrence.id ? null : occurrence.id,
                      );
                    }}
                    className={QUIET_BUTTON}
                  >
                    {t("events.manage.rollCall")}
                  </button>
                ) : null}

                {calledOff ? (
                  /* Offered only while the date is still ahead. A called-off
                     date the clock has passed did not happen, and the server
                     refuses reinstating it, so a control here would be one that
                     only ever produced a refusal. The comparison is the
                     server's: the row says whether the date has begun. */
                  occurrence.begun ? null : (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t("events.manage.reinstateNamed", { date })}
                      onClick={() => {
                        onReinstate(occurrence.id);
                      }}
                      className={`${QUIET_BUTTON} ml-auto`}
                    >
                      {reinstating === occurrence.id
                        ? t("events.manage.reinstating")
                        : t("events.manage.reinstate")}
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    // The name carries the date, because every row offers the
                    // same act and "call off" on its own does not say which
                    // date is about to go.
                    aria-label={t("events.manage.callOffNamed", { date })}
                    onClick={() => {
                      onCallOff(occurrence.id);
                    }}
                    className={`${QUIET_BUTTON} ml-auto`}
                  >
                    {callingOff === occurrence.id
                      ? t("events.manage.callingOff")
                      : t("events.manage.callOff")}
                  </button>
                )}
              </div>

              {openRollCall === occurrence.id ? (
                <EventRollCall occurrenceId={occurrence.id} />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
