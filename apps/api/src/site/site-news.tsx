import { type SiteNewsArticle, teaserOf } from "./site-news.service";
import {
  formatNewsDate,
  isoDate,
  NEWS_PATH,
  newsPath,
  renderBlock,
  renderDocument,
  type SiteChrome,
} from "./site-html";

/**
 * The association's news, as HTML.
 *
 * The same pure module the rest of the website is: handed everything it needs,
 * reading nothing. It renders through the one document shell in site-html, so
 * the header, the footer and the stylesheet a news article carries are the same
 * ones a page carries - a second shell would be a second thing to keep in step,
 * and the first time they disagreed the difference would show on the street.
 *
 * There is no refusal in this file. A news item somebody may not read is
 * answered by the caller with the website's own not-found document, byte for
 * byte the same one an address with nothing behind it gets, and that is the
 * only refusal the website has.
 */

/** The index: every news item this reader may see, newest first. */
export function renderNewsIndex(
  chrome: SiteChrome,
  items: readonly SiteNewsArticle[],
): string {
  const { t } = chrome;

  return renderDocument(
    chrome,
    t("news.site.indexTitle"),
    <>
      <h1 className="site-title">{t("news.site.indexTitle")}</h1>
      {items.length === 0 ? (
        <p>{t("news.site.empty")}</p>
      ) : (
        <ul className="site-news-list">
          {items.map((item) => (
            <li className="site-news-item" key={item.slug}>
              <p className="site-news-date">
                <time dateTime={isoDate(item.publishedAt)}>
                  {formatNewsDate(item.publishedAt, chrome.locale)}
                </time>
              </p>
              <h2>
                <a href={newsPath(item.slug)}>{item.title}</a>
              </h2>
              {/*
               * The opening of the body as plain text, exactly as a teaser
               * block on a page shows it. Rendering the first stored block
               * instead would put a heading in the middle of a list of
               * headings on any item that starts with one.
               */}
              <p>{teaserOf(item.content)}</p>
            </li>
          ))}
        </ul>
      )}
    </>,
  );
}

/** One news item, in full. */
export function renderNewsArticle(
  chrome: SiteChrome,
  article: SiteNewsArticle,
): string {
  return renderDocument(
    chrome,
    article.title,
    <>
      <h1 className="site-title">{article.title}</h1>
      <p className="site-article-date">
        <time dateTime={isoDate(article.publishedAt)}>
          {formatNewsDate(article.publishedAt, chrome.locale)}
        </time>
      </p>
      {/*
       * No form state: a news item's body is prose, and the page renderer is
       * the one place a form on the association's website is rendered.
       */}
      {article.content.blocks.map((block, index) =>
        renderBlock(chrome, block, index, null),
      )}
      <p>
        <a href={NEWS_PATH}>{chrome.t("news.site.allNews")}</a>
      </p>
    </>,
  );
}
