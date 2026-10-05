import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
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
import { LoadFailure } from "../ui/LoadFailure";
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
  type NewsRecipients,
} from "./news-api";
import { NewsItemPanel } from "./NewsItemPanel";
import { PlaceOnPage } from "./PlaceOnPage";

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
  "news-changed": "news.errors.newsChanged",
};

/** What the compose panel is holding. Empty ids mean a new item. */
interface Draft {
  id: string | null;
  /** The revision of the copy being edited, which the save is claimed on. */
  revision: number | null;
  slug: string;
  title: string;
  body: string;
}

/**
 * Where the read after a refused save stands.
 *
 * `reading` and `readFailed` hold the save button off: the draft still carries
 * the revision that was refused, so a second press would be refused for the
 * same reason. `gone` is an item somebody else removed, which the draft is no
 * longer attached to.
 */
type CatchUp = "reading" | "readFailed" | "gone" | null;

const EMPTY: Draft = {
  id: null,
  revision: null,
  slug: "",
  title: "",
  body: "",
};

export interface NewsScreenProps {
  viewer: Viewer;
}

/**
 * A count the block schema will accept.
 *
 * A number input answers with a string, and with an empty one while somebody is
 * typing. Clamped rather than validated on submit, so the field never holds a
 * figure the server would refuse and the board never presses a button that
 * cannot work.
 */
function clampTeaserCount(value: string): number {
  const asked = Math.trunc(Number(value));
  if (!Number.isFinite(asked)) {
    return 1;
  }
  return Math.min(Math.max(asked, 1), PAGE_CONTENT_LIMITS.teaserCount);
}

export function NewsScreen({ viewer }: NewsScreenProps): ReactElement {
  const { t } = useTranslation();
  const formId = useId();
  const canManage = viewer.capabilities.includes("site:manage");

  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [recipients, setRecipients] = useState<NewsRecipients | null>(null);
  const [failed, setFailed] = useState(false);
  /* An item holding marks this editor cannot spell. See isPlainText. */
  const [notEditable, setNotEditable] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  /*
   * How many items a teaser placed from here shows. It belongs to this screen
   * rather than to the page editor for the reason the block is placed here at
   * all: the count is a decision about what the association publishes, which is
   * what this screen is for.
   */
  const [teaserCount, setTeaserCount] = useState(3);
  const [catchUp, setCatchUp] = useState<CatchUp>(null);
  /*
   * Bumped by anything that moves the editor on - another item, a cancel, a
   * new read - so a read for the item that was open before cannot land on the
   * one that is open now. Edit and Cancel are held while a save runs, so the
   * refusal of that save always arrives at the item it was made for.
   */
  const catchUpRead = useRef(0);

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
        setRecipients(count.value);
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

  /*
   * Somebody else saved or removed the item while it was open here. Read the
   * list again, so their version is on the screen, and move the revision the
   * draft holds while leaving what the board has written where it is - as the
   * page editor does. The next save then writes over their version, which the
   * message says; refusing until a reload would lose the board's unsaved text
   * to protect a version it has not seen.
   *
   * An item that is no longer in the list was removed, and the draft is
   * detached from it rather than thrown away: what was typed stays, and saving
   * it makes a new draft. A read that fails says so and offers to read again,
   * rather than claiming the list shows a version it does not.
   */
  const readAfterRefusal = async (id: string): Promise<void> => {
    catchUpRead.current += 1;
    const read = catchUpRead.current;
    setCatchUp("reading");
    const list = await fetchNews();
    if (read !== catchUpRead.current) {
      return;
    }
    if (!list.ok) {
      setCatchUp("readFailed");
      return;
    }
    setItems(list.value);
    const fresh = list.value.find((one) => one.id === id);
    setDraft((current) =>
      current.id !== id
        ? current
        : fresh === undefined
          ? { ...current, id: null, revision: null }
          : { ...current, revision: fresh.revision },
    );
    setCatchUp(fresh === undefined ? "gone" : null);
  };

  /** Moves the editor on, dropping whatever a refused save left behind. */
  const leaveRefusal = (): void => {
    catchUpRead.current += 1;
    setCatchUp(null);
    save.reset();
  };

  const save = useSaveAction(
    async (current: Draft) => {
      const fields = {
        slug: current.slug.trim(),
        title: current.title.trim(),
        content: contentFromText(current.body),
      };
      return current.id === null
        ? createNews(fields)
        : editNews(current.id, {
            ...fields,
            ...(current.revision === null
              ? {}
              : { expectedRevision: current.revision }),
          });
    },
    () => {
      setDraft(EMPTY);
      reload();
    },
    (failure) => {
      if (
        draft.id !== null &&
        (failure.reason === "news-changed" || failure.reason === "not-found")
      ) {
        void readAfterRefusal(draft.id);
      }
    },
  );

  const saveFailure = (): TranslationKey | null => {
    if (catchUp === "gone") {
      return "news.errors.removedWhileOpen";
    }
    if (save.state.kind !== "failed") {
      return null;
    }
    if (catchUp === "reading") {
      if (save.state.failure.reason === "news-changed") {
        return "news.errors.newsChangedReading";
      }
      if (save.state.failure.reason === "not-found") {
        return "news.errors.notFoundReading";
      }
    }
    return failureMessageKey(
      save.state.failure,
      SAVE_FAILURES,
      "news.errors.unknown",
    );
  };
  const failureKey = saveFailure();

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
              disabled={
                save.state.kind === "saving" ||
                catchUp === "reading" ||
                catchUp === "readFailed"
              }
              className={PRIMARY_BUTTON}
            >
              {save.state.kind === "saving"
                ? t("news.compose.working")
                : t("news.compose.submit")}
            </button>
            {draft.id === null ? null : (
              <button
                type="button"
                disabled={save.state.kind === "saving"}
                onClick={() => {
                  leaveRefusal();
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
            setCatchUp(null);
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

          {catchUp === "readFailed" ? (
            <LoadFailure
              messageKey="news.errors.readAfterRefusalFailed"
              onRetry={() => {
                if (draft.id !== null) {
                  void readAfterRefusal(draft.id);
                }
              }}
            />
          ) : failureKey !== null ? (
            <Notice tone="danger" live>
              {t(failureKey)}
            </Notice>
          ) : null}
        </form>
      </Panel>

      {canManage ? (
        <div className="flex flex-col gap-3">
          <label className={LABEL} htmlFor="news-teaser-count">
            {t("siteAdmin.place.newsTeaser.count")}
            {/*
              Bounded by the contract the server checks rather than by a number
              chosen here: the block schema takes an integer from one to
              PAGE_CONTENT_LIMITS.teaserCount, and a control that let a board
              ask for more would refuse the placement after they pressed the
              button rather than before.
            */}
            <input
              id="news-teaser-count"
              type="number"
              min={1}
              max={PAGE_CONTENT_LIMITS.teaserCount}
              step={1}
              value={teaserCount}
              onChange={(event) => {
                setTeaserCount(clampTeaserCount(event.target.value));
              }}
              className={FIELD_DATA}
            />
          </label>
          <PlaceOnPage
            block={{ type: "newsTeaser", count: teaserCount }}
            titleKey="siteAdmin.place.newsTeaser.title"
            descriptionKey="siteAdmin.place.newsTeaser.description"
            alreadyThereKey="siteAdmin.place.newsTeaser.alreadyThere"
          />
        </div>
      ) : null}

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
          recipients={recipients}
          editDisabled={save.state.kind === "saving"}
          onEdit={(chosen) => {
            leaveRefusal();
            if (!isPlainText(chosen.content)) {
              setNotEditable(true);
              return;
            }
            setNotEditable(false);
            setDraft({
              id: chosen.id,
              revision: chosen.revision,
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
