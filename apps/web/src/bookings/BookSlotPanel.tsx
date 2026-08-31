import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type BookableResourceSummary,
  type BookableSlot,
  type BookingApartment,
  bookSlot,
  fetchBookableSlots,
} from "../api/bookings";
import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
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
import {
  compareLocalDays,
  formatBookingDate,
  formatDayWithWeekday,
  formatTimeOfDay,
  localDayNow,
  shiftLocalDay,
  windowDaysFor,
} from "./booking-calendar";
import { bookingFailureKey } from "./booking-failures";

/**
 * What each slot state says, and how it looks.
 *
 * Colour is never the only signal: every state carries its own word as well as
 * its own border, so a reader who cannot tell the tones apart still reads which
 * state a slot is in. A slot that has gone is dashed, on the same reasoning the
 * register draws a former resident dashed - the shape says "no longer live"
 * without asking anybody to compare two greys.
 *
 * None of these tones is the trust accent. Brass means a position of trust in
 * this interface, and a free laundry hour is not one.
 */
const SLOT_STATE: Readonly<
  Record<BookableSlot["state"], { classes: string; labelKey: TranslationKey }>
> = {
  FREE: {
    classes: "border-line-strong bg-raised text-ink hover:border-ink",
    labelKey: "bookings.slot.free",
  },
  MINE: {
    classes: "border-info bg-info-soft text-ink",
    labelKey: "bookings.slot.mine",
  },
  TAKEN: {
    classes: "border-line bg-sunken text-ink-muted",
    labelKey: "bookings.slot.taken",
  },
  PAST: {
    classes: "border-line border-dashed bg-page text-ink-muted",
    labelKey: "bookings.slot.past",
  },
};

/**
 * A night the reader has put inside the stay they are assembling.
 *
 * A weight rather than a colour, so it does not read as one of the four states
 * above, and its own word beside it. Deliberately not the trust accent, which
 * this interface keeps for positions of trust.
 */
const CHOSEN_NIGHT = "border-ink bg-raised text-ink";

export interface BookSlotPanelProps {
  /** What the house offers, as the server filtered it. Withdrawn ones absent. */
  resources: readonly BookableResourceSummary[];
  /** The apartments this account may book against, from the server. */
  apartments: readonly BookingApartment[];
  /** Called once a booking has been made, so the caller can reload the lists. */
  onBooked: () => void;
}

/** A stay being put together, as the two clicks that make one arrive. */
interface StayDraft {
  /** The first night, as the slot stated its instants. */
  startsAt: string;
  /** The end of the last night, or null while only the first is chosen. */
  endsAt: string | null;
}

/** Everything one calendar read produces, applied in one step. */
interface Calendar {
  /**
   * Which request this answer belongs to: the resource and the window.
   *
   * Carried so the panel can tell an answer about what is on screen from one
   * about the resource or the week that was on screen a moment ago. Staleness is
   * then read during the render rather than cleared by a second state write
   * before the read starts, which would put the grid through a render nobody
   * needs.
   */
  key: string;
  slots: readonly BookableSlot[];
  failure: ApiFailure | null;
}

/**
 * Taking a slot.
 *
 * The calendar this renders is a calendar of free and not free. A slot arrives
 * as FREE, TAKEN, MINE or PAST and carries no identity at all: which apartment
 * holds nine o'clock on Saturday is personal data that the board's own view is
 * gated behind, and there is nothing on this screen for it to be rendered into.
 * TAKEN is the whole of what a neighbour's booking says here.
 *
 * The instants are copied back from the slot rather than assembled from the
 * date and the hour on screen. That is not tidiness: on the two Sundays a year
 * when the clocks move, a wall-clock time is not enough to name an instant, and
 * the server compares what it is sent against the slots it generates.
 *
 * Two of the three modes book in one click, because taking the laundry room at
 * seven is one decision and the button's own name says which one it is. A
 * resource booked by the night takes two, because a stay is a check-in and a
 * check-out and there is no single click that means both.
 */
export function BookSlotPanel({
  resources,
  apartments,
  onBooked,
}: BookSlotPanelProps): ReactElement {
  const { t, i18n } = useTranslation();

  const [resourceId, setResourceId] = useState(resources[0]?.id ?? "");
  const [apartmentId, setApartmentId] = useState(apartments[0]?.id ?? "");
  const [from, setFrom] = useState(() => localDayNow());
  const [answer, setAnswer] = useState<Calendar | null>(null);
  const [stay, setStay] = useState<StayDraft | null>(null);
  /**
   * Which slot the booking in flight is for.
   *
   * One action serves the whole grid, so without this every cell reads the same
   * save state and one click puts "booking" on every hour of the week.
   */
  const [claiming, setClaiming] = useState<string | null>(null);

  const resource = resources.find((candidate) => candidate.id === resourceId);
  const mode = resource?.mode ?? "TIME_SLOTS";
  const windowDays = windowDaysFor(mode);
  const to = shiftLocalDay(from, windowDays - 1);

  const key = `${resourceId}|${from}|${to}`;

  const read = useCallback(async (): Promise<Calendar> => {
    if (resourceId === "") {
      return { key, slots: [], failure: null };
    }
    const result = await fetchBookableSlots({
      resourceId,
      window: { from, to },
    });
    return result.ok
      ? { key, slots: result.value, failure: null }
      : { key, slots: [], failure: result.failure };
  }, [key, resourceId, from, to]);

  useEffect(() => {
    /*
     * The effect owns its own call and drops a response that arrives after the
     * panel is gone rather than applying it to a component nobody is looking
     * at. A response about a resource or a week that has since been changed is
     * dropped by the render below instead, on the key it carries: two reads can
     * be in flight and the older one can land last.
     */
    let active = true;
    void read().then((next) => {
      if (active) {
        setAnswer(next);
      }
    });
    return () => {
      active = false;
    };
  }, [read]);

  const claim = useSaveAction(bookSlot, () => {
    setStay(null);
    void read().then(setAnswer);
    onBooked();
  });

  const busy = claim.state.kind === "saving";
  const noApartment = apartments.length === 0;

  // The answer to the request on screen, or nothing while it is in flight.
  const calendar = answer?.key === key ? answer : null;

  const book = (startsAt: string, endsAt: string | null): void => {
    setClaiming(startsAt);
    void claim.submit({ resourceId, apartmentId, startsAt, endsAt });
  };

  /**
   * Adds a click to the stay being put together.
   *
   * The first free night is the check-in. A later night is the check-out, and
   * clicking on or before the check-in starts again rather than producing a
   * stay that runs backwards - which the server would refuse, but refusing it
   * here leaves the length of the stay as the only thing the form can be wrong
   * about.
   *
   * A stay is also unbroken. Only a free night can be clicked, but the nights
   * between two of them need not be free, and a range covering one somebody
   * else holds is refused whole by a code that names no night - which would
   * leave the reader to work out which night of a fortnight blocked it. Such a
   * click becomes a new check-in instead: the same answer as clicking before
   * the check-in, and said in the same sentence the panel was already showing.
   */
  const pickNight = (slot: BookableSlot): void => {
    setStay((current) => {
      const fresh: StayDraft = { startsAt: slot.startsAt, endsAt: null };
      if (current === null || slot.startsAt <= current.startsAt) {
        return fresh;
      }
      const stay: StayDraft = {
        startsAt: current.startsAt,
        endsAt: slot.endsAt,
      };
      const held = (calendar?.slots ?? []).some(
        (night) => night.state !== "FREE" && withinStay(night, stay),
      );
      return held ? fresh : stay;
    });
  };
  const days = groupByDay(calendar?.slots ?? []);
  const failure =
    claim.state.kind === "failed"
      ? claim.state.failure
      : (calendar?.failure ?? null);
  const limits = [
    resource?.maxBookingsPerWeek == null
      ? null
      : t("bookings.book.quotaWeek", { count: resource.maxBookingsPerWeek }),
    resource?.maxConcurrentBookings == null
      ? null
      : t("bookings.book.quotaConcurrent", {
          count: resource.maxConcurrentBookings,
        }),
  ].filter((sentence): sentence is string => sentence !== null);

  if (resources.length === 0) {
    return (
      <Panel title={t("bookings.book.title")}>
        <Notice tone="info">{t("bookings.book.noResources")}</Notice>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("bookings.book.title")}
      description={t("bookings.book.description")}
      notice={
        failure !== null ? (
          <Notice tone="danger" live>
            {t(bookingFailureKey(failure))}
          </Notice>
        ) : claim.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("bookings.book.booked")}
          </Notice>
        ) : null
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL}>
          {t("bookings.book.resource")}
          <select
            name="bookingResource"
            value={resourceId}
            onChange={(event) => {
              setResourceId(event.target.value);
              setStay(null);
              setFrom(localDayNow());
            }}
            className={FIELD}
          >
            {resources.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>

        {/* Offered only when there is a choice to make. A household holding one
            apartment has nothing to decide, and the server takes the apartment
            from that household's own residencies either way. */}
        {apartments.length > 1 ? (
          <label className={LABEL}>
            {t("bookings.book.apartment")}
            <select
              name="bookingApartment"
              value={apartmentId}
              onChange={(event) => {
                setApartmentId(event.target.value);
              }}
              className={`${FIELD} font-data`}
            >
              {apartments.map((apartment) => (
                <option key={apartment.id} value={apartment.id}>
                  {apartment.address} {apartment.number}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {resource?.description == null ? null : (
        <p className="text-small whitespace-pre-line">{resource.description}</p>
      )}

      {/* The board's rules for this resource, said before a refusal has to say
          them. Each limit appears only when it is set: an unset one is no
          limit, and "no limit" is not a rule worth a sentence. */}
      {limits.length === 0 ? null : <p className={HINT}>{limits.join(" ")}</p>}

      {noApartment ? (
        <Notice tone="info">{t("bookings.book.noApartment")}</Notice>
      ) : null}

      <nav className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button
          type="button"
          className={QUIET_BUTTON}
          // No window before today. A calendar of last week's laundry hours is
          // a page of slots nobody can act on.
          disabled={compareLocalDays(from, localDayNow()) <= 0}
          onClick={() => {
            setFrom((current) => shiftLocalDay(current, -windowDays));
          }}
        >
          {t("bookings.book.earlier")}
        </button>
        <span className="text-small text-ink-muted">
          <time dateTime={from}>
            {formatDayWithWeekday(from, i18n.language)}
          </time>{" "}
          {t("bookings.until")}{" "}
          <time dateTime={to}>{formatDayWithWeekday(to, i18n.language)}</time>
        </span>
        <button
          type="button"
          className={`${QUIET_BUTTON} ml-auto`}
          onClick={() => {
            setFrom((current) => shiftLocalDay(current, windowDays));
          }}
        >
          {t("bookings.book.later")}
        </button>
      </nav>

      {calendar === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("bookings.book.loadingSlots")}
        </p>
      ) : days.length === 0 ? (
        <p className="text-body text-ink-muted">{t("bookings.book.noSlots")}</p>
      ) : mode === "TIME_SLOTS" ? (
        <ul className="flex flex-col gap-3">
          {days.map(([day, hours]) => (
            <li key={day} className="flex flex-col gap-2">
              <h3 className="text-label text-ink-muted uppercase">
                <time dateTime={day}>
                  {formatDayWithWeekday(day, i18n.language)}
                </time>
              </h3>
              <ul className="flex flex-wrap gap-2">
                {hours.map((slot) => (
                  <li key={slot.startsAt}>
                    <SlotButton
                      slot={slot}
                      label={formatTimeOfDay(slot.startsAt, i18n.language)}
                      period={periodLabel(slot, i18n.language)}
                      busy={busy}
                      claiming={claiming === slot.startsAt}
                      unavailable={noApartment}
                      onPick={() => {
                        book(slot.startsAt, null);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {days.map(([day, [slot]]) =>
            slot === undefined ? null : (
              <li key={day}>
                <SlotButton
                  slot={slot}
                  label={formatDayWithWeekday(day, i18n.language)}
                  period={formatDayWithWeekday(day, i18n.language)}
                  busy={busy}
                  claiming={claiming === slot.startsAt}
                  unavailable={noApartment}
                  chosen={
                    mode === "DATE_RANGE" && slot.state === "FREE"
                      ? stay !== null && withinStay(slot, stay)
                      : undefined
                  }
                  onPick={() => {
                    if (mode === "DATE_RANGE") {
                      pickNight(slot);
                      return;
                    }
                    book(slot.startsAt, null);
                  }}
                />
              </li>
            ),
          )}
        </ul>
      )}

      {mode === "DATE_RANGE" && stay !== null ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <p className="text-small">
            {stay.endsAt === null
              ? t("bookings.book.stayNeedsCheckOut", {
                  from: formatBookingDate(stay.startsAt, i18n.language),
                })
              : t("bookings.book.stayChosen", {
                  from: formatBookingDate(stay.startsAt, i18n.language),
                  to: formatBookingDate(stay.endsAt, i18n.language),
                })}
          </p>
          <button
            type="button"
            disabled={stay.endsAt === null || busy || noApartment}
            className={`${PRIMARY_BUTTON} ml-auto`}
            onClick={() => {
              book(stay.startsAt, stay.endsAt);
            }}
          >
            {busy ? t("bookings.book.booking") : t("bookings.book.bookStay")}
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * One slot, as a control or as a statement.
 *
 * A slot somebody else holds, one that has begun and one that is already the
 * reader's own are all rendered as disabled: none of them is an act this panel
 * offers, and a button that always refused would be a worse way to say so. A
 * booking of one's own is cancelled from the my-bookings list, where it is
 * named rather than being one cell of a grid.
 */
function SlotButton({
  slot,
  label,
  period,
  busy,
  claiming,
  unavailable,
  chosen,
  onPick,
}: {
  slot: BookableSlot;
  /** What the cell reads: a time of day, or a date. */
  label: string;
  /** The whole period, for the name a screen reader announces. */
  period: string;
  busy: boolean;
  claiming: boolean;
  /** True when nothing on this panel can be booked at all. */
  unavailable: boolean;
  /**
   * Whether this night is inside the stay being assembled.
   *
   * Undefined wherever nothing toggles, so the control is not announced as a
   * toggle on a screen where nothing does: the two modes where a click is the
   * booking, and any night that cannot be part of a stay at all. A held or
   * passed cell carrying `aria-pressed` would be announced as a toggle button
   * that a screen-reader user then cannot operate, and a value that appeared
   * only once a stay had started would change the announced role halfway
   * through choosing one.
   */
  chosen?: boolean;
  onPick: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const state = SLOT_STATE[slot.state];
  const free = slot.state === "FREE";

  return (
    <button
      type="button"
      disabled={!free || busy || unavailable}
      aria-pressed={chosen}
      aria-label={
        free
          ? t("bookings.slot.action", { period })
          : t("bookings.slot.name", { period, state: t(state.labelKey) })
      }
      onClick={onPick}
      className={[
        "flex min-h-11 min-w-24 flex-col items-start justify-center gap-0.5",
        "rounded-control border px-3 py-2 transition-colors duration-150 ease-out",
        "disabled:cursor-default",
        chosen === true ? CHOSEN_NIGHT : state.classes,
      ].join(" ")}
    >
      <span className="font-data text-data">{label}</span>
      <span className="text-chip uppercase">
        {claiming
          ? t("bookings.book.booking")
          : chosen === true
            ? t("bookings.slot.chosen")
            : t(state.labelKey)}
      </span>
    </button>
  );
}

/**
 * Whether a night falls inside the stay being put together.
 *
 * The instants are compared as the text they arrived as, which is exact for
 * these values and only for these values: each one is an ISO instant in UTC
 * with a fixed number of digits in every field, so the characters sort in the
 * order the instants do. A value carrying an offset, or a field of varying
 * width, would have to be parsed first - and the same holds for the comparison
 * in `pickNight` above.
 */
function withinStay(slot: BookableSlot, stay: StayDraft): boolean {
  if (stay.endsAt === null) {
    return slot.startsAt === stay.startsAt;
  }
  return slot.startsAt >= stay.startsAt && slot.endsAt <= stay.endsAt;
}

/** The period a slot covers, for the name a screen reader announces. */
function periodLabel(slot: BookableSlot, locale: string): string {
  return (
    `${formatDayWithWeekday(slot.day, locale)} ` +
    `${formatTimeOfDay(slot.startsAt, locale)}-` +
    `${formatTimeOfDay(slot.endsAt, locale)}`
  );
}

/**
 * The slots grouped by the day the server said they belong to.
 *
 * The day comes from the answer rather than being worked out here, because
 * which day a slot belongs to is a question about the association's clock and
 * the server has already answered it. The order the API returned is kept.
 */
function groupByDay(
  slots: readonly BookableSlot[],
): readonly [string, BookableSlot[]][] {
  const days = new Map<string, BookableSlot[]>();
  for (const slot of slots) {
    const held = days.get(slot.day);
    if (held === undefined) {
      days.set(slot.day, [slot]);
    } else {
      held.push(slot);
    }
  }
  return [...days];
}
