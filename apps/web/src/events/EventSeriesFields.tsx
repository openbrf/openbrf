import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  EVENT_MAX_DURATION_MINUTES,
  EVENT_MAX_INTERVAL,
  EVENT_MAX_OCCURRENCES,
  EVENT_RECURRENCE_FREQUENCIES,
  type EventRecurrenceFrequency,
} from "../api/events";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, HINT, LABEL } from "../ui/controls";
import type { EventDraft, RecurrenceEnd } from "./event-draft";

const FREQUENCY_LABEL: Readonly<
  Record<EventRecurrenceFrequency, TranslationKey>
> = {
  WEEKLY: "events.manage.frequency.WEEKLY",
  MONTHLY: "events.manage.frequency.MONTHLY",
  ANNUAL: "events.manage.frequency.ANNUAL",
};

const END_LABEL: Readonly<Record<RecurrenceEnd, TranslationKey>> = {
  count: "events.manage.end.count",
  until: "events.manage.end.until",
};

const RECURRENCE_ENDS: readonly RecurrenceEnd[] = ["count", "until"];

/**
 * What a series is described by, in the shape the board has chosen for it.
 *
 * One component for the rows and for the form that adds one, so the two cannot
 * drift into offering different settings for the same thing - which is how a
 * series ends up creatable with a field it cannot then be edited to change.
 *
 * Two groups of fields are present only when they mean something, rather than
 * disabled. A capacity on a series that takes no sign-ups is a number nothing
 * reads, and an interval on a series that happens once is a rule with nothing to
 * repeat: the API stores null for both, so a field on screen would be a setting
 * that reads as though it did something.
 *
 * The rule states exactly one end, which is why the two are a choice and not two
 * fields side by side. A rule carrying both is refused by the server with a
 * reason of its own, and a form that could send it would be offering the board a
 * refusal to discover.
 */
export function EventSeriesFields({
  draft,
  onChange,
  disabled,
  /**
   * Suffixed onto the name of every field, so two of these on one screen do not
   * share one radio group or one autofill heuristic. The add form and each row
   * render the same fields, and a name repeated across them would let a browser
   * treat them as one control.
   */
  scope,
}: {
  draft: EventDraft;
  onChange: (next: EventDraft) => void;
  disabled: boolean;
  scope: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL}>
          {t("events.manage.titleField")}
          <input
            type="text"
            name={`eventTitle-${scope}`}
            autoComplete="off"
            maxLength={200}
            value={draft.title}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, title: event.target.value });
            }}
            className={FIELD}
          />
        </label>

        <label className={LABEL}>
          {t("events.manage.categoryField")}
          <input
            type="text"
            name={`eventCategory-${scope}`}
            autoComplete="off"
            maxLength={60}
            placeholder={t("events.manage.categoryPlaceholder")}
            value={draft.category}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, category: event.target.value });
            }}
            className={FIELD}
          />
        </label>
      </div>

      <label className={LABEL}>
        {t("events.manage.locationField")}
        <input
          type="text"
          name={`eventLocation-${scope}`}
          autoComplete="off"
          maxLength={200}
          value={draft.location}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...draft, location: event.target.value });
          }}
          className={FIELD}
        />
      </label>

      <label className={LABEL}>
        {t("events.manage.descriptionField")}
        <textarea
          name={`eventDescription-${scope}`}
          rows={3}
          maxLength={2000}
          value={draft.description}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...draft, description: event.target.value });
          }}
          className={`${FIELD} py-2`}
        />
        <span className={HINT}>{t("events.manage.freeTextWarning")}</span>
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className={LABEL}>
          {t("events.manage.firstOnField")}
          <input
            type="date"
            name={`eventFirstOn-${scope}`}
            value={draft.firstOn}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, firstOn: event.target.value });
            }}
            className={`${FIELD} font-data`}
          />
        </label>

        <label className={LABEL}>
          {t("events.manage.startsAtField")}
          <input
            type="time"
            name={`eventStartsAt-${scope}`}
            value={draft.startsAt}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, startsAt: event.target.value });
            }}
            className={`${FIELD} font-data`}
          />
        </label>

        <label className={LABEL}>
          {t("events.manage.durationField")}
          <input
            type="number"
            name={`eventDuration-${scope}`}
            inputMode="numeric"
            min={1}
            max={EVENT_MAX_DURATION_MINUTES}
            value={draft.durationMinutes}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, durationMinutes: event.target.value });
            }}
            className={`${FIELD} font-data`}
          />
        </label>

        {/* Said once, beside the three fields it is about: the time of day is
            stated and the instants are the server's, so a cleaning day at ten
            is at ten on the two Sundays a year the clocks move. */}
        <p className={`${HINT} sm:col-span-3`}>
          {t("events.manage.scheduleHint")}
        </p>
      </div>

      <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
        <legend className="text-label text-ink-muted uppercase">
          {t("events.manage.recurrenceLegend")}
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("events.manage.frequencyField")}
            <select
              name={`eventFrequency-${scope}`}
              value={draft.frequency}
              disabled={disabled}
              onChange={(event) => {
                onChange({
                  ...draft,
                  frequency: event.target.value as EventDraft["frequency"],
                });
              }}
              className={FIELD}
            >
              <option value="">{t("events.manage.frequencyOnce")}</option>
              {EVENT_RECURRENCE_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {t(FREQUENCY_LABEL[frequency])}
                </option>
              ))}
            </select>
          </label>

          {draft.frequency === "" ? null : (
            <label className={LABEL}>
              {t("events.manage.intervalField")}
              <input
                type="number"
                name={`eventInterval-${scope}`}
                inputMode="numeric"
                min={1}
                max={EVENT_MAX_INTERVAL}
                value={draft.interval}
                disabled={disabled}
                onChange={(event) => {
                  onChange({ ...draft, interval: event.target.value });
                }}
                className={`${FIELD} font-data`}
              />
            </label>
          )}
        </div>

        {draft.frequency === "" ? null : (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL}>
              {t("events.manage.endField")}
              <select
                name={`eventEnd-${scope}`}
                value={draft.end}
                disabled={disabled}
                onChange={(event) => {
                  onChange({
                    ...draft,
                    end: event.target.value as RecurrenceEnd,
                  });
                }}
                className={FIELD}
              >
                {RECURRENCE_ENDS.map((end) => (
                  <option key={end} value={end}>
                    {t(END_LABEL[end])}
                  </option>
                ))}
              </select>
            </label>

            {draft.end === "count" ? (
              <label className={LABEL}>
                {t("events.manage.countField")}
                <input
                  type="number"
                  name={`eventCount-${scope}`}
                  inputMode="numeric"
                  min={1}
                  max={EVENT_MAX_OCCURRENCES}
                  value={draft.count}
                  disabled={disabled}
                  onChange={(event) => {
                    onChange({ ...draft, count: event.target.value });
                  }}
                  className={`${FIELD} font-data`}
                />
              </label>
            ) : (
              <label className={LABEL}>
                {t("events.manage.untilField")}
                <input
                  type="date"
                  name={`eventUntil-${scope}`}
                  value={draft.until}
                  disabled={disabled}
                  onChange={(event) => {
                    onChange({ ...draft, until: event.target.value });
                  }}
                  className={`${FIELD} font-data`}
                />
              </label>
            )}

            <p className={`${HINT} sm:col-span-2`}>
              {t("events.manage.horizonHint")}
            </p>
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
        <legend className="text-label text-ink-muted uppercase">
          {t("events.manage.signupLegend")}
        </legend>

        <label className="flex min-h-11 items-center gap-2 text-small text-ink">
          <input
            type="checkbox"
            name={`eventSignupOpen-${scope}`}
            checked={draft.signupOpen}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, signupOpen: event.target.checked });
            }}
            className="size-4 accent-trust"
          />
          {t("events.manage.signupOpenField")}
        </label>

        {/* The capacity belongs to the sign-up and appears with it. A series
            that takes no sign-ups stores no capacity, so a field for one would
            be a limit on nothing. */}
        {draft.signupOpen ? (
          <label className={LABEL}>
            {t("events.manage.capacityField")}
            <input
              type="number"
              name={`eventCapacity-${scope}`}
              inputMode="numeric"
              min={1}
              value={draft.capacity}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...draft, capacity: event.target.value });
              }}
              className={`${FIELD} font-data`}
            />
            <span className={HINT}>{t("events.manage.capacityHint")}</span>
          </label>
        ) : null}
      </fieldset>
    </>
  );
}
