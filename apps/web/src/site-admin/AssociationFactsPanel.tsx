import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import {
  type AssociationFacts,
  type AssociationFactsInput,
  fetchAssociationFacts,
  saveAssociationFacts,
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
 */

/** The form's own state: every value a string, as a form field holds it. */
type FactsForm = Record<TextField, string> & {
  buildYear: string;
  landLeasehold: FlagValue;
  legalPersonOwners: FlagValue;
};

type TextField =
  | "propertyDesignation"
  | "landLeaseholdNote"
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

const EMPTY: FactsForm = {
  propertyDesignation: "",
  buildYear: "",
  landLeasehold: "",
  landLeaseholdNote: "",
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
    landLeasehold: flagValue(facts.landLeasehold),
    landLeaseholdNote: facts.landLeaseholdNote ?? "",
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
    landLeasehold: flagOf(form.landLeasehold),
    landLeaseholdNote: form.landLeaseholdNote,
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

export function AssociationFactsPanel(): ReactElement {
  const { t } = useTranslation();
  const [form, setForm] = useState<FactsForm>(EMPTY);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchAssociationFacts();
      if (cancelled) {
        return;
      }
      setLoadFailed(!result.ok);
      if (result.ok) {
        setForm(toForm(result.value));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const save = useSaveAction(saveAssociationFacts);

  const year = Number.parseInt(form.buildYear, 10);
  const yearOutOfRange =
    form.buildYear !== "" &&
    (Number.isNaN(year) || year < MIN_YEAR || year > MAX_YEAR);

  const set = (field: keyof FactsForm, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (yearOutOfRange) {
      return;
    }
    void save.submit(toInput(form));
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
        className={`${FIELD} py-2`}
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
            name="landLeasehold"
            value={form.landLeasehold}
            onChange={(event) => {
              set("landLeasehold", event.target.value);
            }}
            className={FIELD}
          >
            <option value="">{t("siteAdmin.facts.notRecorded")}</option>
            <option value="true">{t("siteAdmin.facts.land.leasehold")}</option>
            <option value="false">{t("siteAdmin.facts.land.owned")}</option>
          </select>
        </label>

        {text(
          "landLeaseholdNote",
          2,
          "siteAdmin.facts.fields.landLeaseholdNoteHint",
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
            disabled={yearOutOfRange || save.state.kind === "saving"}
            className={PRIMARY_BUTTON}
          >
            {save.state.kind === "saving"
              ? t("settings.saving")
              : t("settings.save")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
