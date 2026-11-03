import { CONTRACTOR_LIMITS } from "@openbrf/shared";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import {
  type Contractor,
  type ContractorInput,
  createContractor,
  fetchContractors,
  removeContractor,
  updateContractor,
} from "../api/work-orders";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

const CONTRACTOR_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "contractor-not-found": "settings.contractors.errors.notFound",
  "contractor-incomplete": "settings.contractors.errors.incomplete",
  "invalid-body": "settings.contractors.errors.invalidBody",
};

/** One change to the list, so the three share one save in flight. */
type ContractorAct =
  | { kind: "create"; values: ContractorInput }
  | { kind: "update"; id: string; values: ContractorInput }
  | { kind: "remove"; id: string };

function perform(act: ContractorAct): Promise<ApiResult<unknown>> {
  switch (act.kind) {
    case "create":
      return createContractor(act.values);
    case "update":
      return updateContractor({ id: act.id, values: act.values });
    case "remove":
      return removeContractor(act.id);
  }
}

interface ContractorDraft {
  name: string;
  trade: string;
  phone: string;
  email: string;
  active: boolean;
}

const EMPTY_DRAFT: ContractorDraft = {
  name: "",
  trade: "",
  phone: "",
  email: "",
  active: true,
};

function draftOf(contractor: Contractor): ContractorDraft {
  return {
    name: contractor.name,
    trade: contractor.trade,
    phone: contractor.phone ?? "",
    email: contractor.email ?? "",
    active: contractor.active,
  };
}

function inputOf(draft: ContractorDraft): ContractorInput {
  const optional = (value: string): string | null =>
    value.trim() === "" ? null : value.trim();
  return {
    name: draft.name.trim(),
    trade: draft.trade.trim(),
    phone: optional(draft.phone),
    email: optional(draft.email),
    active: draft.active,
  };
}

/**
 * The association's list of contractors (entreprenör): the firms a handler
 * sends a work order to, with a name, a trade, a telephone number and the
 * address the work order is mailed to.
 *
 * Kept by the board, under the capability the issue types are kept under.
 * A contractor taken off the list leaves what was sent them on the issues,
 * which is why removing is offered however many work orders they received.
 */
export function ContractorsPanel(): ReactElement {
  const { t } = useTranslation();
  const [contractors, setContractors] = useState<Contractor[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [reads, setReads] = useState(0);
  /** A new draft for the add form after every successful add. */
  const [added, setAdded] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchContractors().then((result) => {
      if (!active) {
        return;
      }
      setContractors(result.ok ? result.value : null);
      setReadFailed(!result.ok);
    });
    return () => {
      active = false;
    };
  }, [reads]);

  const save = useSaveAction(
    perform,
    () => {
      setReads((count) => count + 1);
    },
    (failure) => {
      if (failure.reason === "contractor-not-found") {
        setReads((count) => count + 1);
      }
    },
  );
  const busy = save.pending;

  return (
    <Panel
      title={t("settings.contractors.title")}
      description={t("settings.contractors.description")}
      notice={
        save.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                save.state.failure,
                CONTRACTOR_FAILURES,
                "settings.contractors.errors.unknown",
              ),
            )}
          </Notice>
        ) : readFailed ? (
          <Notice tone="danger" live>
            {t("settings.contractors.loadFailed")}
          </Notice>
        ) : null
      }
    >
      {contractors === null ? (
        readFailed ? null : (
          <p role="status" className={HINT}>
            {t("settings.contractors.loading")}
          </p>
        )
      ) : contractors.length === 0 ? (
        <p className={HINT}>{t("settings.contractors.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {contractors.map((contractor) => (
            <li
              key={JSON.stringify(contractor)}
              className="border-b border-line pb-4"
            >
              <ContractorForm
                initial={draftOf(contractor)}
                named={contractor.name}
                disabled={busy}
                submitLabel={t("settings.contractors.save")}
                workOrderCount={contractor.workOrderCount}
                onDraftChanged={() => {
                  if (save.state.kind === "failed") {
                    save.reset();
                  }
                }}
                onSubmit={(draft) => {
                  void save.submit({
                    kind: "update",
                    id: contractor.id,
                    values: inputOf(draft),
                  });
                }}
                onRemove={() => {
                  void save.submit({ kind: "remove", id: contractor.id });
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3 pt-2">
        <h3 className="text-label text-ink-muted uppercase">
          {t("settings.contractors.addTitle")}
        </h3>
        <ContractorForm
          key={added}
          initial={EMPTY_DRAFT}
          named={null}
          disabled={busy}
          submitLabel={t("settings.contractors.add")}
          workOrderCount={null}
          onDraftChanged={() => {
            if (save.state.kind === "failed") {
              save.reset();
            }
          }}
          onSubmit={(draft) => {
            void save
              .submit({ kind: "create", values: inputOf(draft) })
              .then((saved) => {
                if (saved) {
                  setAdded((count) => count + 1);
                }
              });
          }}
          onRemove={null}
        />
      </section>
    </Panel>
  );
}

/**
 * One contractor's fields, for a row on the list or for a new one. Offers to
 * save only a draft that differs from what is stored and names a firm and a
 * trade.
 */
function ContractorForm({
  initial,
  named,
  disabled,
  submitLabel,
  workOrderCount,
  onDraftChanged,
  onSubmit,
  onRemove,
}: {
  initial: ContractorDraft;
  /** The stored name, for the controls' accessible names; null on a new one. */
  named: string | null;
  disabled: boolean;
  submitLabel: string;
  workOrderCount: number | null;
  onDraftChanged: () => void;
  onSubmit: (draft: ContractorDraft) => void;
  onRemove: (() => void) | null;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const complete = draft.name.trim() !== "" && draft.trade.trim() !== "";
  const label = (field: TranslationKey): string =>
    named === null
      ? t(field)
      : t("settings.contractors.fieldNamed", { name: named, field: t(field) });
  const set = (next: Partial<ContractorDraft>): void => {
    setDraft({ ...draft, ...next });
    onDraftChanged();
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && complete) {
          onSubmit(draft);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          {t("settings.contractors.name")}
          <input
            aria-label={label("settings.contractors.name")}
            value={draft.name}
            maxLength={CONTRACTOR_LIMITS.name}
            disabled={disabled}
            onChange={(event) => {
              set({ name: event.target.value });
            }}
            className={FIELD}
          />
        </label>
        <label className={LABEL}>
          {t("settings.contractors.trade")}
          <input
            aria-label={label("settings.contractors.trade")}
            value={draft.trade}
            maxLength={CONTRACTOR_LIMITS.trade}
            placeholder={t("settings.contractors.tradePlaceholder")}
            disabled={disabled}
            onChange={(event) => {
              set({ trade: event.target.value });
            }}
            className={FIELD}
          />
        </label>
        <label className={LABEL}>
          {t("settings.contractors.phone")}
          <input
            type="tel"
            aria-label={label("settings.contractors.phone")}
            value={draft.phone}
            maxLength={CONTRACTOR_LIMITS.phone}
            disabled={disabled}
            onChange={(event) => {
              set({ phone: event.target.value });
            }}
            className={FIELD_DATA}
          />
        </label>
        <label className={LABEL}>
          {t("settings.contractors.email")}
          <input
            type="email"
            aria-label={label("settings.contractors.email")}
            value={draft.email}
            maxLength={CONTRACTOR_LIMITS.email}
            disabled={disabled}
            onChange={(event) => {
              set({ email: event.target.value });
            }}
            className={FIELD_DATA}
          />
        </label>
      </div>
      {named === null ? null : (
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            aria-label={label("settings.contractors.active")}
            checked={draft.active}
            disabled={disabled}
            onChange={(event) => {
              set({ active: event.target.checked });
            }}
            className="size-4"
          />
          {t("settings.contractors.active")}
        </label>
      )}
      {draft.email.trim() === "" ? (
        <p className={HINT}>{t("settings.contractors.noEmailHint")}</p>
      ) : null}
      {workOrderCount === null ? null : (
        <p className={HINT}>
          {t("settings.contractors.workOrderCount", { count: workOrderCount })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={disabled || !changed || !complete}
          className={named === null ? PRIMARY_BUTTON : SECONDARY_BUTTON}
        >
          {submitLabel}
        </button>
        {onRemove === null || named === null ? null : (
          <button
            type="button"
            aria-label={t("settings.contractors.removeNamed", { name: named })}
            disabled={disabled}
            onClick={onRemove}
            className={QUIET_BUTTON}
          >
            {t("settings.contractors.remove")}
          </button>
        )}
      </div>
    </form>
  );
}
