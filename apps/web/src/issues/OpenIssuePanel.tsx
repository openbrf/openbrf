import { ISSUE_REPORT_LIMITS } from "@openbrf/shared";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type IssueTypeView, openIssue } from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import { type PersonOption, PersonSearch } from "../moves/PersonSearch";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
} from "../ui/controls";
import { LockedForm } from "../ui/LockedForm";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessage, useSaveAction } from "../ui/save-state";

const OPEN_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "type-not-found": "issues.open.errors.typeNotFound",
  "resident-not-found": "issues.open.errors.residentNotFound",
  "apartment-not-found": "issues.open.errors.apartmentNotFound",
  "reporter-not-nameable": "issues.open.errors.reporterNotNameable",
};

const FIELD_LABELS: Readonly<Record<string, TranslationKey>> = {
  description: "issues.report.descriptionLabel",
  location: "issues.report.location",
};

interface Draft {
  typeId: string;
  person: PersonOption | null;
  apartmentId: string;
  location: string;
  description: string;
}

const EMPTY: Draft = {
  typeId: "",
  person: null,
  apartmentId: "",
  location: "",
  description: "",
};

/**
 * Opening an issue as a handler (decision 14): one a resident told the board
 * about by telephone or at the door, or an internal issue with no reporter at
 * all. The issue shows that a handler entered it, and which.
 *
 * Under any switched-on type the handler handles, whoever its reporters are:
 * the handler files it, not a form. A resident is named from the address book,
 * so the field is offered only to a handler who reads it; the property
 * manager, who never does (decision 11 of the product decision log), opens
 * internal issues, as ADR 0054 leaves how they would name a resident to the
 * owner.
 */
export function OpenIssuePanel({
  types,
  canNameResident,
  onOpened,
}: {
  /** The types the handler handles, with their statuses. */
  types: readonly IssueTypeView[];
  canNameResident: boolean;
  onOpened: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [opened, setOpened] = useState(false);
  const typeRef = useRef<HTMLSelectElement>(null);
  const offered = types.filter((type) => type.active);

  const open = useSaveAction(openIssue, () => {
    setDraft(EMPTY);
    setOpened(true);
    onOpened();
  });

  const change = (next: Partial<Draft>): void => {
    setDraft({ ...draft, ...next });
    setOpened(false);
    if (open.state.kind === "failed") {
      open.reset();
    }
  };

  const complete = draft.typeId !== "" && draft.description.trim() !== "";
  const apartments = draft.person?.apartments ?? [];

  return (
    <Panel
      title={t("issues.open.title")}
      description={t("issues.open.description")}
      notice={
        open.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {failureMessage(
              t,
              open.state.failure,
              OPEN_FAILURES,
              "issues.open.errors.unknown",
              FIELD_LABELS,
            )}
          </Notice>
        ) : opened ? (
          <Notice tone="ok" live>
            {t("issues.open.opened")}
          </Notice>
        ) : null
      }
    >
      <LockedForm
        locked={open.state.kind === "saving"}
        focusFallback={typeRef}
        className="flex flex-col gap-4"
        onSend={() => {
          if (!complete) {
            return;
          }
          void open.submit({
            typeId: draft.typeId,
            ...(draft.person === null
              ? {}
              : { reporterPersonId: draft.person.personId }),
            ...(draft.person === null || draft.apartmentId === ""
              ? {}
              : { apartmentId: draft.apartmentId }),
            ...(draft.location.trim() === ""
              ? {}
              : { location: draft.location.trim() }),
            description: draft.description.trim(),
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("issues.report.type")}
            <select
              ref={typeRef}
              required
              value={draft.typeId}
              onChange={(event) => {
                change({ typeId: event.target.value });
              }}
              className={FIELD}
            >
              <option value="">{t("issues.report.typePlaceholder")}</option>
              {offered.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>

          <label className={LABEL}>
            {t("issues.report.location")}
            <input
              type="text"
              maxLength={ISSUE_REPORT_LIMITS.location}
              value={draft.location}
              onChange={(event) => {
                change({ location: event.target.value });
              }}
              className={FIELD}
            />
          </label>
        </div>

        {canNameResident ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <PersonSearch
              id="open-issue-resident"
              label={t("issues.open.resident")}
              selected={draft.person}
              onSelect={(person) => {
                change({
                  person,
                  // Their only apartment, when they have one: the common case,
                  // and the one a handler would otherwise pick by hand.
                  apartmentId:
                    person?.apartments?.length === 1
                      ? (person.apartments[0]?.id ?? "")
                      : "",
                });
              }}
            />
            {draft.person === null || apartments.length === 0 ? null : (
              <label className={LABEL}>
                {t("issues.report.apartment")}
                <select
                  value={draft.apartmentId}
                  onChange={(event) => {
                    change({ apartmentId: event.target.value });
                  }}
                  className={FIELD}
                >
                  <option value="">{t("issues.report.apartmentNone")}</option>
                  {apartments.map((apartment) => (
                    <option key={apartment.id} value={apartment.id}>
                      {apartment.number}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : null}
        <p className={HINT}>
          {canNameResident
            ? t("issues.open.residentHint")
            : t("issues.open.internalOnly")}
        </p>

        <label className={LABEL}>
          {t("issues.report.descriptionLabel")}
          <textarea
            required
            rows={4}
            maxLength={ISSUE_REPORT_LIMITS.description}
            value={draft.description}
            onChange={(event) => {
              change({ description: event.target.value });
            }}
            className={FIELD_MULTILINE}
          />
        </label>
        <p className={HINT}>{t("issues.report.sensitiveWarning")}</p>

        <div>
          <button
            type="submit"
            disabled={!complete || open.state.kind === "saving"}
            className={PRIMARY_BUTTON}
          >
            {open.state.kind === "saving"
              ? t("issues.open.opening")
              : t("issues.open.submit")}
          </button>
        </div>
      </LockedForm>
    </Panel>
  );
}
