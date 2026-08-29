import {
  useCallback,
  useEffect,
  useId,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { contentFromText, isPlainText, textFromContent } from "./news-body";
import {
  createNews,
  editNews,
  fetchNews,
  fetchRecipientCount,
  type NewsItem,
} from "./news-api";
import { NewsItemPanel } from "./NewsItemPanel";

/**
 * The board's screen for the association's news.
 *
 * Writing and publishing are two separate acts on this screen, as they are in
 * the API: the panel at the top saves a draft that nobody can read, and each
 * item below carries the decision to put it on the website, say who it is for,
 * and mail the members. Keeping them apart is what makes the mailing a
 * deliberate answer rather than a side effect of pressing save.
 *
 * The body is plain text, and the mapping to the stored blocks lives in
 * news-body so it can be read on its own. What the board types is never stored
 * as markup: the block list is what lets the renderer, rather than whoever
 * typed the text, decide what reaches a browser.
 */

const SAVE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "invalid-slug": "news.errors.invalidSlug",
  "slug-taken": "news.errors.slugTaken",
  "personal-identity-number": "news.errors.personalIdentityNumber",
  "unsupported-block": "news.errors.unsupportedBlock",
  "address-mailed": "news.errors.addressMailed",
  "not-found": "news.errors.notFound",
};

/** What the compose panel is holding. Empty ids mean a new item. */
interface Draft {
  id: string | null;
  slug: string;
  title: string;
  body: string;
}

const EMPTY: Draft = { id: null, slug: "", title: "", body: "" };

export interface NewsScreenProps {
  viewer: Viewer;
}

export function NewsScreen({ viewer }: NewsScreenProps): ReactElement {
  const { t } = useTranslation();
  const formId = useId();
  const canManage = viewer.capabilities.includes("site:manage");

  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [recipients, setRecipients] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  /* An item holding marks this editor cannot spell. See isPlainText. */
  const [notEditable, setNotEditable] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  useEffect(() => {
    if (!canManage) {
      return;
    }
    let cancelled = false;

    void (async () => {
      const [list, count] = await Promise.all([
        fetchNews(),
        fetchRecipientCount(),
      ]);
      if (cancelled) {
        return;
      }
      // Either half failing is worth saying so. The count is what the mailing
      // toggle is read against, and a board that is not told it is missing
      // would read its absence as nobody to mail.
      setFailed(!list.ok || !count.ok);
      if (list.ok) {
        setItems(list.value);
      }
      if (count.ok) {
        setRecipients(count.value.count);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canManage, reloadToken]);

  /*
   * A change reloads rather than patching the list in place. Publishing moves
   * an item's state, claims a mailing and starts a delivery report, and the
   * server's own answer to all three is the only thing that gets them right.
   */
  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const save = useSaveAction(
    async (current: Draft) => {
      const fields = {
        slug: current.slug.trim(),
        title: current.title.trim(),
        content: contentFromText(current.body),
      };
      return current.id === null
        ? createNews(fields)
        : editNews(current.id, fields);
    },
    () => {
      setDraft(EMPTY);
      reload();
    },
  );

  if (!canManage) {
    return <Notice tone="warn">{t("settings.errors.forbidden")}</Notice>;
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-display">{t("news.heading")}</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          {t("news.description")}
        </p>
      </header>

      {failed ? (
        <Notice tone="danger" live>
          {t("news.errors.loadFailed")}
        </Notice>
      ) : null}

      {notEditable ? (
        <Notice tone="danger" live>
          {t("news.errors.notPlainText")}
        </Notice>
      ) : null}

      <Panel
        title={
          draft.id === null
            ? t("news.compose.title")
            : t("news.compose.editTitle", { title: draft.title })
        }
        description={t("news.compose.description")}
        notice={
          <Notice tone="warn">{t("news.compose.sensitiveWarning")}</Notice>
        }
        actions={
          <>
            <button
              type="submit"
              form={formId}
              disabled={save.state.kind === "saving"}
              className={PRIMARY_BUTTON}
            >
              {save.state.kind === "saving"
                ? t("news.compose.working")
                : t("news.compose.submit")}
            </button>
            {draft.id === null ? null : (
              <button
                type="button"
                onClick={() => {
                  save.reset();
                  setDraft(EMPTY);
                }}
                className={SECONDARY_BUTTON}
              >
                {t("news.compose.cancel")}
              </button>
            )}
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save.submit(draft);
          }}
        >
          <label className={LABEL}>
            {t("news.compose.titleField")}
            <input
              type="text"
              value={draft.title}
              required
              maxLength={200}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }));
              }}
              className={FIELD}
            />
          </label>

          <label className={LABEL}>
            {t("news.compose.slugField")}
            <input
              type="text"
              value={draft.slug}
              required
              maxLength={80}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  slug: event.target.value,
                }));
              }}
              className={FIELD_DATA}
            />
            <span className={HINT}>{t("news.compose.slugHint")}</span>
          </label>

          <label className={LABEL}>
            {t("news.compose.bodyField")}
            <textarea
              value={draft.body}
              rows={10}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  body: event.target.value,
                }));
              }}
              className={FIELD}
            />
            <span className={HINT}>{t("news.compose.bodyHint")}</span>
          </label>

          {save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("news.compose.saved")}
            </Notice>
          ) : null}

          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  SAVE_FAILURES,
                  "news.errors.unknown",
                ),
              )}
            </Notice>
          ) : null}
        </form>
      </Panel>

      {items === null && !failed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("news.loading")}
        </p>
      ) : null}

      {items !== null && items.length === 0 ? (
        <p className="text-body text-ink-muted">{t("news.empty")}</p>
      ) : null}

      {(items ?? []).map((item) => (
        <NewsItemPanel
          key={item.id}
          item={item}
          recipientCount={recipients}
          onEdit={(chosen) => {
            save.reset();
            if (!isPlainText(chosen.content)) {
              setNotEditable(true);
              return;
            }
            setNotEditable(false);
            setDraft({
              id: chosen.id,
              slug: chosen.slug,
              title: chosen.title,
              body: textFromContent(chosen.content),
            });
          }}
          onChanged={reload}
        />
      ))}
    </div>
  );
}
