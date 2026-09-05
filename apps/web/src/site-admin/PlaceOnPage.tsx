import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { AdminPage, PageBlock } from "../api/site";
import { fetchPages, savePage } from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, LABEL, SECONDARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";

/**
 * Putting a feature's own block on one of the association's pages.
 *
 * The page editor offers the blocks that need no feature behind them - prose, a
 * picture, the calendar, the lists it can read out of the instance. The three
 * that do are offered here instead, from the screen that owns what they show:
 * the news teaser from the news editor, the contact form from the inbox it
 * fills, the report form from the setting that turns public reporting on. That
 * is the design the page editor's own block list states, and until now it was
 * only half built - the blocks rendered, and nothing could place one.
 *
 * Owning the block means owning what it says. A teaser has a count, and the
 * screen that knows what the association publishes is where somebody decides
 * how many of them a page should show; the two forms carry nothing but the
 * sentence above them, which the page editor can write once the block is there.
 *
 * The block is appended, and moving it is the page editor's work. Two screens
 * arranging one page is how a board ends up with a block it cannot find: this
 * one puts it at the end and says so, and the editor is where a page is
 * arranged.
 */

/** What a page save can refuse a placement with, in this screen's words. */
const REASONS: Readonly<Record<string, TranslationKey>> = {
  "photo-consent-required": "siteAdmin.place.errors.photoConsentRequired",
  "personal-identity-number": "siteAdmin.place.errors.blocked",
  "image-not-found": "siteAdmin.place.errors.blocked",
  "image-not-public": "siteAdmin.place.errors.blocked",
  "not-found": "siteAdmin.place.errors.pageGone",
  "page-changed": "siteAdmin.place.errors.pageChanged",
};

export interface PlaceOnPageProps {
  /** The block to append, built by the screen that owns it. */
  block: PageBlock;
  /** The heading this control carries on the owning screen. */
  titleKey: TranslationKey;
  /** One sentence saying what placing it does. */
  descriptionKey: TranslationKey;
  /** What the page already carrying this kind of block is called. */
  alreadyThereKey: TranslationKey;
}

export function PlaceOnPage({
  block,
  titleKey,
  descriptionKey,
  alreadyThereKey,
}: PlaceOnPageProps): ReactElement {
  const { t } = useTranslation();
  const [pages, setPages] = useState<AdminPage[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [reads, setReads] = useState(0);
  /*
   * True from a refused placement until the re-read lands. The button is off
   * for that whole span: while the old pages are still in state, a second press
   * would send the same superseded copy and be refused for the same reason -
   * which is the loop the sentence beside it promises is over.
   */
  const [refreshing, setRefreshing] = useState(false);
  const [pageId, setPageId] = useState("");
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<string | null>(null);
  const [failure, setFailure] = useState<TranslationKey | null>(null);

  useEffect(() => {
    let active = true;
    void fetchPages().then((result) => {
      if (!active) {
        return;
      }
      /*
       * A failed read is said as one. Answering it with an empty list would put
       * "there is no page to place this on yet" in front of a board whose site
       * has a dozen, and the sentence they would act on is the wrong one.
       */
      setReadFailed(!result.ok);
      setPages(result.ok ? result.value : []);
      setPageId(result.ok ? (result.value[0]?.id ?? "") : "");
      setRefreshing(false);
    });
    return () => {
      active = false;
    };
  }, [reads]);

  const chosen = pages?.find((page) => page.id === pageId) ?? null;
  const carries = (page: AdminPage): boolean =>
    page.content.blocks.some((one) => one.type === block.type);
  const alreadyThere = chosen === null ? false : carries(chosen);
  /*
   * Said once, rather than left for a board to discover by choosing each page
   * in turn. The pages stay in the list: a page that vanished from a picker is
   * a question nobody on this screen can answer, while a page that is there and
   * says why is an answer.
   */
  const everyPageCarriesIt =
    pages !== null && pages.length > 0 && pages.every(carries);

  const place = async (): Promise<void> => {
    if (chosen === null) {
      return;
    }
    setPlacing(true);
    setFailure(null);
    setPlaced(null);

    const result = await savePage(chosen.id, {
      slug: chosen.slug,
      title: chosen.title,
      content: { blocks: [...chosen.content.blocks, block] },
      /*
       * The copy this control read. A save carries the whole page, so without
       * this a placement would write its own copy over whatever the page editor
       * had saved in the meantime - the board's own prose, silently, from a
       * screen that is not the page editor.
       */
      expectedRevision: chosen.revision,
    });

    setPlacing(false);
    if (!result.ok) {
      setFailure(
        REASONS[result.failure.reason] ?? "siteAdmin.place.errors.unknown",
      );
      /*
       * Somebody wrote first, so this control is holding a page that no longer
       * exists in that shape. Read them again, or pressing the button a second
       * time would send the same superseded copy and be refused for the same
       * reason - and the sentence above says the page is read afresh.
       */
      if (result.failure.reason === "page-changed") {
        setRefreshing(true);
        setReads((count) => count + 1);
      }
      return;
    }
    /*
     * The page as saved, so choosing it again says the block is already there
     * rather than offering to add a second one.
     */
    setPages(
      (current) =>
        current?.map((page) =>
          page.id === result.value.id ? result.value : page,
        ) ?? null,
    );
    setPlaced(result.value.title);
  };

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-line bg-raised p-5">
      <h3 className="text-title text-ink">{t(titleKey)}</h3>
      <p className="text-small text-ink-muted">{t(descriptionKey)}</p>

      {readFailed ? (
        <LoadFailure
          messageKey="siteAdmin.place.loadFailed"
          onRetry={() => {
            setReads((count) => count + 1);
          }}
        />
      ) : null}

      {!readFailed && pages !== null && pages.length === 0 ? (
        <p className="text-small text-ink-muted">
          {t("siteAdmin.place.noPages")}
        </p>
      ) : null}

      {readFailed || pages === null || pages.length === 0 ? null : (
        <>
          <label className={LABEL} htmlFor={`place-${block.type}`}>
            {t("siteAdmin.place.page")}
            <select
              id={`place-${block.type}`}
              value={pageId}
              onChange={(event) => {
                setPageId(event.target.value);
                setPlaced(null);
                setFailure(null);
              }}
              className={FIELD}
            >
              {pages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.title}
                </option>
              ))}
            </select>
          </label>

          {everyPageCarriesIt ? (
            <p className="text-small text-ink-muted">
              {t("siteAdmin.place.everyPage")}
            </p>
          ) : alreadyThere ? (
            <p className="text-small text-ink-muted">{t(alreadyThereKey)}</p>
          ) : null}

          <div>
            <button
              type="button"
              onClick={() => {
                void place();
              }}
              disabled={placing || refreshing || alreadyThere}
              className={SECONDARY_BUTTON}
            >
              {t(
                placing ? "siteAdmin.place.working" : "siteAdmin.place.submit",
              )}
            </button>
          </div>
        </>
      )}

      {failure === null ? null : (
        <Notice tone="danger" live>
          {t(failure)}
        </Notice>
      )}

      {placed === null ? null : (
        <Notice tone="ok" live>
          {t("siteAdmin.place.done", { page: placed })}
        </Notice>
      )}
    </section>
  );
}
