import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { AdminPage, PageBlock } from "../api/site";
import { fetchPages, savePage } from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, LABEL, SECONDARY_BUTTON } from "../ui/controls";
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
      setPages(result.ok ? result.value : []);
      setPageId(result.ok ? (result.value[0]?.id ?? "") : "");
    });
    return () => {
      active = false;
    };
  }, []);

  const chosen = pages?.find((page) => page.id === pageId) ?? null;
  const alreadyThere =
    chosen?.content.blocks.some((one) => one.type === block.type) ?? false;

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
    });

    setPlacing(false);
    if (!result.ok) {
      setFailure(
        REASONS[result.failure.reason] ?? "siteAdmin.place.errors.unknown",
      );
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

      {pages !== null && pages.length === 0 ? (
        <p className="text-small text-ink-muted">
          {t("siteAdmin.place.noPages")}
        </p>
      ) : null}

      {pages === null || pages.length === 0 ? null : (
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

          {alreadyThere ? (
            <p className="text-small text-ink-muted">{t(alreadyThereKey)}</p>
          ) : null}

          <div>
            <button
              type="button"
              onClick={() => {
                void place();
              }}
              disabled={placing || alreadyThere}
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
