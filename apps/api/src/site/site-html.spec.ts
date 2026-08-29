import { beforeAll, describe, expect, it } from "vitest";

import { I18nService } from "../i18n/i18n.service";
import type { PageBlock } from "./page-content";
import type { SitePage } from "./pages.service";
import { renderNotFound, renderPage, type SiteChrome } from "./site-html";

/**
 * What the association's website may and may not contain.
 *
 * These are the assertions that make three claims in the module's own doc
 * comment checkable rather than aspirational: no script, no third-party
 * address, and a not-found page that is the same document however a visitor
 * arrived at it. Each of the three is a promise made to people who read a
 * housing cooperative's website without having any account with it.
 */

const i18n = new I18nService();
let chrome: SiteChrome;

beforeAll(async () => {
  await i18n.init();
  chrome = {
    t: i18n.translatorFor("sv"),
    locale: "sv",
    associationName: "Brf Talgoxen",
    logoUrl: null,
    css: ":root { --obrf-surface-page: #EFEDE7; }",
    mediaUrl: (mediaFileId) => `/api/media/${mediaFileId}`,
    privacyNoticePath: null,
  };
});

function page(blocks: PageBlock[]): SitePage {
  return {
    slug: "hem",
    title: "Välkommen",
    content: { version: 1, blocks },
  };
}

const PAGE = page([
  { type: "paragraph", runs: [{ text: "Föreningen bildades 1948." }] },
  { type: "paragraph", runs: [{ text: "Styrelsen nås på styrelsen@." }] },
]);

describe("a rendered page", () => {
  it("is a whole document in the visitor's language", () => {
    const html = renderPage(chrome, PAGE);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="sv">');
    expect(html).toContain("<title>Välkommen - Brf Talgoxen</title>");
    expect(html).toContain("Brf Talgoxen");
  });

  it("renders each paragraph the board wrote", () => {
    const html = renderPage(chrome, PAGE);

    expect(html).toContain("<p>Föreningen bildades 1948.</p>");
    expect(html).toContain("<p>Styrelsen nås på styrelsen@.</p>");
  });

  it("carries no script of any kind", () => {
    const html = renderPage(chrome, PAGE);

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    // An inline handler is a script even without the element.
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it("carries no address off this instance", () => {
    const html = renderPage(
      chrome,
      page([
        { type: "paragraph", runs: [{ text: "Se https://example.invalid" }] },
      ]),
    );

    // The visitor's browser fetches nothing from anywhere else. A URL the board
    // typed into a paragraph is text on the page, not a request the browser
    // makes.
    expect(/(?:src|href)="https?:/i.test(html)).toBe(false);
    expect(html).toContain("Se https://example.invalid");
  });

  it("fetches nothing from another host even when a link points at one", () => {
    const html = renderPage(
      chrome,
      page([
        {
          type: "paragraph",
          runs: [
            { text: "Se " },
            { text: "Boverket", link: "https://boverket.invalid" },
          ],
        },
      ]),
    );

    /*
     * A link is the one external reference a page may carry: nothing is
     * fetched from the other host while the page is read, and following it is
     * the visitor's own act. What must not appear is a subresource - an image,
     * a stylesheet, a font - pointing anywhere but this instance.
     */
    expect(/src="https?:/i.test(html)).toBe(false);
    expect(html).toContain(
      '<a href="https://boverket.invalid" rel="noopener noreferrer">Boverket</a>',
    );
  });

  it("marks the runs a paragraph is written in", () => {
    const html = renderPage(
      chrome,
      page([
        {
          type: "paragraph",
          runs: [
            { text: "Stämman " },
            { text: "hålls i maj", bold: true },
            { text: " varje år", italic: true },
          ],
        },
      ]),
    );

    expect(html).toContain(
      "<p>Stämman <strong>hålls i maj</strong><em> varje år</em></p>",
    );
  });

  it("keeps a page's own headings below its title", () => {
    const html = renderPage(
      chrome,
      page([
        { type: "heading", level: 2, runs: [{ text: "Styrelsen" }] },
        { type: "heading", level: 3, runs: [{ text: "Sammanträden" }] },
      ]),
    );

    // One h1 on the page, and it is the title. A heading the board writes is
    // always below it, so the document keeps a single outline.
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("<h2>Styrelsen</h2>");
    expect(html).toContain("<h3>Sammanträden</h3>");
  });

  it("serves a picture from this instance's own media route", () => {
    const html = renderPage(
      chrome,
      page([
        {
          type: "image",
          mediaFileId: "file-7",
          alt: "Gården sedd från porten",
          caption: "Gården, våren 2026",
        },
      ]),
    );

    expect(html).toContain(
      '<img src="/api/media/file-7" alt="Gården sedd från porten"/>',
    );
    expect(html).toContain("<figcaption>Gården, våren 2026</figcaption>");
  });

  it("links the privacy notice when the association has published one", () => {
    expect(renderPage(chrome, PAGE)).not.toContain("Integritetspolicy");

    const html = renderPage(
      { ...chrome, privacyNoticePath: "/integritetspolicy" },
      PAGE,
    );

    expect(html).toContain(
      '<a href="/integritetspolicy">Integritetspolicy</a>',
    );
  });

  it("shows markup a page's text contains rather than acting on it", () => {
    const html = renderPage(chrome, {
      ...page([
        {
          type: "paragraph",
          runs: [{ text: "<script>fetch('https://tracker.invalid')</script>" }],
        },
      ]),
      title: '<img src=x onerror="steal()">',
    });

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the association's mark from this instance's own media route", () => {
    const html = renderPage({ ...chrome, logoUrl: "/api/media/file-1" }, PAGE);

    expect(html).toContain('src="/api/media/file-1"');
  });

  it("offers the way in to the application", () => {
    const html = renderPage(chrome, PAGE);

    expect(html).toContain('href="/app"');
    expect(html).toContain("Logga in");
  });

  it("puts the stylesheet in unescaped", () => {
    // React escapes a text child, and an escaped quotation mark inside a
    // selector would silently break the whole theme.
    const html = renderPage(
      { ...chrome, css: ':root[data-theme="dark"] { color: red; }' },
      PAGE,
    );

    expect(html).toContain(':root[data-theme="dark"] { color: red; }');
  });
});

describe("the not-found page", () => {
  it("is the same document every time it is asked for", () => {
    // This is the whole of the member-only guarantee. A page a visitor may not
    // read is answered with exactly this, so it must not vary with anything the
    // request carried.
    expect(renderNotFound(chrome)).toBe(renderNotFound(chrome));
  });

  it("says what happened in the visitor's language", () => {
    expect(renderNotFound(chrome)).toContain("Sidan finns inte");
    expect(
      renderNotFound({ ...chrome, t: i18n.translatorFor("en"), locale: "en" }),
    ).toContain("The page does not exist");
  });

  it("carries no script either", () => {
    expect(renderNotFound(chrome)).not.toContain("<script");
  });
});
