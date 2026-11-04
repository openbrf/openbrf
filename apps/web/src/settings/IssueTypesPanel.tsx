import {
  ISSUE_HANDLED_BY,
  ISSUE_PRIORITIES,
  ISSUE_REPORTER_GROUPS,
  ISSUE_STATUS_LIMITS,
  ISSUE_STATUS_MEANINGS,
  ISSUE_TYPE_LIMITS,
  type IssueHandledBy,
  type IssuePriority,
  type IssueReporterGroup,
  type IssueStatusMeaning,
} from "@openbrf/shared";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  addIssueStatus,
  changeIssueStatus,
  type ConfiguredIssueType,
  createIssueType,
  fetchIssueTypeHandlers,
  fetchIssueTypes,
  type IssueHandlerChoice,
  type IssueStatusView,
  type IssueTypeInput,
  type IssueTypeView,
  removeIssueType,
  setIssueTypeRingFence,
  updateIssueType,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  ISSUE_HANDLED_BY_LABEL,
  ISSUE_MEANING_LABEL,
  ISSUE_PRIORITY_LABEL,
  ISSUE_REPORTER_GROUP_LABEL,
} from "../issues/issue-labels";
import { issueHandlerName } from "../issues/IssueHandlerName";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { LockedForm } from "../ui/LockedForm";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessage, useSaveAction } from "../ui/save-state";

const TYPE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "type-in-use": "settings.issueTypes.errors.typeInUse",
  "type-not-found": "settings.issueTypes.errors.typeNotFound",
  "status-not-found": "settings.issueTypes.errors.statusNotFound",
  "default-status-required": "settings.issueTypes.errors.defaultStatusRequired",
  "too-many-statuses": "settings.issueTypes.errors.tooManyStatuses",
  "assignee-not-a-handler": "settings.issueTypes.errors.assigneeNotAHandler",
};

const FIELD_LABELS: Readonly<Record<string, TranslationKey>> = {
  name: "settings.issueTypes.name",
  reporters: "settings.issueTypes.reporters",
  label: "settings.issueTypes.statuses.label",
};

/** A new type is offered to the residents until the board says otherwise. */
const EMPTY: { name: string; reporters: readonly IssueReporterGroup[] } = {
  name: "",
  reporters: ["RESIDENTS"],
};

/** The groups with one toggled, in their declared order. */
function toggled(
  groups: readonly IssueReporterGroup[],
  group: IssueReporterGroup,
  on: boolean,
): IssueReporterGroup[] {
  return ISSUE_REPORTER_GROUPS.filter((candidate) =>
    candidate === group ? on : groups.includes(candidate),
  );
}

/**
 * One finished read of the catalogue, and which read it answers for.
 *
 * The outcome travels here rather than in a flag beside the list. A flag would
 * have to be cleared as the next read starts, which is a write the reading
 * effect cannot make, and a notice about a read that is over would otherwise
 * sit above the read that is happening - with no list for it yet and so no
 * loading line under it either: a panel that reads as broken rather than as
 * loading. Held on the record, "did this read fail" is answered by the same
 * comparison that answers "is this the read the panel is on", and cannot fall
 * out of step with it.
 */
interface Loaded {
  /** Which read this answers for. */
  readonly read: number;
  /**
   * Every issue type the catalogue holds, or null while no read has answered
   * at all.
   *
   * Kept through a read that fails: the rows below are what the board acts on,
   * and a refresh that did not land is no reason to take the catalogue off the
   * screen. There is one catalogue, so the last answer about it is the best
   * there is, whichever read produced it.
   */
  readonly types: readonly ConfiguredIssueType[] | null;
  readonly failed: boolean;
}

/** A type's settings as they stand, for a write that changes one of them. */
function settingsOf(type: ConfiguredIssueType): IssueTypeInput {
  return {
    name: type.name,
    reporters: type.reporters,
    active: type.active,
    sortOrder: type.sortOrder,
  };
}

/**
 * The board's catalogue of issue types.
 *
 * Who may report a type is on the row rather than hidden in a submenu, because
 * it decides who is shown what: a type the website's form may report appears on
 * a form anyone can reach, and one for handlers only is the association's own
 * note to itself. A board member changing a name should not be able to move a
 * category between those without seeing it happen.
 *
 * Under each type, its statuses (ADR 0054): the board names them, adds to them
 * and switches them off, and each means one of four fixed things - new, in
 * progress, waiting, done - which is what the queue, the purge and everything
 * else that decides reads. A status is never removed, so the issues that stood
 * in it keep saying where they stood.
 */
export function IssueTypesPanel(): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /**
   * Which read the panel is on.
   *
   * Every write ends in a read of the catalogue, which is a request the effect
   * below cannot tell from the read it has already made. This is how it is
   * told, and it keeps that effect the only thing that reads - so every answer
   * is dropped once the panel is gone or a later read has superseded it.
   */
  const [reads, setReads] = useState(0);
  const [draft, setDraft] = useState(EMPTY);
  const nameRef = useRef<HTMLInputElement>(null);
  /**
   * Who a type's issues may be given to by default, or null until a read has
   * landed: the default-assignee select then offers only the setting as it
   * stands. Read again with the catalogue, so one that failed is retried on the
   * next write, and a failed re-read keeps the choices already on screen.
   */
  const [choices, setChoices] = useState<readonly IssueHandlerChoice[] | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void fetchIssueTypeHandlers().then((result) => {
      if (active && result.ok) {
        setChoices(result.value);
      }
    });
    return () => {
      active = false;
    };
  }, [reads]);

  const reread = (): void => {
    setReads((count) => count + 1);
  };

  useEffect(() => {
    // The effect owns its own call and drops a response that arrives after the
    // panel is gone, or after a later read superseded it, rather than applying
    // it to a component nobody is looking at.
    let active = true;
    void fetchIssueTypes().then((result) => {
      if (!active) {
        return;
      }
      setLoaded((previous) => ({
        read: reads,
        // A read that failed keeps the list already on screen. Read off the
        // state rather than off a variable this closure captured, because a
        // write's re-read settles against whatever is there when it lands.
        types: result.ok ? result.value : (previous?.types ?? null),
        failed: !result.ok,
      }));
    });
    return () => {
      active = false;
    };
  }, [reads]);

  /*
   * What the panel shows: the last list that landed, and the outcome of the
   * read it is on. The list outlives the read that produced it, for the reason
   * {@link Loaded} gives; the outcome does not, because a notice about a read
   * that is over would sit above one that is happening.
   */
  const types = loaded?.types ?? null;
  const settled = loaded !== null && loaded.read === reads ? loaded : null;
  const loadFailed = settled?.failed ?? false;

  const add = useSaveAction(createIssueType, () => {
    setDraft(EMPTY);
    reread();
  });
  const change = useSaveAction(updateIssueType, () => {
    reread();
  });
  const remove = useSaveAction(removeIssueType, () => {
    reread();
  });
  const addStatus = useSaveAction(addIssueStatus, () => {
    reread();
  });
  const changeStatus = useSaveAction(changeIssueStatus, () => {
    reread();
  });
  const fence = useSaveAction(setIssueTypeRingFence, () => {
    reread();
  });

  const actions = [add, change, remove, addStatus, changeStatus, fence];
  const failed = actions.find((action) => action.state.kind === "failed");
  const failure = failed?.state.kind === "failed" ? failed.state.failure : null;
  const busy = actions.some((action) => action.state.kind === "saving");

  const onSend = (): void => {
    void add.submit({
      name: draft.name.trim(),
      reporters: draft.reporters,
      sortOrder: types?.length ?? 0,
    });
  };

  return (
    <Panel
      title={t("settings.issueTypes.title")}
      description={t("settings.issueTypes.description")}
      notice={
        loadFailed ? (
          <Notice tone="danger" live>
            {t("settings.issueTypes.loadFailed")}
          </Notice>
        ) : failure === null ? null : (
          <Notice tone="danger" live>
            {failureMessage(
              t,
              failure,
              TYPE_FAILURES,
              "settings.issueTypes.errors.unknown",
              FIELD_LABELS,
            )}
          </Notice>
        )
      }
    >
      {/*
       * Nothing under a read that failed: the notice above has said the
       * catalogue could not be read, and a loading line under it would go on
       * saying something is still happening when nothing is. Which list a
       * failure keeps, and which read wears the notice at all, are both decided
       * on {@link Loaded} rather than here.
       */}
      {types === null ? (
        loadFailed ? null : (
          <p role="status" className="text-body text-ink-muted">
            {t("settings.issueTypes.loading")}
          </p>
        )
      ) : types.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("settings.issueTypes.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {types.map((type) => (
            <li
              key={type.id}
              className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-page px-3 py-2.5"
            >
              <span className="text-body font-semibold">{type.name}</span>

              <fieldset className="flex flex-wrap items-center gap-3">
                <legend className="sr-only">
                  {t("settings.issueTypes.reporters")}
                </legend>
                {ISSUE_REPORTER_GROUPS.map((group) => {
                  const on = type.reporters.includes(group);
                  return (
                    <label
                      key={group}
                      className="flex min-h-11 items-center gap-2 text-small"
                    >
                      <input
                        type="checkbox"
                        aria-label={t("settings.issueTypes.reporterNamed", {
                          name: type.name,
                          group: t(ISSUE_REPORTER_GROUP_LABEL[group]),
                        })}
                        checked={on}
                        // The last group stays: a type nobody may report is a
                        // switched-off type, and the switch for that is beside.
                        disabled={busy || (on && type.reporters.length === 1)}
                        onChange={(event) => {
                          void change.submit({
                            id: type.id,
                            values: {
                              name: type.name,
                              reporters: toggled(
                                type.reporters,
                                group,
                                event.target.checked,
                              ),
                              active: type.active,
                              sortOrder: type.sortOrder,
                            },
                          });
                        }}
                        className="size-4"
                      />
                      {t(ISSUE_REPORTER_GROUP_LABEL[group])}
                    </label>
                  );
                })}
              </fieldset>

              <label className="flex min-h-11 items-center gap-2 text-small">
                <input
                  type="checkbox"
                  aria-label={t("settings.issueTypes.activeNamed", {
                    name: type.name,
                  })}
                  checked={type.active}
                  disabled={busy}
                  onChange={(event) => {
                    void change.submit({
                      id: type.id,
                      values: {
                        name: type.name,
                        reporters: type.reporters,
                        active: event.target.checked,
                        sortOrder: type.sortOrder,
                      },
                    });
                  }}
                  className="size-4"
                />
                {t("settings.issueTypes.active")}
              </label>

              <label className="flex min-h-11 items-center gap-2 text-small">
                <input
                  type="checkbox"
                  aria-label={t("settings.issueTypes.ringFencedNamed", {
                    name: type.name,
                  })}
                  checked={type.ringFenced}
                  disabled={busy}
                  onChange={(event) => {
                    void fence.submit({
                      id: type.id,
                      ringFenced: event.target.checked,
                    });
                  }}
                  className="size-4"
                />
                {t("settings.issueTypes.ringFenced")}
              </label>

              <span className="ml-auto font-data text-data text-ink-muted">
                {t("settings.issueTypes.reportCount", {
                  count: type.reportCount,
                })}
              </span>

              {/* Offered only while nothing has been filed under it: the API
                  refuses the rest, and a button that always failed would be a
                  worse way to say so. */}
              {type.reportCount === 0 ? (
                <button
                  type="button"
                  aria-label={t("settings.issueTypes.removeNamed", {
                    name: type.name,
                  })}
                  disabled={busy}
                  onClick={() => {
                    void remove.submit(type.id);
                  }}
                  className={QUIET_BUTTON}
                >
                  {remove.state.kind === "saving"
                    ? t("settings.issueTypes.removing")
                    : t("settings.issueTypes.remove")}
                </button>
              ) : null}

              <TypeHandlingSettings
                type={type}
                choices={choices}
                busy={busy}
                onChange={(values) => {
                  void change.submit({
                    id: type.id,
                    values: { ...settingsOf(type), ...values },
                  });
                }}
              />

              <TypeStatuses
                type={type}
                busy={busy}
                adding={addStatus.state.kind === "saving"}
                onRename={(status, values) => {
                  void changeStatus.submit({
                    typeId: type.id,
                    statusId: status.id,
                    values,
                  });
                }}
                onAdd={(input) =>
                  addStatus.submit({ typeId: type.id, ...input })
                }
              />
            </li>
          ))}
        </ul>
      )}

      <LockedForm
        locked={add.state.kind === "saving"}
        focusFallback={nameRef}
        className="flex flex-col gap-4 border-t border-line pt-4"
        onSend={onSend}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("settings.issueTypes.name")}
            <input
              ref={nameRef}
              type="text"
              name="issueTypeName"
              required
              maxLength={ISSUE_TYPE_LIMITS.name}
              autoComplete="off"
              placeholder={t("settings.issueTypes.namePlaceholder")}
              value={draft.name}
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value });
              }}
              className={FIELD}
            />
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-label text-ink-muted uppercase">
              {t("settings.issueTypes.reporters")}
            </legend>
            <div className="flex flex-wrap gap-3">
              {ISSUE_REPORTER_GROUPS.map((group) => (
                <label
                  key={group}
                  className="flex min-h-11 items-center gap-2 text-small"
                >
                  <input
                    type="checkbox"
                    name="issueTypeReporters"
                    value={group}
                    checked={draft.reporters.includes(group)}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        reporters: toggled(
                          draft.reporters,
                          group,
                          event.target.checked,
                        ),
                      });
                    }}
                    className="size-4"
                  />
                  {t(ISSUE_REPORTER_GROUP_LABEL[group])}
                </label>
              ))}
            </div>
            {draft.reporters.length === 0 ? (
              <p className={HINT}>
                {t("settings.issueTypes.reportersRequired")}
              </p>
            ) : null}
          </fieldset>
        </div>

        <div>
          <button
            type="submit"
            disabled={
              draft.name.trim() === "" || draft.reporters.length === 0 || busy
            }
            className={PRIMARY_BUTTON}
          >
            {add.state.kind === "saving"
              ? t("settings.issueTypes.adding")
              : t("settings.issueTypes.add")}
          </button>
        </div>
      </LockedForm>
    </Panel>
  );
}

/**
 * Who handles a type's issues, the priority they are filed with, and who they
 * are given to by default (ADR 0054, decisions 11 to 13). Each saves on change,
 * as the reporter switches beside them do.
 *
 * The default assignee is chosen from the people who handle the type as it is
 * set: the board's own when the board alone handles it. Handing a type to the
 * board clears a default the board does not include, and unassigns that person
 * from the type's issues, which the hint says before the board does it.
 */
function TypeHandlingSettings({
  type,
  choices,
  busy,
  onChange,
}: {
  type: ConfiguredIssueType;
  choices: readonly IssueHandlerChoice[] | null;
  busy: boolean;
  onChange: (values: Partial<IssueTypeInput>) => void;
}): ReactElement {
  const { t } = useTranslation();
  const named = { name: type.name };
  const current =
    type.defaultAssignee === null || type.defaultAssignee.kind === "unknown"
      ? ""
      : type.defaultAssignee.personId;
  /*
   * The people who handle the type as it is set, with a purged one left out:
   * nobody can be chosen by a name the register no longer holds. The default
   * as it stands is offered even when the list no longer holds them, so the
   * select never shows another person than the one the type names.
   */
  const offered: { personId: string; name: string }[] = [];
  for (const choice of choices ?? []) {
    if (
      choice.handler.kind !== "unknown" &&
      (type.handledBy !== "BOARD" || choice.board)
    ) {
      offered.push({
        personId: choice.handler.personId,
        name: issueHandlerName(choice.handler, t),
      });
    }
  }
  const standing = type.defaultAssignee;
  if (
    standing !== null &&
    standing.kind !== "unknown" &&
    !offered.some((option) => option.personId === standing.personId)
  ) {
    offered.unshift({
      personId: standing.personId,
      name: issueHandlerName(standing, t),
    });
  }

  return (
    <div className="flex w-full flex-wrap items-end gap-4">
      <label className={`${LABEL} min-w-48`}>
        {t("settings.issueTypes.handledBy")}
        <select
          aria-label={t("settings.issueTypes.handledByNamed", named)}
          value={type.handledBy}
          disabled={busy}
          onChange={(event) => {
            onChange({ handledBy: event.target.value as IssueHandledBy });
          }}
          className={FIELD}
        >
          {ISSUE_HANDLED_BY.map((handledBy) => (
            <option key={handledBy} value={handledBy}>
              {t(ISSUE_HANDLED_BY_LABEL[handledBy])}
            </option>
          ))}
        </select>
      </label>

      <label className={`${LABEL} min-w-40`}>
        {t("settings.issueTypes.defaultPriority")}
        <select
          aria-label={t("settings.issueTypes.defaultPriorityNamed", named)}
          value={type.defaultPriority}
          disabled={busy}
          onChange={(event) => {
            onChange({
              defaultPriority: event.target.value as IssuePriority,
            });
          }}
          className={FIELD}
        >
          {ISSUE_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {t(ISSUE_PRIORITY_LABEL[priority])}
            </option>
          ))}
        </select>
      </label>

      <label className={`${LABEL} min-w-56`}>
        {t("settings.issueTypes.defaultAssignee")}
        <select
          aria-label={t("settings.issueTypes.defaultAssigneeNamed", named)}
          value={current}
          disabled={busy || choices === null}
          onChange={(event) => {
            onChange({
              defaultAssigneePersonId:
                event.target.value === "" ? null : event.target.value,
            });
          }}
          className={FIELD}
        >
          <option value="">{t("settings.issueTypes.noDefaultAssignee")}</option>
          {offered.map((option) => (
            <option key={option.personId} value={option.personId}>
              {option.name}
            </option>
          ))}
        </select>
      </label>

      <p className={`${HINT} w-full`}>
        {type.handledBy === "BOARD"
          ? t("settings.issueTypes.handledByBoardHint")
          : t("settings.issueTypes.handledByEveryHandlerHint")}
      </p>
    </div>
  );
}

/**
 * One type's statuses, by meaning, and the form that adds one.
 *
 * The default of a meaning is the status an issue enters when it moves into
 * that meaning without one being chosen, so its switch stays on and it stops
 * being the default only when another status takes its place.
 */
function TypeStatuses({
  type,
  busy,
  adding,
  onRename,
  onAdd,
}: {
  type: IssueTypeView;
  busy: boolean;
  adding: boolean;
  onRename: (
    status: IssueStatusView,
    values: {
      label: string;
      active?: boolean;
      isDefault?: true;
    },
  ) => void;
  onAdd: (input: {
    meaning: IssueStatusMeaning;
    label: string;
  }) => Promise<boolean>;
}): ReactElement {
  const { t } = useTranslation();
  const [meaning, setMeaning] = useState<IssueStatusMeaning>("IN_PROGRESS");
  const [label, setLabel] = useState("");

  return (
    <section
      aria-label={t("settings.issueTypes.statuses.title", { name: type.name })}
      className="flex w-full flex-col gap-3 border-t border-line pt-3"
    >
      <h4 className="text-label text-ink-muted uppercase">
        {t("settings.issueTypes.statuses.title", { name: type.name })}
      </h4>
      <p className={HINT}>{t("settings.issueTypes.statuses.hint")}</p>

      <ul className="flex flex-col gap-2">
        {type.statuses.map((status) => (
          <StatusRow
            // Remounted when the saved label changes, so the draft starts
            // from what the server holds after every write.
            key={`${status.id}:${status.label}`}
            status={status}
            busy={busy}
            onChange={(values) => {
              onRename(status, values);
            }}
          />
        ))}
      </ul>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = label.trim();
          if (trimmed === "") {
            return;
          }
          void onAdd({ meaning, label: trimmed }).then((saved) => {
            if (saved) {
              setLabel("");
            }
          });
        }}
      >
        <label className={`${LABEL} min-w-40`}>
          {t("settings.issueTypes.statuses.meaning")}
          <select
            aria-label={t("settings.issueTypes.statuses.meaningNamed", {
              name: type.name,
            })}
            value={meaning}
            disabled={busy}
            onChange={(event) => {
              setMeaning(event.target.value as IssueStatusMeaning);
            }}
            className={FIELD}
          >
            {ISSUE_STATUS_MEANINGS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(ISSUE_MEANING_LABEL[candidate])}
              </option>
            ))}
          </select>
        </label>
        <label className={`${LABEL} min-w-56 flex-1`}>
          {t("settings.issueTypes.statuses.newLabel")}
          <input
            type="text"
            aria-label={t("settings.issueTypes.statuses.newLabelNamed", {
              name: type.name,
            })}
            maxLength={ISSUE_STATUS_LIMITS.label}
            autoComplete="off"
            placeholder={t("settings.issueTypes.statuses.newLabelPlaceholder")}
            value={label}
            disabled={busy}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
            className={FIELD}
          />
        </label>
        <button
          type="submit"
          aria-label={t("settings.issueTypes.statuses.addNamed", {
            name: type.name,
          })}
          disabled={busy || label.trim() === ""}
          className={SECONDARY_BUTTON}
        >
          {adding
            ? t("settings.issueTypes.statuses.adding")
            : t("settings.issueTypes.statuses.add")}
        </button>
      </form>
    </section>
  );
}

/** One status: its meaning, its name, whether it is offered, its default. */
function StatusRow({
  status,
  busy,
  onChange,
}: {
  status: IssueStatusView;
  busy: boolean;
  onChange: (values: {
    label: string;
    active?: boolean;
    isDefault?: true;
  }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(status.label);
  const meaning = t(ISSUE_MEANING_LABEL[status.meaning]);
  const trimmed = draft.trim();
  const named = { status: status.label, meaning };

  return (
    <li className="flex flex-wrap items-center gap-3">
      <span className="min-w-28 text-small text-ink-muted">{meaning}</span>

      {/* A grid, so the name field keeps its width beside its button: the
          field fills its column, and a wrapping row would put the button
          under every name. */}
      <form
        className="grid grid-cols-[12rem_auto] items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "" || trimmed === status.label) {
            return;
          }
          onChange({ label: trimmed });
        }}
      >
        <input
          type="text"
          aria-label={t("settings.issueTypes.statuses.labelNamed", named)}
          required
          maxLength={ISSUE_STATUS_LIMITS.label}
          autoComplete="off"
          value={draft}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          className={FIELD}
        />
        <button
          type="submit"
          aria-label={t("settings.issueTypes.statuses.renameNamed", {
            status: status.label,
          })}
          disabled={busy || trimmed === "" || trimmed === status.label}
          className={QUIET_BUTTON}
        >
          {t("settings.issueTypes.statuses.rename")}
        </button>
      </form>

      <label className="flex min-h-11 items-center gap-2 text-small">
        <input
          type="checkbox"
          aria-label={t("settings.issueTypes.statuses.activeNamed", named)}
          checked={status.active}
          // The default of a meaning stays offered; the server refuses it too.
          disabled={busy || status.isDefault}
          onChange={(event) => {
            onChange({ label: status.label, active: event.target.checked });
          }}
          className="size-4"
        />
        {t("settings.issueTypes.statuses.active")}
      </label>

      {status.isDefault ? (
        <span className="rounded-control border border-line px-2 py-1 text-chip text-ink-muted uppercase">
          {t("settings.issueTypes.statuses.isDefault")}
        </span>
      ) : status.active ? (
        <button
          type="button"
          aria-label={t("settings.issueTypes.statuses.makeDefaultNamed", named)}
          disabled={busy}
          onClick={() => {
            onChange({ label: status.label, isDefault: true });
          }}
          className={QUIET_BUTTON}
        >
          {t("settings.issueTypes.statuses.makeDefault")}
        </button>
      ) : null}

      <span className="ml-auto font-data text-data text-ink-muted">
        {t("settings.issueTypes.statuses.issueCount", {
          count: status.issueCount,
        })}
      </span>
    </li>
  );
}
