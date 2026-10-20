import { ASSOCIATION_TIME_ZONE } from "@openbrf/shared";
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import {
  type AssociationFacts,
  type AssociationFactsInput,
  confirmAssociationFacts,
  fetchAssociationFacts,
  saveAssociationFacts,
  saveStaleAfterMonths,
} from "./site-facts-api";

/**
 * The facts a broker asks the board about the association.
 *
 * One form, every field optional, and that is the point rather than laxity: a
 * board fills this in over several meetings, and a form that refused to save
 * until it was complete would be a form nobody finished. A question left
 * unanswered is left off the public page altogether, which is said on the
 * screen so the board knows what an empty field does.
 *
 * The notice about the page being public is standing rather than an outcome.
 * Everything typed here is published at an address anybody can open, and the
 * server refuses a personal identity number the same way it refuses one on a
 * page - but a refusal after the fact is worse than a sentence before it, and
 * the board member pasting a paragraph out of an email is the person the
 * sentence is for.
 *
 * The two yes-or-no facts are three-way selects, not checkboxes. A checkbox
 * cannot say "the board has not decided", and an unticked box that publishes
 * "the association does not accept legal persons" would put an answer on the
 * page that nobody gave.
 *
 * The public page says when the board last confirmed its answers, and so does
 * this screen, beside a way to confirm them without changing anything. A save
 * confirms too. The confirmation is offered only over facts that are recorded
 * and only while the form holds nothing unsaved: it confirms what the server
 * holds, and a board member looking at an edit they have not saved would
 * otherwise be confirming text that is not on the page.
 *
 * Below it, how many months the facts count as current after a confirmation.
 * A form of its own with a save of its own, because saving the facts confirms
 * them and changing this must not.
 *
 * One write at a time, across both forms. Each submission clears the other
 * actions' outcomes so the screen says what happened last, and clearing one
 * still in flight would take its "saving" off the screen while its answer was
 * still to come; and a second save of the same form could be answered before
 * the first, whose answer would then land over it. So every button is held
 * back, and every submission refused, while any of the three is pending.
 */

/** The form's own state: every value a string, as a form field holds it. */
type FactsForm = Record<TextField, string> & {
  buildYear: string;
  siteLeasehold: FlagValue;
  legalPersonOwners: FlagValue;
};

type TextField =
  | "propertyDesignation"
  | "siteLeaseholdNote"
  | "feePolicy"
  | "feeIncludes"
  | "transferFeePolicy"
  | "pledgeFeePolicy"
  | "legalPersonOwnersNote"
  | "parking"
  | "storage"
  | "renovations";

/** "" is "the board has not said", and is stored as such. */
type FlagValue = "" | "true" | "false";

/** Mirrors the bounds the API enforces, so the form refuses the same values. */
const MIN_YEAR = 1000;
const MAX_YEAR = 2200;
const MIN_STALE_AFTER = 1;
const MAX_STALE_AFTER = 12;

const EMPTY: FactsForm = {
  propertyDesignation: "",
  buildYear: "",
  siteLeasehold: "",
  siteLeaseholdNote: "",
  feePolicy: "",
  feeIncludes: "",
  transferFeePolicy: "",
  pledgeFeePolicy: "",
  legalPersonOwners: "",
  legalPersonOwnersNote: "",
  parking: "",
  storage: "",
  renovations: "",
};

function toForm(facts: AssociationFacts): FactsForm {
  return {
    propertyDesignation: facts.propertyDesignation ?? "",
    buildYear: facts.buildYear === null ? "" : String(facts.buildYear),
    siteLeasehold: flagValue(facts.siteLeasehold),
    siteLeaseholdNote: facts.siteLeaseholdNote ?? "",
    feePolicy: facts.feePolicy ?? "",
    feeIncludes: facts.feeIncludes ?? "",
    transferFeePolicy: facts.transferFeePolicy ?? "",
    pledgeFeePolicy: facts.pledgeFeePolicy ?? "",
    legalPersonOwners: flagValue(facts.legalPersonOwners),
    legalPersonOwnersNote: facts.legalPersonOwnersNote ?? "",
    parking: facts.parking ?? "",
    storage: facts.storage ?? "",
    renovations: facts.renovations ?? "",
  };
}

function flagValue(flag: boolean | null): FlagValue {
  return flag === null ? "" : flag ? "true" : "false";
}

function toInput(form: FactsForm): AssociationFactsInput {
  return {
    propertyDesignation: form.propertyDesignation,
    buildYear: form.buildYear === "" ? null : Number(form.buildYear),
    siteLeasehold: flagOf(form.siteLeasehold),
    siteLeaseholdNote: form.siteLeaseholdNote,
    feePolicy: form.feePolicy,
    feeIncludes: form.feeIncludes,
    transferFeePolicy: form.transferFeePolicy,
    pledgeFeePolicy: form.pledgeFeePolicy,
    legalPersonOwners: flagOf(form.legalPersonOwners),
    legalPersonOwnersNote: form.legalPersonOwnersNote,
    parking: form.parking,
    storage: form.storage,
    renovations: form.renovations,
  };
}

function flagOf(value: FlagValue): boolean | null {
  return value === "" ? null : value === "true";
}

/**
 * The fields that differ from what was read, and only those.
 *
 * The server leaves an absent field alone and clears one sent empty, so a
 * save that carried every field would clear whatever the form did not hold -
 * the whole page, when the form was sent before the read had filled it.
 */
function changedInput(
  form: FactsForm,
  stored: FactsForm,
): AssociationFactsInput {
  const full = toInput(form);
  const changed: AssociationFactsInput = {};
  for (const field of Object.keys(EMPTY) as (keyof FactsForm)[]) {
    if (form[field] !== stored[field]) {
      copyField(changed, full, field);
    }
  }
  return changed;
}

/** A day, as the board reads one: in the association's own zone. */
function formatConfirmedDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: ASSOCIATION_TIME_ZONE,
  }).format(new Date(iso));
}

function copyField<K extends keyof AssociationFactsInput>(
  to: AssociationFactsInput,
  from: AssociationFactsInput,
  field: K,
): void {
  to[field] = from[field];
}

export function AssociationFactsPanel(): ReactElement {
  const { t, i18n } = useTranslation();
  // What was read, null until the read has succeeded; and what the board has
  // typed over it, field by field.
  const [stored, setStored] = useState<FactsForm | null>(null);
  // When the board last saved or confirmed the facts; null while none exist.
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<FactsForm>>({});
  // The threshold as read, null until the read has succeeded; and what the
  // board has typed over it, null until it types.
  const [storedStaleAfter, setStoredStaleAfter] = useState<number | null>(null);
  const [staleAfterDraft, setStaleAfterDraft] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const form: FactsForm = { ...(stored ?? EMPTY), ...draft };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchAssociationFacts();
      if (cancelled) {
        return;
      }
      setLoadFailed(!result.ok);
      if (result.ok) {
        /*
         * The fields are interactive from the first render, so a board member
         * who started typing while this read was in flight keeps what they
         * typed: the draft lies over what was read, and the fields nobody
         * touched fill in underneath it.
         */
        setStored(toForm(result.value));
        setConfirmedAt(result.value.confirmedAt);
        setStoredStaleAfter(result.value.staleAfterMonths);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const save = useSaveAction(saveAssociationFacts, (saved) => {
    setStored(toForm(saved));
    setConfirmedAt(saved.confirmedAt);
  });

  const confirm = useSaveAction(confirmAssociationFacts, (confirmed) => {
    setConfirmedAt(confirmed.confirmedAt);
  });

  const staleAfter = useSaveAction(saveStaleAfterMonths, (saved) => {
    setStoredStaleAfter(saved.staleAfterMonths);
    // Only the draft that was saved. The field stays editable while the save
    // is out, and a number typed over it since is the board's next answer,
    // not one this response settles.
    setStaleAfterDraft((current) =>
      current === null || Number(current) === saved.staleAfterMonths
        ? null
        : current,
    );
  });

  const unsaved =
    stored !== null && Object.keys(changedInput(form, stored)).length > 0;
  const busy = save.pending || confirm.pending || staleAfter.pending;

  const year = Number.parseInt(form.buildYear, 10);
  const yearOutOfRange =
    form.buildYear !== "" &&
    (Number.isNaN(year) || year < MIN_YEAR || year > MAX_YEAR);

  const staleAfterValue =
    staleAfterDraft ??
    (storedStaleAfter === null ? "" : String(storedStaleAfter));
  const staleAfterMonths = Number(staleAfterValue);
  const staleAfterOutOfRange =
    staleAfterValue !== "" &&
    (!Number.isInteger(staleAfterMonths) ||
      staleAfterMonths < MIN_STALE_AFTER ||
      staleAfterMonths > MAX_STALE_AFTER);

  const set = (field: keyof FactsForm, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (stored === null || yearOutOfRange || busy) {
      return;
    }
    // One outcome on the screen at a time: the save's says what happened last.
    confirm.reset();
    staleAfter.reset();
    void save.submit(changedInput(form, stored));
  };

  const onConfirm = (): void => {
    if (busy) {
      return;
    }
    save.reset();
    staleAfter.reset();
    void confirm.submit();
  };

  const onStaleAfterSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      storedStaleAfter === null ||
      staleAfterValue === "" ||
      staleAfterOutOfRange ||
      busy
    ) {
      return;
    }
    save.reset();
    confirm.reset();
    void staleAfter.submit(staleAfterMonths);
  };

  const text = (
    field: TextField,
    rows: number,
    hintKey?: TranslationKey,
  ): ReactElement => (
    <label className={LABEL}>
      {t(`siteAdmin.facts.fields.${field}`)}
      <textarea
        name={field}
        rows={rows}
        value={form[field]}
        onChange={(event) => {
          set(field, event.target.value);
        }}
        className={`${FIELD_MULTILINE}`}
      />
      {hintKey === undefined ? null : (
        <span className={HINT}>{t(hintKey)}</span>
      )}
    </label>
  );

  return (
    <Panel
      title={t("siteAdmin.facts.title")}
      description={t("siteAdmin.facts.description")}
      notice={
        <>
          <Notice tone="warn">{t("siteAdmin.facts.publicNotice")}</Notice>
          {loadFailed ? (
            <Notice tone="danger" live>
              {t("siteAdmin.facts.errors.loadFailed")}
            </Notice>
          ) : null}
          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  {
                    "personal-identity-number":
                      "siteAdmin.facts.errors.personalIdentityNumber",
                  },
                  "settings.errors.unknown",
                ),
              )}
            </Notice>
          ) : save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("settings.saved")}
            </Notice>
          ) : null}
          {confirm.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  confirm.state.failure,
                  {
                    "nothing-recorded":
                      "siteAdmin.facts.errors.nothingRecorded",
                  },
                  "settings.errors.unknown",
                ),
              )}
            </Notice>
          ) : confirm.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("siteAdmin.facts.confirmed")}
            </Notice>
          ) : null}
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        {/*
         * Said once, at the top, rather than under every field: what an empty
         * field does to the public page is the one thing about this form that
         * is not obvious, and repeating it thirteen times would bury it.
         */}
        <p className={HINT}>{t("siteAdmin.facts.unrecordedHint")}</p>

        <label className={LABEL}>
          {t("siteAdmin.facts.fields.propertyDesignation")}
          <input
            type="text"
            name="propertyDesignation"
            value={form.propertyDesignation}
            onChange={(event) => {
              set("propertyDesignation", event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>

        <label className={LABEL}>
          {t("siteAdmin.facts.fields.buildYear")}
          <input
            type="number"
            name="buildYear"
            min={MIN_YEAR}
            max={MAX_YEAR}
            value={form.buildYear}
            onChange={(event) => {
              set("buildYear", event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>

        {yearOutOfRange ? (
          <Notice tone="warn" live>
            {t("siteAdmin.facts.errors.buildYear")}
          </Notice>
        ) : null}

        <label className={LABEL}>
          {t("siteAdmin.facts.fields.land")}
          <select
            name="siteLeasehold"
            value={form.siteLeasehold}
            onChange={(event) => {
              set("siteLeasehold", event.target.value);
            }}
            className={FIELD}
          >
            <option value="">{t("siteAdmin.facts.notRecorded")}</option>
            <option value="true">{t("siteAdmin.facts.land.leasehold")}</option>
            <option value="false">{t("siteAdmin.facts.land.owned")}</option>
          </select>
        </label>

        {text(
          "siteLeaseholdNote",
          2,
          "siteAdmin.facts.fields.siteLeaseholdNoteHint",
        )}
        {text("feePolicy", 3, "siteAdmin.facts.fields.feePolicyHint")}
        {text("feeIncludes", 3)}
        {text(
          "transferFeePolicy",
          2,
          "siteAdmin.facts.fields.transferFeePolicyHint",
        )}
        {text("pledgeFeePolicy", 2)}

        <label className={LABEL}>
          {t("siteAdmin.facts.fields.legalPersonOwners")}
          <select
            name="legalPersonOwners"
            value={form.legalPersonOwners}
            onChange={(event) => {
              set("legalPersonOwners", event.target.value);
            }}
            className={FIELD}
          >
            <option value="">{t("siteAdmin.facts.notRecorded")}</option>
            <option value="true">
              {t("siteAdmin.facts.legalPersons.accepted")}
            </option>
            <option value="false">
              {t("siteAdmin.facts.legalPersons.refused")}
            </option>
          </select>
        </label>

        {text("legalPersonOwnersNote", 2)}
        {text("parking", 2)}
        {text("storage", 2)}
        {text("renovations", 4, "siteAdmin.facts.fields.renovationsHint")}

        <div>
          <button
            type="submit"
            disabled={stored === null || yearOutOfRange || busy}
            className={PRIMARY_BUTTON}
          >
            {save.state.kind === "saving"
              ? t("settings.saving")
              : t("settings.save")}
          </button>
        </div>

        {/*
         * Only once there is something to confirm. Before the first save the
         * page carries no date either, and a button that could only be refused
         * would be the screen asking a question it cannot take an answer to.
         */}
        {confirmedAt === null ? null : (
          <div className="flex flex-col items-start gap-2">
            <p>
              {t("siteAdmin.facts.confirmedOn", {
                date: formatConfirmedDay(confirmedAt, i18n.language),
              })}
            </p>
            <p className={HINT}>{t("siteAdmin.facts.confirmHint")}</p>
            <button
              type="button"
              onClick={onConfirm}
              disabled={unsaved || busy}
              className={SECONDARY_BUTTON}
            >
              {confirm.state.kind === "saving"
                ? t("siteAdmin.facts.confirming")
                : t("siteAdmin.facts.confirm")}
            </button>
          </div>
        )}
      </form>

      <form className="flex flex-col gap-2" onSubmit={onStaleAfterSubmit}>
        <label className={LABEL}>
          {t("siteAdmin.facts.staleAfter.label")}
          <input
            type="number"
            name="staleAfterMonths"
            min={MIN_STALE_AFTER}
            max={MAX_STALE_AFTER}
            step={1}
            required
            value={staleAfterValue}
            aria-invalid={staleAfterOutOfRange}
            onChange={(event) => {
              setStaleAfterDraft(event.target.value);
            }}
            className={FIELD_DATA}
          />
          <span className={HINT}>{t("siteAdmin.facts.staleAfter.hint")}</span>
        </label>

        {staleAfterOutOfRange ? (
          <Notice tone="warn" live>
            {t("siteAdmin.facts.errors.staleAfterMonths")}
          </Notice>
        ) : null}

        {/* Here rather than with the facts' outcomes at the top of the
            panel: this form is at its foot, and an answer a screen away from
            the button is one the board member does not see. */}
        {staleAfter.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                staleAfter.state.failure,
                {
                  "invalid-body": "siteAdmin.facts.errors.staleAfterMonths",
                  "stale-after-months-out-of-range":
                    "siteAdmin.facts.errors.staleAfterMonths",
                },
                "settings.errors.unknown",
              ),
            )}
          </Notice>
        ) : staleAfter.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("settings.saved")}
          </Notice>
        ) : null}

        <div>
          <button
            type="submit"
            disabled={
              storedStaleAfter === null ||
              staleAfterValue === "" ||
              staleAfterOutOfRange ||
              busy
            }
            className={SECONDARY_BUTTON}
          >
            {/* Not a second "Spara": the facts' own save sits above it, and a
                board member reaching this one by its name alone must not take
                it for that one. */}
            {staleAfter.state.kind === "saving"
              ? t("settings.saving")
              : t("siteAdmin.facts.staleAfter.save")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
