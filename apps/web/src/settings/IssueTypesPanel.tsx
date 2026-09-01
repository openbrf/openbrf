import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  createIssueType,
  fetchIssueTypes,
  ISSUE_AUDIENCES,
  type IssueAudience,
  type IssueTypeView,
  removeIssueType,
  updateIssueType,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, LABEL, PRIMARY_BUTTON, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

const AUDIENCE_LABEL: Readonly<Record<IssueAudience, TranslationKey>> = {
  NON_MEMBER: "issues.audience.NON_MEMBER",
  MEMBER: "issues.audience.MEMBER",
  BOARD: "issues.audience.BOARD",
};

const TYPE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "type-in-use": "settings.issueTypes.errors.typeInUse",
  "type-not-found": "settings.issueTypes.errors.typeNotFound",
  "invalid-body": "settings.issueTypes.errors.unknown",
};

const EMPTY = { name: "", audience: "MEMBER" as IssueAudience };

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
   * What the board can be reported, or null while no read has answered at all.
   *
   * Kept through a read that fails: the rows below are what the board acts on,
   * and a refresh that did not land is no reason to take the catalogue off the
   * screen. There is one catalogue, so the last answer about it is the best
   * there is, whichever read produced it.
   */
  readonly types: readonly IssueTypeView[] | null;
  readonly failed: boolean;
}

/**
 * The board's catalogue of issue types.
 *
 * The audience is on the row rather than hidden in a submenu, because it is the
 * only thing on this screen that decides who is shown what: a type set to
 * non-member appears on a form anyone can reach, and one set to board is the
 * association's own note to itself. A board member changing a name should not
 * be able to move a category between those two without seeing it happen.
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

  const failure =
    add.state.kind === "failed"
      ? add.state.failure
      : change.state.kind === "failed"
        ? change.state.failure
        : remove.state.kind === "failed"
          ? remove.state.failure
          : null;

  const busy =
    add.state.kind === "saving" ||
    change.state.kind === "saving" ||
    remove.state.kind === "saving";

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void add.submit({
      name: draft.name.trim(),
      audience: draft.audience,
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
            {t(
              failureMessageKey(
                failure,
                TYPE_FAILURES,
                "settings.issueTypes.errors.unknown",
              ),
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

              <label className={`${LABEL} min-w-40`}>
                {t("settings.issueTypes.audience")}
                <select
                  value={type.audience}
                  disabled={busy}
                  onChange={(event) => {
                    void change.submit({
                      id: type.id,
                      values: {
                        name: type.name,
                        audience: event.target.value as IssueAudience,
                        active: type.active,
                        sortOrder: type.sortOrder,
                      },
                    });
                  }}
                  className={FIELD}
                >
                  {ISSUE_AUDIENCES.map((audience) => (
                    <option key={audience} value={audience}>
                      {t(AUDIENCE_LABEL[audience])}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex min-h-11 items-center gap-2 text-small">
                <input
                  type="checkbox"
                  checked={type.active}
                  disabled={busy}
                  onChange={(event) => {
                    void change.submit({
                      id: type.id,
                      values: {
                        name: type.name,
                        audience: type.audience,
                        active: event.target.checked,
                        sortOrder: type.sortOrder,
                      },
                    });
                  }}
                  className="size-4"
                />
                {t("settings.issueTypes.active")}
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
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-4 border-t border-line pt-4"
        onSubmit={onSubmit}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("settings.issueTypes.name")}
            <input
              type="text"
              name="issueTypeName"
              autoComplete="off"
              placeholder={t("settings.issueTypes.namePlaceholder")}
              value={draft.name}
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value });
              }}
              className={FIELD}
            />
          </label>

          <label className={LABEL}>
            {t("settings.issueTypes.audience")}
            <select
              name="issueTypeAudience"
              value={draft.audience}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  audience: event.target.value as IssueAudience,
                });
              }}
              className={FIELD}
            >
              {ISSUE_AUDIENCES.map((audience) => (
                <option key={audience} value={audience}>
                  {t(AUDIENCE_LABEL[audience])}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <button
            type="submit"
            disabled={draft.name.trim() === "" || busy}
            className={PRIMARY_BUTTON}
          >
            {add.state.kind === "saving"
              ? t("settings.issueTypes.adding")
              : t("settings.issueTypes.add")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
