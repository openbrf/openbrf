import type { TFunction } from "i18next";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { APP_BASE_PATH } from "../http/app-base-path";
import type { PageBlock } from "./page-content";
import type { SitePage } from "./pages.service";

/**
 * The association's public website, as HTML.
 *
 * A pure module in the shape the mail templates use: it is handed everything it
 * needs and reads nothing - no database, no request, no environment. That makes
 * what the website can possibly contain a question about this file's arguments
 * rather than about the whole application, and the arguments carry the
 * cooperative's own name, its own writing and a stylesheet.
 *
 * Three properties are not negotiable and each is asserted by a test:
 *
 *   No script. Not an inline one, not a src, not an event handler attribute.
 *   The site is readable with JavaScript switched off because that is the
 *   honest way to publish a housing cooperative's notice board, and because a
 *   page with no script cannot be made to do anything on a visitor's behalf.
 *
 *   No third-party address. Every URL on the page resolves to this instance:
 *   the stylesheet is inline, the fonts are ours, the logo is streamed from the
 *   media route. A visitor's IP address is disclosed to nobody by reading the
 *   page.
 *
 *   No personal data. This module is given a page and an association name;
 *   it imports nothing from the registers, the address book or the encryption
 *   layer, so there is no path by which a resident's details could reach it.
 */

export interface SiteChrome {
  t: TFunction;
  locale: string;
  associationName: string;
  /** Same-origin media URL for the association's logo, or null. */
  logoUrl: string | null;
  /** The whole stylesheet, inlined into the document. */
  css: string;
}

const DOCTYPE = "<!doctype html>";

/** One page, rendered. */
export function renderPage(chrome: SiteChrome, page: SitePage): string {
  return document(
    chrome,
    page.title,
    <>
      <h1 className="site-title">{page.title}</h1>
      {page.content.blocks.map((block, index) => renderBlock(block, index))}
    </>,
  );
}

/**
 * The page a visitor gets for an address that has nothing behind it.
 *
 * Deterministic for a given locale, and that is the point rather than a
 * convenience: a member-only page is answered with exactly this, byte for byte,
 * so an anonymous visitor cannot tell an address that is closed to them from
 * one that was never written. The two must not diverge, which is why there is
 * one function and not two.
 */
export function renderNotFound(chrome: SiteChrome): string {
  return document(
    chrome,
    chrome.t("site.notFound.title"),
    <>
      <h1 className="site-title">{chrome.t("site.notFound.title")}</h1>
      <p>{chrome.t("site.notFound.body")}</p>
    </>,
  );
}

/**
 * A block becomes markup here, or it becomes nothing.
 *
 * The switch is exhaustive over the types this renderer knows, and an unknown
 * one returns null. That is what keeps a body written by a later editor from
 * reaching a browser through an older renderer: the page shows less, never
 * something this version cannot vouch for. The text is a React child, so React
 * escapes it - a paragraph containing markup is shown as the characters the
 * board typed.
 */
function renderBlock(block: PageBlock, index: number): ReactElement | null {
  switch (block.type) {
    case "paragraph":
      return <p key={index}>{block.text}</p>;
    default:
      return null;
  }
}

function document(
  chrome: SiteChrome,
  title: string,
  main: ReactElement,
): string {
  const { t, locale, associationName, logoUrl, css } = chrome;

  const markup = renderToStaticMarkup(
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} - ${associationName}`}</title>
        {/*
         * Raw rather than a text child: React escapes text, and an escaped
         * quotation mark inside a selector would silently break the theme. The
         * stylesheet has had every "<" removed before it reaches here, so it
         * cannot close this element or open another.
         */}
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <div className="site">
          <header className="site-header">
            {logoUrl === null ? null : (
              <img className="site-logo" src={logoUrl} alt="" />
            )}
            <p className="site-name">{associationName}</p>
          </header>
          <main className="site-main">{main}</main>
          <footer className="site-footer">
            <a href={APP_BASE_PATH}>{t("site.signIn")}</a>
          </footer>
        </div>
      </body>
    </html>,
  );

  return `${DOCTYPE}${markup}`;
}
