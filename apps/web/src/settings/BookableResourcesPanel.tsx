import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type BookableResource,
  type BookableResourceInput,
  BOOKING_RESOURCE_MODES,
  type BookingResourceMode,
  createBookableResource,
  deactivateBookableResource,
  fetchAllBookableResources,
  updateBookableResource,
} from "../api/bookings";
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
import { failureMessageKey, useSaveAction } from "../ui/save-state";

const MODE_LABEL: Readonly<Record<BookingResourceMode, TranslationKey>> = {
  TIME_SLOTS: "settings.bookableResources.mode.TIME_SLOTS",
  WHOLE_DAY: "settings.bookableResources.mode.WHOLE_DAY",
  DATE_RANGE: "settings.bookableResources.mode.DATE_RANGE",
};

/**
 * Every refusal a resource write can meet, in words a board can act on.
 *
 * The five configuration refusals are distinct on purpose, because they are
 * five different mistakes with five different fixes. "The slot length does not
 * divide the opening hours" and "a resource booked by the day has no slot
 * length" are not the same problem, and one shared "that could not be saved"
 * would leave the board member reading it to guess which of their fields is
 * wrong - which is the whole reason the API refuses at save time rather than
 * letting a resident meet a forty-minute laundry slot months later.
 *
 * A 403 is answered before this map is consulted; see {@link failureMessageKey}.
 */
const RESOURCE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "schedule-required": "settings.bookableResources.errors.scheduleRequired",
  "schedule-not-applicable":
    "settings.bookableResources.errors.scheduleNotApplicable",
  "closes-before-opens": "settings.bookableResources.errors.closesBeforeOpens",
  "slot-does-not-fit": "settings.bookableResources.errors.slotDoesNotFit",
  "quota-not-positive": "settings.bookableResources.errors.quotaNotPositive",
  "resource-not-found": "settings.bookableResources.errors.resourceNotFound",
  "resource-deactivated": "settings.bookableResources.errors.resourceWithdrawn",
  "invalid-body": "settings.bookableResources.errors.unknown",
};

/**
 * The whole day, in minutes.
 *
 * The one value a closing time can hold that a time field cannot express: a
 * resource open until midnight closes at minute 1440, and 00:00 in a browser's
 * time field is minute 0. Read as the end of the day rather than the beginning,
 * which is unambiguous because a resource closing at the minute it opens is
 * refused by the API in any case.
 */
const MINUTES_PER_DAY = 24 * 60;

/** A resource's configuration as the form holds it: text, until it is sent. */
interface Draft {
  name: string;
  description: string;
  mode: BookingResourceMode;
  slotMinutes: string;
  opensAt: string;
  closesAt: string;
  maxConcurrentBookings: string;
  maxBookingsPerWeek: string;
}

const EMPTY: Draft = {
  name: "",
  description: "",
  mode: "TIME_SLOTS",
  slotMinutes: "",
  opensAt: "",
  closesAt: "",
  maxConcurrentBookings: "",
  maxBookingsPerWeek: "",
};

/**
 * The catalogue of bookable resources, as the board keeps it.
 *
 * The board names its own, the way it names its issue types: an association
 * with two laundry rooms, a sauna and a guest apartment does not describe its
 * house the way one with a roof terrace and a workshop does. What is fixed is
 * not the list but the three ways a thing can be booked, which is why the mode
 * is a choice of three and the resource itself is free text.
 *
 * The mode decides which fields exist. A resource booked in time slots carries
 * a slot length and an opening and closing time; one booked by the day or by
 * the night carries none of them, and the fields are absent rather than
 * disabled - a setting that can be changed with no effect is the worst kind
 * there is. The API refuses a slot length on a whole-day resource for the same
 * reason, so a form that kept the fields on screen would be offering something
 * every save would then refuse.
 *
 * Withdrawing is offered and removing is not, because there is no removal at
 * all: the bookings already made against a resource say what they were for only
 * through it, so a board tidying its catalogue in October must not make
 * September's guest-apartment bookings unreadable.
 */
export function BookableResourcesPanel(): ReactElement {
  const { t } = useTranslation();
  const [resources, setResources] = useState<
    readonly BookableResource[] | null
  >(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const read = useCallback(async (): Promise<void> => {
    const result = await fetchAllBookableResources();
    if (result.ok) {
      setResources(result.value);
      setLoadFailed(false);
      return;
    }
    setLoadFailed(true);
  }, []);

  useEffect(() => {
    // The effect owns its own call and drops a response that arrives after the
    // panel is gone. Later reads go through `read`, which the writes below call.
    let active = true;
    void fetchAllBookableResources().then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        setResources(result.value);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const add = useSaveAction(createBookableResource, () => {
    setDraft(EMPTY);
    void read();
  });
  const change = useSaveAction(updateBookableResource, () => {
    void read();
  });
  const withdraw = useSaveAction(deactivateBookableResource, () => {
    void read();
  });

  const failure =
    add.state.kind === "failed"
      ? add.state.failure
      : change.state.kind === "failed"
        ? change.state.failure
        : withdraw.state.kind === "failed"
          ? withdraw.state.failure
          : null;

  const busy =
    add.state.kind === "saving" ||
    change.state.kind === "saving" ||
    withdraw.state.kind === "saving";

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void add.submit(inputOf(draft));
  };

  const offered = (resources ?? []).filter(
    (resource) => resource.deactivatedAt === null,
  );
  const withdrawn = (resources ?? []).filter(
    (resource) => resource.deactivatedAt !== null,
  );

  return (
    <Panel
      title={t("settings.bookableResources.title")}
      description={t("settings.bookableResources.description")}
      notice={
        loadFailed ? (
          <Notice tone="danger" live>
            {t("settings.bookableResources.loadFailed")}
          </Notice>
        ) : failure === null ? null : (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                failure,
                RESOURCE_FAILURES,
                "settings.bookableResources.errors.unknown",
              ),
            )}
          </Notice>
        )
      }
    >
      {resources === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("settings.bookableResources.loading")}
        </p>
      ) : offered.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("settings.bookableResources.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {offered.map((resource) => (
            <li key={resource.id}>
              <ResourceRow
                // Keyed on the stored values, so a reload after a save re-seeds
                // the fields with what is now stored rather than leaving them
                // showing what was typed.
                key={signatureOf(resource)}
                resource={resource}
                busy={busy}
                onSave={(values) => {
                  void change.submit({ id: resource.id, values });
                }}
                onWithdraw={() => {
                  void withdraw.submit(resource.id);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {withdrawn.length === 0 ? null : (
        <section className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="text-label text-ink-muted uppercase">
            {t("settings.bookableResources.withdrawnTitle")}
          </h3>
          <p className={HINT}>
            {t("settings.bookableResources.withdrawnHint")}
          </p>
          <ul className="flex flex-col gap-2">
            {withdrawn.map((resource) => (
              <li
                key={resource.id}
                className="flex flex-wrap items-center gap-3 rounded-control border border-dashed border-line bg-page px-3 py-2.5"
              >
                <span className="text-body font-semibold">{resource.name}</span>
                <span className="text-chip text-ink-muted uppercase">
                  {t(MODE_LABEL[resource.mode])}
                </span>
                <span className="ml-auto font-data text-data text-ink-muted">
                  {t("settings.bookableResources.bookingCount", {
                    count: resource.bookingCount,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form
        className="flex flex-col gap-4 border-t border-line pt-4"
        onSubmit={onSubmit}
      >
        <h3 className="text-label text-ink-muted uppercase">
          {t("settings.bookableResources.addTitle")}
        </h3>

        <ResourceFields draft={draft} onChange={setDraft} disabled={busy} />

        <div>
          <button
            type="submit"
            disabled={draft.name.trim() === "" || busy}
            className={PRIMARY_BUTTON}
          >
            {add.state.kind === "saving"
              ? t("settings.bookableResources.adding")
              : t("settings.bookableResources.add")}
          </button>
        </div>
      </form>
    </Panel>
  );
}

/**
 * One resource the house currently offers, with its own fields.
 *
 * A save per resource rather than a save for the panel, because these are
 * separate decisions about separate things: changing the sauna's weekly limit
 * has nothing to do with the guest apartment, and one button for both would
 * make every visit to this card a write to every row on it.
 */
function ResourceRow({
  resource,
  busy,
  onSave,
  onWithdraw,
}: {
  resource: BookableResource;
  busy: boolean;
  onSave: (values: BookableResourceInput) => void;
  onWithdraw: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => draftOf(resource));

  return (
    <form
      className="flex flex-col gap-4 rounded-control border border-line bg-page px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(inputOf(draft));
      }}
    >
      <ResourceFields draft={draft} onChange={setDraft} disabled={busy} />

      {/*
       * What changing the mechanics leaves behind, stated where the mechanics
       * are changed. Narrowing a laundry room's hours does not move the
       * bookings already made: they stay where they are, which can leave one
       * sitting across the new slot boundaries, and the calendar shows those
       * hours as taken rather than pretending they are free. A board deciding
       * this is entitled to know it before the save rather than after.
       */}
      {resource.bookingCount === 0 ? null : (
        <p className={HINT}>
          {t("settings.bookableResources.standingBookings", {
            count: resource.bookingCount,
          })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={draft.name.trim() === "" || busy}
          className={SECONDARY_BUTTON}
        >
          {t("settings.bookableResources.save")}
        </button>

        <span className="font-data text-data text-ink-muted">
          {t("settings.bookableResources.bookingCount", {
            count: resource.bookingCount,
          })}
        </span>

        <button
          type="button"
          disabled={busy}
          // The name carries the resource, because every row offers the same
          // act and "withdraw" on its own does not say which one goes.
          aria-label={t("settings.bookableResources.withdrawNamed", {
            resource: resource.name,
          })}
          onClick={onWithdraw}
          className={`${QUIET_BUTTON} ml-auto`}
        >
          {t("settings.bookableResources.withdraw")}
        </button>
      </div>
    </form>
  );
}

/**
 * The fields a resource is described by, in the shape its mode calls for.
 *
 * One component for the rows and for the add form, so the two cannot drift into
 * offering different settings for the same thing - which is how a resource ends
 * up creatable with a field it cannot then be edited to change.
 */
function ResourceFields({
  draft,
  onChange,
  disabled,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL}>
          {t("settings.bookableResources.name")}
          <input
            type="text"
            name="resourceName"
            autoComplete="off"
            placeholder={t("settings.bookableResources.namePlaceholder")}
            value={draft.name}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, name: event.target.value });
            }}
            className={FIELD}
          />
        </label>

        <label className={LABEL}>
          {t("settings.bookableResources.modeLabel")}
          <select
            name="resourceMode"
            value={draft.mode}
            disabled={disabled}
            onChange={(event) => {
              onChange({
                ...draft,
                mode: event.target.value as BookingResourceMode,
              });
            }}
            className={FIELD}
          >
            {BOOKING_RESOURCE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(MODE_LABEL[mode])}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={LABEL}>
        {t("settings.bookableResources.descriptionLabel")}
        <textarea
          name="resourceDescription"
          rows={2}
          value={draft.description}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...draft, description: event.target.value });
          }}
          className={`${FIELD} py-2`}
        />
        <span className={HINT}>
          {t("settings.bookableResources.descriptionHint")}
        </span>
      </label>

      {/*
       * Present for one mode and absent for the other two, rather than disabled.
       * A resource booked by the day has no slot length, and the API refuses one
       * on it: a field on screen that every save would refuse is a setting that
       * reads as though it did something.
       */}
      {draft.mode === "TIME_SLOTS" ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className={LABEL}>
            {t("settings.bookableResources.slotMinutes")}
            <input
              type="number"
              name="resourceSlotMinutes"
              inputMode="numeric"
              min={1}
              max={MINUTES_PER_DAY}
              value={draft.slotMinutes}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...draft, slotMinutes: event.target.value });
              }}
              className={`${FIELD} font-data`}
            />
          </label>

          <label className={LABEL}>
            {t("settings.bookableResources.opensAt")}
            <input
              type="time"
              name="resourceOpensAt"
              value={draft.opensAt}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...draft, opensAt: event.target.value });
              }}
              className={`${FIELD} font-data`}
            />
          </label>

          <label className={LABEL}>
            {t("settings.bookableResources.closesAt")}
            <input
              type="time"
              name="resourceClosesAt"
              value={draft.closesAt}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...draft, closesAt: event.target.value });
              }}
              className={`${FIELD} font-data`}
            />
          </label>

          <p className={`${HINT} sm:col-span-3`}>
            {t("settings.bookableResources.scheduleHint")}
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL}>
          {t("settings.bookableResources.maxBookingsPerWeek")}
          <input
            type="number"
            name="resourceMaxBookingsPerWeek"
            inputMode="numeric"
            min={1}
            value={draft.maxBookingsPerWeek}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, maxBookingsPerWeek: event.target.value });
            }}
            className={`${FIELD} font-data`}
          />
        </label>

        <label className={LABEL}>
          {t("settings.bookableResources.maxConcurrentBookings")}
          <input
            type="number"
            name="resourceMaxConcurrentBookings"
            inputMode="numeric"
            min={1}
            value={draft.maxConcurrentBookings}
            disabled={disabled}
            onChange={(event) => {
              onChange({
                ...draft,
                maxConcurrentBookings: event.target.value,
              });
            }}
            className={`${FIELD} font-data`}
          />
        </label>

        <p className={`${HINT} sm:col-span-2`}>
          {t("settings.bookableResources.quotaHint")}
        </p>
      </div>
    </>
  );
}

/** The stored configuration, as the form holds it. */
function draftOf(resource: BookableResource): Draft {
  return {
    name: resource.name,
    description: resource.description ?? "",
    mode: resource.mode,
    slotMinutes:
      resource.slotMinutes === null ? "" : String(resource.slotMinutes),
    opensAt: timeValueOf(resource.opensAtMinute),
    closesAt: timeValueOf(resource.closesAtMinute),
    maxConcurrentBookings:
      resource.maxConcurrentBookings === null
        ? ""
        : String(resource.maxConcurrentBookings),
    maxBookingsPerWeek:
      resource.maxBookingsPerWeek === null
        ? ""
        : String(resource.maxBookingsPerWeek),
  };
}

/**
 * What the form sends.
 *
 * Every field the mode does not use is sent as null rather than left out. The
 * API reads a cleared field and an omitted one as the same thing, and it has to
 * be told: a resource changed from time slots to whole days that kept its slot
 * length would be dead configuration, which is exactly what the server refuses.
 */
function inputOf(draft: Draft): BookableResourceInput {
  const slots = draft.mode === "TIME_SLOTS";
  const description = draft.description.trim();
  return {
    name: draft.name.trim(),
    description: description === "" ? null : description,
    mode: draft.mode,
    slotMinutes: slots ? numberOrNull(draft.slotMinutes) : null,
    opensAtMinute: slots ? minuteOf(draft.opensAt, false) : null,
    closesAtMinute: slots ? minuteOf(draft.closesAt, true) : null,
    maxConcurrentBookings: numberOrNull(draft.maxConcurrentBookings),
    maxBookingsPerWeek: numberOrNull(draft.maxBookingsPerWeek),
  };
}

/** A whole number, or nothing when the field is empty or not one. */
function numberOrNull(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * A time field's value as minutes past local midnight.
 *
 * A closing time of 00:00 is the end of the day rather than the beginning; see
 * {@link MINUTES_PER_DAY}. The API bounds these values as well, because a
 * request is not the only way a row is written.
 */
function minuteOf(value: string, closing: boolean): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return closing && minute === 0 ? MINUTES_PER_DAY : minute;
}

/** Minutes past midnight as a time field's value, and the whole day as 00:00. */
function timeValueOf(minute: number | null): string {
  if (minute === null) {
    return "";
  }
  const wrapped = minute % MINUTES_PER_DAY;
  return (
    `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:` +
    `${String(wrapped % 60).padStart(2, "0")}`
  );
}

/** The stored values a row's fields are seeded from, as one string. */
function signatureOf(resource: BookableResource): string {
  return [
    resource.id,
    resource.name,
    resource.description ?? "",
    resource.mode,
    resource.slotMinutes ?? "",
    resource.opensAtMinute ?? "",
    resource.closesAtMinute ?? "",
    resource.maxConcurrentBookings ?? "",
    resource.maxBookingsPerWeek ?? "",
  ].join("|");
}
