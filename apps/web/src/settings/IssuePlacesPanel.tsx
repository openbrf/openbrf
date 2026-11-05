import { ISSUE_FIT_LIMITS } from "@openbrf/shared";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type ConfiguredIssuePlace,
  createIssuePlace,
  fetchConfiguredPlaces,
  type IssuePlaceInput,
  removeIssuePlace,
  updateIssuePlace,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessage, useSaveAction } from "../ui/save-state";

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  "place-not-found": "settings.issuePlaces.errors.notFound",
  "place-name-taken": "settings.issuePlaces.errors.nameTaken",
  "place-name-apartment": "settings.issuePlaces.errors.nameApartment",
  "place-in-use": "settings.issuePlaces.errors.inUse",
  "too-many-places": "settings.issuePlaces.errors.tooMany",
};

const FIELD_LABELS: Readonly<Record<string, TranslationKey>> = {
  name: "settings.issuePlaces.nameLabel",
};

/** One finished read, and which read it answers for (see `IssueTypesPanel`). */
interface Loaded {
  readonly read: number;
  /** Kept through a read that fails, so the board still has its list. */
  readonly places: readonly ConfiguredIssuePlace[] | null;
  readonly failed: boolean;
}

/** One write on the list, so the panel has one in flight at a time. */
type Act =
  | { kind: "create"; values: IssuePlaceInput }
  | { kind: "update"; id: string; values: IssuePlaceInput }
  | { kind: "remove"; id: string };

function perform(act: Act) {
  switch (act.kind) {
    case "create":
      return createIssuePlace(act.values);
    case "update":
      return updateIssuePlace({ id: act.id, values: act.values });
    case "remove":
      return removeIssuePlace(act.id);
  }
}

/**
 * The association's common-area places (decision 30): a short list such as
 * laundry room, lift and yard, offered beside the free-text location on a
 * report so a repeat fault in one place can be counted.
 *
 * The board's own words, under issues:configure. Never apartments: an issue
 * about a home has its apartment, and a list of homes would enumerate the
 * building to everyone who reports. A place an issue names is switched off and
 * not removed, so the count survives the board tidying its list.
 */
export function IssuePlacesPanel(): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reads, setReads] = useState(0);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let active = true;
    void fetchConfiguredPlaces().then((result) => {
      if (!active) {
        return;
      }
      setLoaded((previous) => ({
        read: reads,
        places: result.ok ? result.value : (previous?.places ?? null),
        failed: !result.ok,
      }));
    });
    return () => {
      active = false;
    };
  }, [reads]);

  const save = useSaveAction(
    perform,
    (_value: unknown) => {
      setReads((count) => count + 1);
    },
    () => {
      // A refusal may be about a list that changed elsewhere.
      setReads((count) => count + 1);
    },
  );
  const busy = save.pending;
  const places = loaded?.places ?? null;
  const readFailed = loaded !== null && loaded.read === reads && loaded.failed;
  const onDraftChanged = (): void => {
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  return (
    <Panel
      title={t("settings.issuePlaces.title")}
      description={t("settings.issuePlaces.description")}
    >
      <div className="flex flex-col gap-4">
        {save.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {failureMessage(
              t,
              save.state.failure,
              FAILURES,
              "settings.issuePlaces.errors.unknown",
              FIELD_LABELS,
            )}
          </Notice>
        ) : null}
        {readFailed ? (
          <LoadFailure
            messageKey="settings.issuePlaces.loadFailed"
            onRetry={() => {
              setReads((count) => count + 1);
            }}
          />
        ) : null}

        {places === null ? (
          readFailed ? null : (
            <p role="status" className={HINT}>
              {t("settings.issuePlaces.loading")}
            </p>
          )
        ) : places.length === 0 ? (
          <p className={HINT}>{t("settings.issuePlaces.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {places.map((place) => (
              <li key={`${place.id}:${place.name}:${String(place.active)}`}>
                <PlaceForm
                  place={place}
                  disabled={busy}
                  onDraftChanged={onDraftChanged}
                  onSave={(values) => {
                    void save.submit({
                      kind: "update",
                      id: place.id,
                      values: { ...values, sortOrder: place.sortOrder },
                    });
                  }}
                  onRemove={() => {
                    void save.submit({ kind: "remove", id: place.id });
                  }}
                />
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex flex-wrap items-end gap-2 border-t border-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() === "") {
              return;
            }
            void save
              .submit({ kind: "create", values: { name: draft.trim() } })
              .then((saved) => {
                if (saved) {
                  setDraft("");
                }
              });
          }}
        >
          <label className={`${LABEL} min-w-56`}>
            {t("settings.issuePlaces.addLabel")}
            <input
              type="text"
              autoComplete="off"
              maxLength={ISSUE_FIT_LIMITS.placeName}
              value={draft}
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value);
                onDraftChanged();
              }}
              className={FIELD}
            />
          </label>
          <button
            type="submit"
            disabled={busy || draft.trim() === ""}
            className={PRIMARY_BUTTON}
          >
            {t("settings.issuePlaces.add")}
          </button>
        </form>
        <p className={HINT}>{t("settings.issuePlaces.neverApartments")}</p>
      </div>
    </Panel>
  );
}

/** One place, with its save offered only for a real change. */
function PlaceForm({
  place,
  disabled,
  onDraftChanged,
  onSave,
  onRemove,
}: {
  place: ConfiguredIssuePlace;
  disabled: boolean;
  onDraftChanged: () => void;
  onSave: (values: IssuePlaceInput) => void;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(place.name);
  const [active, setActive] = useState(place.active);
  const changed = name.trim() !== place.name || active !== place.active;
  const blank = name.trim() === "";
  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-control border border-line px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !blank) {
          onSave({ name: name.trim(), active });
        }
      }}
    >
      <label className={`${LABEL} min-w-56`}>
        {t("settings.issuePlaces.nameLabel")}
        <input
          type="text"
          autoComplete="off"
          maxLength={ISSUE_FIT_LIMITS.placeName}
          value={name}
          disabled={disabled}
          aria-label={t("settings.issuePlaces.nameNamed", {
            name: place.name,
          })}
          onChange={(event) => {
            setName(event.target.value);
            onDraftChanged();
          }}
          className={FIELD}
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-small">
        <input
          type="checkbox"
          checked={active}
          disabled={disabled}
          aria-label={t("settings.issuePlaces.activeNamed", {
            name: place.name,
          })}
          onChange={(event) => {
            setActive(event.target.checked);
            onDraftChanged();
          }}
          className="size-4"
        />
        {t("settings.issuePlaces.active")}
      </label>
      <span className="font-data text-data text-ink-muted">
        {t("settings.issuePlaces.issueCount", { count: place.issueCount })}
      </span>
      <button
        type="submit"
        disabled={disabled || !changed || blank}
        className={SECONDARY_BUTTON}
      >
        {t("settings.issuePlaces.save")}
      </button>
      {place.issueCount === 0 ? (
        <button
          type="button"
          disabled={disabled}
          className={QUIET_BUTTON}
          aria-label={t("settings.issuePlaces.removeNamed", {
            name: place.name,
          })}
          onClick={onRemove}
        >
          {t("settings.issuePlaces.remove")}
        </button>
      ) : null}
    </form>
  );
}
