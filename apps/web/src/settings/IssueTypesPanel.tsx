import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
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
  const [types, setTypes] = useState<readonly IssueTypeView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState(EMPTY);

  const read = useCallback(async (): Promise<void> => {
    const result = await fetchIssueTypes();
    if (result.ok) {
      setTypes(result.value);
      setLoadFailed(false);
      return;
    }
    setLoadFailed(true);
  }, []);

  useEffect(() => {
    // The effect owns its own call and drops a response that arrives after the
    // panel is gone, rather than applying it to a component nobody is looking
    // at. Later reads go through `read`, which the writes below call.
    let active = true;
    void fetchIssueTypes().then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        setTypes(result.value);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const add = useSaveAction(createIssueType, () => {
    setDraft(EMPTY);
    void read();
  });
  const change = useSaveAction(updateIssueType, () => {
    void read();
  });
  const remove = useSaveAction(removeIssueType, () => {
    void read();
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
      {types === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("settings.issueTypes.loading")}
        </p>
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
