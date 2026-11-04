import { ISSUE_REPORT_LIMITS } from "@openbrf/shared";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type IssueTypeView, openIssue } from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
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
import { IssueResidentPicker, type ResidentPick } from "./IssueResidentPicker";

const OPEN_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "type-not-found": "issues.open.errors.typeNotFound",
  "resident-not-found": "issues.open.errors.residentNotFound",
};

const FIELD_LABELS: Readonly<Record<string, TranslationKey>> = {
  description: "issues.report.descriptionLabel",
  location: "issues.report.location",
};

interface Draft {
  typeId: string;
  resident: ResidentPick;
  location: string;
  description: string;
}

const EMPTY: Draft = {
  typeId: "",
  resident: { apartmentId: "", residencyId: "" },
  location: "",
  description: "",
};

/**
 * Opening an issue as a handler (decision 14): one a resident told the board
 * about by telephone or at the door, or an internal issue with no reporter at
 * all. The issue shows that a handler entered it, and which.
 *
 * Under any switched-on type the handler handles, whoever its reporters are:
 * the handler files it, not a form. A resident is named from the resident
 * picker, the apartment and then who lives there today, which every handler
 * gets, the property manager included: it is not the address book, which the
 * property manager never reads (decision 11 of the product decision log, ADR
 * 0054).
 */
export function OpenIssuePanel({
  types,
  onOpened,
}: {
  /** The types the handler handles, with their statuses. */
  types: readonly IssueTypeView[];
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
            ...(draft.resident.residencyId === ""
              ? {}
              : { residencyId: draft.resident.residencyId }),
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

        <IssueResidentPicker
          pick={draft.resident}
          onPick={(resident) => {
            change({ resident });
          }}
        />
        <p className={HINT}>{t("issues.open.residentHint")}</p>

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
        {offered.find((type) => type.id === draft.typeId)?.ringFenced ===
        true ? (
          <Notice tone="warn">{t("issues.ringFence.formWarning")}</Notice>
        ) : (
          <p className={HINT}>{t("issues.report.sensitiveWarning")}</p>
        )}

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
